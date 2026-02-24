/**
 * Auto-Download Service
 * 
 * Automatically downloads missing content when a user tries to watch it.
 * The service uses search preferences and quality rules to find suitable torrents.
 */

import { Op } from 'sequelize';
import { MediaItem, Download, Setting } from '../models';
import { torrentSearchService, TorrentResult, SearchResponse } from './torrentSearch';
import { qbittorrentService } from './qbittorrent';
import { downloadManager } from './downloadManager';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';
import { 
  parseQuality, 
  calculateQualityScore, 
  shouldAvoidTorrent,
  getQualitySummary 
} from './torrentQuality';
import { episodeDetector } from './episodeDetector';

// Minimum seeders required for auto-download
const MIN_SEEDERS = 5;

export interface AutoDownloadResult {
  success: boolean;
  message: string;
  download?: Download;
  torrent?: TorrentResult;
  reusingTorrent?: boolean;
}

export class AutoDownloadService {
  /**
   * Check if an existing torrent contains the episode we want.
   * If found, update the torrent to also download this episode.
   * 
   * @param mediaItem - The TV episode we want to download
   * @returns The existing download if found and updated, null otherwise
   */
  private async findAndReuseExistingTorrent(mediaItem: MediaItem): Promise<Download | null> {
    if (mediaItem.type !== 'tv' || !mediaItem.season || !mediaItem.episode) {
      return null;
    }

    console.log(`[AutoDownload] Checking for existing torrents containing ${mediaItem.title} S${mediaItem.season}E${mediaItem.episode}`);

    // Find active downloads for the same TV show
    const activeDownloads = await Download.findAll({
      where: {
        status: ['pending', 'downloading', 'paused'],
      },
      include: [{
        model: MediaItem,
        as: 'mediaItem',
        where: {
          type: 'tv',
          title: mediaItem.title,
        },
      }],
    });

    for (const download of activeDownloads) {
      const detected = download.detectedEpisodes;
      if (!detected) continue;

      // Check if this torrent contains the episode we want
      let containsEpisode = false;

      if (detected.type === 'complete') {
        // Complete series - contains all episodes
        containsEpisode = true;
      } else if (detected.type === 'season') {
        // Season pack - check if it's the right season
        containsEpisode = detected.seasons.includes(mediaItem.season);
      } else if (detected.type === 'range' || detected.type === 'episode') {
        // Specific episodes - check if our episode is in the list
        containsEpisode = detected.episodes.some(
          ep => ep.season === mediaItem.season && ep.episode === mediaItem.episode
        );
      }

      if (containsEpisode) {
        console.log(`[AutoDownload] Found existing torrent that contains S${mediaItem.season}E${mediaItem.episode}: ${download.id}`);
        
        // Add this episode to the download's episode list if not already there
        const currentEpisodes = detected.episodes || [];
        const alreadyTracked = currentEpisodes.some(
          ep => ep.season === mediaItem.season && ep.episode === mediaItem.episode
        );

        if (!alreadyTracked) {
          // Add this episode to the list
          const updatedEpisodes = [...currentEpisodes, { season: mediaItem.season, episode: mediaItem.episode }];
          await download.update({
            detectedEpisodes: {
              ...detected,
              episodes: updatedEpisodes,
            },
          });
          console.log(`[AutoDownload] Added S${mediaItem.season}E${mediaItem.episode} to existing download's episode list`);
        }

        // Configure file priorities to also download this episode
        if (download.torrentHash) {
          const wantedEpisodes = [{ season: mediaItem.season, episode: mediaItem.episode }];
          
          // Get current files and their priorities
          const files = await qbittorrentService.getTorrentFiles(download.torrentHash);
          if (files.length > 0) {
            // Enable downloading of the new episode file(s)
            const selectedCount = await downloadManager.configureFilePrioritiesAdditive(
              download.torrentHash,
              wantedEpisodes
            );
            console.log(`[AutoDownload] Enabled download for ${selectedCount} additional file(s)`);
          }
        }

        // Create a link from this media item to the existing download
        // We don't create a new Download record - we just associate the media item
        // The download manager will handle moving all files when complete
        
        return download;
      }
    }

    console.log(`[AutoDownload] No existing torrent found for ${mediaItem.title} S${mediaItem.season}E${mediaItem.episode}`);
    return null;
  }

