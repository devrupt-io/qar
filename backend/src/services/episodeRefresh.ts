import { v4 as uuidv4 } from 'uuid';
import { TVShow, MediaItem, Setting } from '../models';
import { omdbService } from './omdb';
import { mediaService } from './media';

const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

class EpisodeRefreshService {
  private intervalId: NodeJS.Timeout | null = null;

  /**
   * Determine if a show has ended based on OMDB Year field.
   * "2009–" = ongoing, "2018–2025" = ended
   */
  static isShowEnded(yearStr: string): boolean {
    if (!yearStr) return false;
    const match = yearStr.match(/^(\d{4})–(\d{4})?$/);
    if (!match) return false;
    // Has end year = ended
    return !!match[2];
  }

  /**
   * Fill in gaps between OMDB-reported episodes for a season.
   * E.g., if OMDB reports E1, E7, E8, E9, create E2-E6 as placeholders.
   */
  async fillEpisodeGaps(
    showTitle: string,
    showYear: number | undefined,
    imdbId: string,
    posterUrl: string | undefined,
    plot: string | undefined,
    season: number,
    omdbEpisodes: { Episode: string; Title?: string }[]
  ): Promise<MediaItem[]> {
    if (!omdbEpisodes || omdbEpisodes.length === 0) return [];

    const episodeNums = omdbEpisodes.map(ep => parseInt(ep.Episode, 10)).filter(n => !isNaN(n));
    if (episodeNums.length === 0) return [];

    const maxEp = Math.max(...episodeNums);
    const existingSet = new Set(episodeNums);
    const created: MediaItem[] = [];

    for (let ep = 1; ep <= maxEp; ep++) {
      if (existingSet.has(ep)) continue;

      // Check if already exists in DB
      const existing = await MediaItem.findOne({
        where: { type: 'tv', title: showTitle, season, episode: ep },
      });
      if (existing) continue;

      const media = await MediaItem.create({
        id: uuidv4(),
        type: 'tv',
        title: showTitle,
        year: showYear,
        imdbId,
        posterUrl,
        plot,
        season,
        episode: ep,
      });

      await mediaService.createMediaFiles(media);
      created.push(media);
      console.log(`[EpisodeRefresh] Created gap episode: ${showTitle} S${season}E${ep}`);
    }

    return created;
  }

  /**
   * Refresh episodes for a single TV show.
   * Returns count of new episodes added.
   */
  async refreshShow(tvShow: TVShow): Promise<number> {
    if (!tvShow.imdbId) return 0;

    const showDetails = await omdbService.getDetails(tvShow.imdbId);
    if (!showDetails) return 0;

    const isEnded = EpisodeRefreshService.isShowEnded(showDetails.Year);
    const newTotalSeasons = parseInt(showDetails.totalSeasons || '1', 10);
    const posterUrl = showDetails.Poster !== 'N/A' ? showDetails.Poster : undefined;

    // Update show metadata
    await tvShow.update({
      ended: isEnded,
      totalSeasons: newTotalSeasons,
      lastChecked: new Date(),
      posterUrl: posterUrl || tvShow.posterUrl,
      plot: showDetails.Plot || tvShow.plot,
    });

    let addedCount = 0;

    // Check all seasons (including potentially new ones)
    for (let season = 1; season <= newTotalSeasons; season++) {
      const seasonDetails = await omdbService.getSeasonDetails(tvShow.imdbId, season);
      if (!seasonDetails || !seasonDetails.Episodes) continue;

      // Add any new episodes from OMDB
      for (const ep of seasonDetails.Episodes) {
        const episodeNum = parseInt(ep.Episode, 10);
        if (isNaN(episodeNum)) continue;

        const existing = await MediaItem.findOne({
          where: { type: 'tv', title: tvShow.title, season, episode: episodeNum },
        });

        if (!existing) {
          const media = await MediaItem.create({
            id: uuidv4(),
            type: 'tv',
            title: tvShow.title,
            year: tvShow.year,
            imdbId: tvShow.imdbId,
            posterUrl: tvShow.posterUrl,
            plot: tvShow.plot,
            season,
            episode: episodeNum,
          });
          await mediaService.createMediaFiles(media);
          addedCount++;
          console.log(`[EpisodeRefresh] Added new episode: ${tvShow.title} S${season}E${episodeNum}`);
        }
      }

      // Fill gaps in this season
      const gapEpisodes = await this.fillEpisodeGaps(
        tvShow.title,
        tvShow.year,
        tvShow.imdbId!,
        tvShow.posterUrl,
        tvShow.plot,
        season,
        seasonDetails.Episodes
      );
      addedCount += gapEpisodes.length;
    }

    return addedCount;
  }

  /**
   * Refresh all active (non-ended) TV shows.
   * Ended shows are only refreshed if never checked before.
   */
  async refreshAll(): Promise<{ checked: number; added: number; errors: string[] }> {
    const shows = await TVShow.findAll();
    let checked = 0;
    let totalAdded = 0;
    const errors: string[] = [];

    for (const show of shows) {
      // Skip ended shows that have been checked before
      if (show.ended && show.lastChecked) {
        console.log(`[EpisodeRefresh] Skipping ended show: ${show.title}`);
        continue;
      }

      try {
        console.log(`[EpisodeRefresh] Checking: ${show.title}`);
        const added = await this.refreshShow(show);
        checked++;
        totalAdded += added;
        if (added > 0) {
          console.log(`[EpisodeRefresh] Added ${added} episodes for ${show.title}`);
        }
      } catch (error) {
        const msg = `Failed to refresh ${show.title}: ${error}`;
        console.error(`[EpisodeRefresh] ${msg}`);
        errors.push(msg);
      }

      // Rate limit OMDB calls (pause between shows)
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`[EpisodeRefresh] Done. Checked ${checked} shows, added ${totalAdded} episodes.`);
    return { checked, added: totalAdded, errors };
  }

  /**
   * Start periodic episode refresh.
   */
  async start(): Promise<void> {
    // Run initial refresh 2 minutes after startup
    setTimeout(() => this.refreshAll().catch(err => 
      console.error('[EpisodeRefresh] Initial refresh failed:', err)
    ), 2 * 60 * 1000);

    // Then run periodically
    const intervalHours = await this.getRefreshInterval();
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    this.intervalId = setInterval(() => {
      this.refreshAll().catch(err => 
        console.error('[EpisodeRefresh] Periodic refresh failed:', err)
      );
    }, intervalMs);

    console.log(`[EpisodeRefresh] Started (interval: ${intervalHours}h)`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async getRefreshInterval(): Promise<number> {
    try {
      const setting = await Setting.findOne({ where: { key: 'episodeRefreshIntervalHours' } });
      if (setting && setting.value) {
        const hours = parseInt(setting.value, 10);
        if (hours >= 1) return hours;
      }
    } catch {}
    return DEFAULT_REFRESH_INTERVAL_HOURS;
  }
}

export const episodeRefreshService = new EpisodeRefreshService();
export { EpisodeRefreshService };