  /**
   * Attempt to auto-download missing content for a media item.
   * 
   * @param mediaItem - The media item to download
   * @returns Result of the auto-download attempt
   */
  async attemptAutoDownload(mediaItem: MediaItem): Promise<AutoDownloadResult> {
    try {
      // Check if already downloaded or downloading
      const existingDownload = await Download.findOne({
        where: { mediaItemId: mediaItem.id },
      });

      if (existingDownload) {
        if (existingDownload.status === 'downloading' || existingDownload.status === 'pending') {
          return {
            success: false,
            message: 'Download already in progress',
            download: existingDownload,
          };
        }
        if (existingDownload.status === 'completed' && mediaItem.filePath) {
          return {
            success: false,
            message: 'Content already downloaded',
            download: existingDownload,
          };
        }
      }

      // For TV episodes, check if there's an existing torrent that contains this episode
      if (mediaItem.type === 'tv') {
        const reusedDownload = await this.findAndReuseExistingTorrent(mediaItem);
        if (reusedDownload) {
          return {
            success: true,
            message: `Reusing existing torrent for S${mediaItem.season}E${mediaItem.episode}`,
            download: reusedDownload,
            reusingTorrent: true,
          };
        }
      }

      // Build search query based on media type
      const query = this.buildSearchQuery(mediaItem);
      console.log(`[AutoDownload] Searching for: ${query}`);

      // Search for torrents
      const category = mediaItem.type === 'movie' ? 'Movies' : 'TV';
      const searchResponse = await torrentSearchService.search(query, category);

      if (searchResponse.results.length === 0) {
        console.log(`[AutoDownload] No results found for: ${query}`);
        return {
          success: false,
          message: searchResponse.error || 'No torrents found matching criteria',
        };
      }

      // Get user preferences
      const prefs = await this.getSearchPreferences();

      // Find the best matching torrent
      const bestTorrent = this.selectBestTorrent(searchResponse.results, prefs);

      if (!bestTorrent) {
        console.log(`[AutoDownload] No suitable torrent found for: ${query}`);
        return {
          success: false,
          message: 'No suitable torrent found (quality/seeder requirements not met)',
        };
      }

      console.log(`[AutoDownload] Selected torrent: ${bestTorrent.name} (${bestTorrent.seeders} seeders)`);

      // Fetch magnet URI if not already available (deferred magnet loading)
      let magnetUri = bestTorrent.magnetUri;
      if (!magnetUri && bestTorrent.detailsUrl) {
        console.log(`[AutoDownload] Fetching magnet URI for: ${bestTorrent.name}`);
        const magnetResult = await torrentSearchService.getMagnetUri(bestTorrent.detailsUrl);
        magnetUri = magnetResult.magnetUri;
      }

      if (!magnetUri) {
        console.log(`[AutoDownload] Failed to get magnet URI for: ${bestTorrent.name}`);
        return {
          success: false,
          message: 'Failed to retrieve magnet link for selected torrent',
        };
      }

      // Create a copy with verified magnetUri for startDownload
      const torrentWithMagnet = { ...bestTorrent, magnetUri };

      // Start the download
      const download = await this.startDownload(mediaItem, torrentWithMagnet);

      if (download) {
        return {
          success: true,
          message: `Started download: ${bestTorrent.name}`,
          download,
          torrent: bestTorrent,
        };
      }

      return {
        success: false,
        message: 'Failed to start download',
      };
    } catch (error) {
      console.error('[AutoDownload] Error:', error);
      return {
        success: false,
        message: `Error: ${error}`,
      };
    }
  }

  /**
   * Build a search query for the media item.
   */
  private buildSearchQuery(mediaItem: MediaItem): string {
    if (mediaItem.type === 'movie') {
      return `${mediaItem.title} ${mediaItem.year || ''}`.trim();
    } else if (mediaItem.type === 'tv') {
      const season = String(mediaItem.season || 1).padStart(2, '0');
      const episode = String(mediaItem.episode || 1).padStart(2, '0');
      return `${mediaItem.title} S${season}E${episode}`;
    }
    return mediaItem.title;
  }

  /**
   * Get search preferences from settings.
   * Supports both legacy single-value and new multi-value array formats.
   */
  private async getSearchPreferences(): Promise<{
    preferredCodecs: string[];
    preferredResolutions: string[];
    preferredMovieGroups: string[];
  }> {
    // Try new array-based settings first, fall back to legacy single-value settings
    const codecsSetting = await Setting.findOne({ where: { key: 'preferredCodecs' } });
    const resolutionsSetting = await Setting.findOne({ where: { key: 'preferredResolutions' } });
    const groupsSetting = await Setting.findOne({ where: { key: 'preferredMovieGroups' } });

    // Legacy single-value settings as fallback
    const codecSetting = await Setting.findOne({ where: { key: 'preferredCodec' } });
    const resolutionSetting = await Setting.findOne({ where: { key: 'preferredResolution' } });
    const groupSetting = await Setting.findOne({ where: { key: 'preferredMovieGroup' } });

    // Parse JSON arrays or use legacy values
    const parseArraySetting = (arraySetting: any, legacySetting: any, defaults: string[]): string[] => {
      if (arraySetting?.value) {
        try {
          const parsed = JSON.parse(arraySetting.value);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch {
          // Invalid JSON, try as comma-separated string
          if (arraySetting.value.includes(',')) {
            return arraySetting.value.split(',').map((s: string) => s.trim()).filter(Boolean);
          }
        }
      }
      // Fall back to legacy single value
      if (legacySetting?.value) {
        return [legacySetting.value];
      }
      return defaults;
    };

    return {
      preferredCodecs: parseArraySetting(codecsSetting, codecSetting, config.defaults.preferredCodecs),
      preferredResolutions: parseArraySetting(resolutionsSetting, resolutionSetting, config.defaults.preferredResolutions),
      preferredMovieGroups: parseArraySetting(groupsSetting, groupSetting, config.defaults.preferredMovieGroups),
    };
  }

  /**
   * Select the best torrent from search results based on preferences and quality.
   * Uses the torrentQuality service for accurate quality parsing and scoring.
   * Supports multiple preferred values (arrays) for resolution, codec, and group.
   */
  private selectBestTorrent(
    results: TorrentResult[],
    prefs: { preferredCodecs: string[]; preferredResolutions: string[]; preferredMovieGroups: string[] }
  ): TorrentResult | null {
    // Parse quality info for each result if not already parsed
    const resultsWithQuality = results.map(r => ({
      ...r,
      quality: r.quality || parseQuality(r.name),
    }));

    // Filter out CAM/screener content using proper quality parsing
    let candidates = resultsWithQuality.filter(r => !shouldAvoidTorrent(r.quality!));

    if (candidates.length === 0) {
      console.log('[AutoDownload] All results were low quality (CAM/screener), using all results');
      candidates = resultsWithQuality;
    }

    // Filter by minimum seeders
    candidates = candidates.filter(r => r.seeders >= MIN_SEEDERS);

    if (candidates.length === 0) {
      console.log('[AutoDownload] No results with enough seeders');
      return null;
    }

    // Score each torrent using the quality scoring system with array preferences
    const scored = candidates.map(torrent => {
      const qualityScore = calculateQualityScore(torrent.quality!, {
        preferredResolutions: prefs.preferredResolutions,
        preferredCodecs: prefs.preferredCodecs,
        preferredGroups: prefs.preferredMovieGroups,
      });
      
      // Add seeder bonus (more seeders = higher score, up to a point)
      const seederBonus = Math.min(torrent.seeders, 100) * 2;
      
      const totalScore = qualityScore + seederBonus;
      
      return {
        torrent: { ...torrent, qualityScore: totalScore },
        score: totalScore,
      };
    });

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Log top candidates for debugging
    console.log('[AutoDownload] Top candidates:');
    scored.slice(0, 3).forEach((item, i) => {
      const summary = getQualitySummary(item.torrent.quality!);
      console.log(`  ${i + 1}. ${item.torrent.name}`);
      console.log(`     Quality: ${summary}, Seeders: ${item.torrent.seeders}, Score: ${item.score}`);
    });

    return scored[0]?.torrent || null;
  }

  /**
   * Start a download for the media item.
   * Configures file selection to only download what we need.
   */
  private async startDownload(
    mediaItem: MediaItem,
    torrent: TorrentResult & { magnetUri: string }
  ): Promise<Download | null> {
    try {
      // Update media item with magnet URI
      await mediaItem.update({ magnetUri: torrent.magnetUri });

      // Detect what episodes this torrent contains (for TV content)
      let detectedEpisodes = mediaItem.type === 'tv' 
        ? episodeDetector.detect(torrent.name)
        : undefined;

      // For TV content, ensure we have the specific episode in the episodes list
      // Auto-download is for a single episode, so we want just that one
      if (mediaItem.type === 'tv' && mediaItem.season && mediaItem.episode) {
        const wantedEpisodes = [{ season: mediaItem.season, episode: mediaItem.episode }];
        detectedEpisodes = {
          type: 'episode',
          isComplete: false,
          seasons: [mediaItem.season],
          episodes: wantedEpisodes, // Explicitly set the single episode we want
          description: `S${String(mediaItem.season).padStart(2, '0')}E${String(mediaItem.episode).padStart(2, '0')}`,
          cleanTitle: detectedEpisodes?.cleanTitle || mediaItem.title,
        };
      }

      // Build download reason
      let downloadReason: string;
      if (mediaItem.type === 'movie') {
        downloadReason = `Auto: ${mediaItem.title}${mediaItem.year ? ` (${mediaItem.year})` : ''}`;
      } else if (mediaItem.type === 'tv') {
        downloadReason = `Auto: ${mediaItem.title} S${String(mediaItem.season).padStart(2, '0')}E${String(mediaItem.episode).padStart(2, '0')}`;
      } else {
        downloadReason = `Auto: ${mediaItem.title}`;
      }

      // Create download record
      const download = await Download.create({
        id: uuidv4(),
        mediaItemId: mediaItem.id,
        magnetUri: torrent.magnetUri!,
        status: 'pending',
        downloadReason,
        detectedEpisodes: detectedEpisodes ? {
          type: detectedEpisodes.type,
          isComplete: detectedEpisodes.isComplete,
          seasons: detectedEpisodes.seasons,
          episodes: detectedEpisodes.episodes,
          description: detectedEpisodes.description,
        } : undefined,
      });

      // Add to QBittorrent
      const hash = await qbittorrentService.addTorrent(torrent.magnetUri);
      if (hash) {
        await download.update({ torrentHash: hash, status: 'downloading' });
        console.log(`[AutoDownload] Started download with hash: ${hash}`);

        // For TV content, configure file priorities to only download what we need
        if (mediaItem.type === 'tv' && mediaItem.season && mediaItem.episode) {
          const wantedEpisodes = [{ season: mediaItem.season, episode: mediaItem.episode }];
          console.log(`[AutoDownload] Configuring file priorities for: S${mediaItem.season}E${mediaItem.episode}`);
          const selectedCount = await downloadManager.configureFilePriorities(hash, wantedEpisodes);
          
          if (selectedCount === 0) {
            console.log(`[AutoDownload] Warning: No files selected for download. Torrent may need more time to load metadata.`);
            // Don't mark as failed - the downloadManager will retry via ensureFilePrioritiesConfigured
          } else {
            console.log(`[AutoDownload] Configured to download ${selectedCount} files for S${mediaItem.season}E${mediaItem.episode}`);
          }
        }

        return download;
      } else {
        await download.update({ status: 'failed', error: 'Failed to add torrent' });
        return null;
      }
    } catch (error) {
      console.error('[AutoDownload] Failed to start download:', error);
      return null;
    }
  }
}

export const autoDownloadService = new AutoDownloadService();
