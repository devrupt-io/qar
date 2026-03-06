import { Router } from 'express';
import { MediaItem, Download, TVShow } from '../models';
import { mediaService } from '../services/media';
import { qbittorrentService } from '../services/qbittorrent';
import { torrentSearchService } from '../services/torrentSearch';
import { omdbService } from '../services/omdb';
import { downloadManager } from '../services/downloadManager';
import { jellyfinService } from '../services/jellyfin';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// In-flight download locks to prevent duplicate downloads from concurrent requests
const downloadLocks = new Set<string>();
router.get('/tv/shows', async (req, res) => {
  try {
    const shows = await TVShow.findAll({
      order: [['createdAt', 'DESC']],
      include: [{ model: Download, as: 'downloads' }],
    });
    
    // For each show, get episode count
    const showsWithCounts = await Promise.all(shows.map(async (show) => {
      const episodeCount = await MediaItem.count({
        where: { type: 'tv', title: show.title },
      });
      return {
        ...show.toJSON(),
        episodeCount,
      };
    }));
    
    res.json({ shows: showsWithCounts });
  } catch (error) {
    console.error('Get TV shows error:', error);
    res.status(500).json({ error: 'Failed to get TV shows' });
  }
});

// Get a single TV show with its episodes
router.get('/tv/shows/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const show = await TVShow.findByPk(id, {
      include: [{ model: Download, as: 'downloads' }],
    });
    
    if (!show) {
      return res.status(404).json({ error: 'TV show not found' });
    }
    
    // Get all episodes for this show
    const episodes = await MediaItem.findAll({
      where: { type: 'tv', title: show.title },
      order: [['season', 'ASC'], ['episode', 'ASC']],
      include: [{ model: Download, as: 'downloads' }],
    });
    
    // Find active season/series pack downloads that cover multiple episodes.
    const activePackDownloads = await Download.findAll({
      where: {
        status: ['pending', 'downloading', 'paused'],
      },
      include: [{ model: MediaItem, as: 'mediaItem', where: { type: 'tv', title: show.title } }],
    });
    
    // Build per-episode progress map by fetching individual file progress from QBittorrent
    const episodeProgressMap = new Map<string, { downloadId: string; status: string; progress: number }>();
    for (const dl of activePackDownloads) {
      const detected = dl.detectedEpisodes;
      if (detected?.episodes && detected.episodes.length > 1 && dl.torrentHash) {
        try {
          const files = await qbittorrentService.getTorrentFiles(dl.torrentHash);
          for (const file of files) {
            const match = file.name.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
            if (match) {
              const key = `${parseInt(match[1])}:${parseInt(match[2])}`;
              // Only include episodes that are in the wanted list
              const isWanted = detected.episodes.some(
                (ep: any) => ep.season === parseInt(match[1]) && ep.episode === parseInt(match[2])
              );
              if (isWanted && file.priority > 0) {
                episodeProgressMap.set(key, {
                  downloadId: dl.id,
                  status: dl.status,
                  progress: Math.round(file.progress * 100),
                });
              }
            }
          }
        } catch (err) {
          // QBittorrent unavailable - fall back to overall progress
          for (const ep of detected.episodes) {
            const key = `${ep.season}:${ep.episode}`;
            episodeProgressMap.set(key, {
              downloadId: dl.id,
              status: dl.status,
              progress: dl.progress || 0,
            });
          }
        }
      }
    }
    
    // Augment episodes: inject per-file progress from pack downloads
    const augmentedEpisodes = episodes.map(ep => {
      const epData = ep.toJSON() as any;
      if (ep.season && ep.episode) {
        const key = `${ep.season}:${ep.episode}`;
        const info = episodeProgressMap.get(key);
        if (info) {
          // Override with per-file progress (even if episode has its own download record,
          // the pack's per-file progress is more accurate than overall torrent progress)
          epData.downloads = [{
            id: info.downloadId,
            status: info.status,
            progress: info.progress,
          }];
        }
      }
      return epData;
    });
    
    res.json({
      ...show.toJSON(),
      episodes: augmentedEpisodes,
    });
  } catch (error) {
    console.error('Get TV show error:', error);
    res.status(500).json({ error: 'Failed to get TV show' });
  }
});

// Get all media items
// When type='tv', returns TVShow entities instead of individual episodes
router.get('/', async (req, res) => {
  try {
    const { type, search } = req.query;
    
    // For TV type, return TVShow entities (not individual episodes)
    if (type === 'tv') {
      const shows = await TVShow.findAll({
        order: [['createdAt', 'DESC']],
      });
      
      // For each show, get episode count and download status
      const showsWithStats = await Promise.all(shows.map(async (show) => {
        const episodes = await MediaItem.findAll({
          where: { type: 'tv', title: show.title },
          include: [{ model: Download, as: 'downloads' }],
        });
        
        // Find active pack downloads for this show
        const activePackDownloads = await Download.findAll({
          where: { status: ['pending', 'downloading', 'paused'] },
          include: [{ model: MediaItem, as: 'mediaItem', where: { type: 'tv', title: show.title } }],
        });
        
        // Build set of episodes covered by pack downloads
        const packEpisodeKeys = new Set<string>();
        let hasActivePackDownload = false;
        for (const dl of activePackDownloads) {
          const detected = dl.detectedEpisodes;
          if (detected?.episodes && detected.episodes.length > 1) {
            hasActivePackDownload = true;
            for (const ep of detected.episodes) {
              packEpisodeKeys.add(`${ep.season}:${ep.episode}`);
            }
          }
        }
        
        const totalEpisodes = episodes.length;
        let downloadedEpisodes = 0;
        let downloadingEpisodes = 0;
        
        for (const ep of episodes) {
          // Check if episode has a file on disk
          if (ep.filePath && ep.diskPath) {
            downloadedEpisodes++;
          } else if ((ep as any).downloads?.some((d: any) => d.status === 'completed')) {
            downloadedEpisodes++;
          } else if ((ep as any).downloads?.some((d: any) => d.status === 'downloading')) {
            downloadingEpisodes++;
          } else if (ep.season && ep.episode && packEpisodeKeys.has(`${ep.season}:${ep.episode}`)) {
            downloadingEpisodes++;
          }
        }
        
        return {
          ...show.toJSON(),
          type: 'tv' as const,
          totalEpisodes,
          downloadedEpisodes,
          downloadingEpisodes,
          // Include episode download info for status display
          downloads: downloadingEpisodes > 0 ? [{ status: 'downloading', progress: 0 }] : [],
        };
      }));
      
      return res.json({ items: showsWithStats });
    }
    
    const where: any = {};
    if (type && ['movie', 'web'].includes(type as string)) {
      where.type = type;
    }
    
    const items = await MediaItem.findAll({
      where,
      order: [['createdAt', 'DESC']],
      include: [{ model: Download, as: 'downloads' }],
    });
    
    // Filter out TV episodes when returning all media (they're shown via TVShow)
    const filteredItems = items.filter(item => item.type !== 'tv');
    
    // If returning all media, also include TV shows
    if (!type) {
      const shows = await TVShow.findAll({
        order: [['createdAt', 'DESC']],
      });
      
      const showsWithStats = await Promise.all(shows.map(async (show) => {
        const episodes = await MediaItem.findAll({
          where: { type: 'tv', title: show.title },
          include: [{ model: Download, as: 'downloads' }],
        });
        
        const totalEpisodes = episodes.length;
        let downloadedEpisodes = 0;
        let downloadingEpisodes = 0;
        
        for (const ep of episodes) {
          if (ep.filePath && ep.diskPath) {
            downloadedEpisodes++;
          } else if ((ep as any).downloads?.some((d: any) => d.status === 'completed')) {
            downloadedEpisodes++;
          } else if ((ep as any).downloads?.some((d: any) => d.status === 'downloading')) {
            downloadingEpisodes++;
          }
        }
        
        return {
          ...show.toJSON(),
          type: 'tv' as const,
          totalEpisodes,
          downloadedEpisodes,
          downloadingEpisodes,
          downloads: downloadingEpisodes > 0 ? [{ status: 'downloading', progress: 0 }] : [],
        };
      }));
      
      const allItems = [...filteredItems.map(i => i.toJSON()), ...showsWithStats];
      // Sort by createdAt (handle undefined dates)
      allItems.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });
      
      return res.json({ items: allItems });
    }
    
    res.json({ items });
  } catch (error) {
    console.error('Get media error:', error);
    res.status(500).json({ error: 'Failed to get media items' });
  }
});

// Get single media item
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const item = await MediaItem.findByPk(id, {
      include: [{ model: Download, as: 'downloads' }],
    });
    
    if (!item) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    
    res.json(item);
  } catch (error) {
    console.error('Get media item error:', error);
    res.status(500).json({ error: 'Failed to get media item' });
  }
});

// Add a movie to the library
router.post('/movie', async (req, res) => {
  try {
    const { imdbId, title, year, magnetUri } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Get OMDB details if imdbId provided
    let posterUrl: string | undefined;
    let plot: string | undefined;
    
    if (imdbId) {
      const details = await omdbService.getDetails(imdbId);
      if (details) {
        posterUrl = details.Poster !== 'N/A' ? details.Poster : undefined;
        plot = details.Plot;
      }
    }

    // Create media item
    const media = await MediaItem.create({
      id: uuidv4(),
      type: 'movie',
      title,
      year: year ? parseInt(year, 10) : undefined,
      imdbId,
      posterUrl,
      plot,
      magnetUri,
    });

    // Create .strm and .yml files
    await mediaService.createMediaFiles(media);

    // If magnet URI provided, start download
    if (magnetUri) {
      const downloadReason = `Movie: ${title}${year ? ` (${year})` : ''}`;
      const download = await Download.create({
        id: uuidv4(),
        mediaItemId: media.id,
        magnetUri,
        status: 'pending',
        downloadReason,
      });

      const hash = await qbittorrentService.addTorrent(magnetUri);
      if (hash) {
        await download.update({ torrentHash: hash, status: 'downloading' });
        // Store torrent info in .yml metadata
        const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
        const torrentName = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : undefined;
        mediaService.updateMediaMetadata(media, { magnetUri, torrentHash: hash, torrentName }).catch(() => {});
      }
    }

    res.status(201).json(media);
  } catch (error) {
    console.error('Add movie error:', error);
    res.status(500).json({ error: 'Failed to add movie' });
  }
});

// Add a TV show episode to the library
router.post('/tv', async (req, res) => {
  try {
    const { imdbId, title, year, season, episode, magnetUri } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Get OMDB details if imdbId provided
    let posterUrl: string | undefined;
    let plot: string | undefined;
    
    if (imdbId) {
      const details = await omdbService.getDetails(imdbId);
      if (details) {
        posterUrl = details.Poster !== 'N/A' ? details.Poster : undefined;
        plot = details.Plot;
      }
    }

    // Create media item for specific episode
    const media = await MediaItem.create({
      id: uuidv4(),
      type: 'tv',
      title,
      year: year ? parseInt(year, 10) : undefined,
      imdbId,
      posterUrl,
      plot,
      season: season ? parseInt(season, 10) : 1,
      episode: episode ? parseInt(episode, 10) : 1,
      magnetUri,
    });

    // Create .strm and .yml files
    await mediaService.createMediaFiles(media);

    // If magnet URI provided, start download
    if (magnetUri) {
      const seasonNum = season ? parseInt(season, 10) : 1;
      const episodeNum = episode ? parseInt(episode, 10) : 1;
      const downloadReason = `TV: ${title} S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
      const download = await Download.create({
        id: uuidv4(),
        mediaItemId: media.id,
        magnetUri,
        status: 'pending',
        downloadReason,
      });

      const hash = await qbittorrentService.addTorrent(magnetUri);
      if (hash) {
        await download.update({ torrentHash: hash, status: 'downloading' });
        const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
        const torrentName = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : undefined;
        mediaService.updateMediaMetadata(media, { magnetUri, torrentHash: hash, torrentName }).catch(() => {});
      }
    }

    res.status(201).json(media);
  } catch (error) {
    console.error('Add TV show error:', error);
    res.status(500).json({ error: 'Failed to add TV show' });
  }
});

// Add an entire TV show to the library (all seasons and episodes)
router.post('/tv/show', async (req, res) => {
  try {
    const { imdbId, title, year } = req.body;
    
    if (!imdbId) {
      return res.status(400).json({ error: 'IMDB ID is required to add a full TV show' });
    }

    // Check if show already exists
    let tvShow = await TVShow.findOne({ where: { imdbId } });
    
    // Get show details from OMDB
    const showDetails = await omdbService.getDetails(imdbId);
    if (!showDetails) {
      return res.status(404).json({ error: 'TV show not found' });
    }

    const totalSeasons = parseInt(showDetails.totalSeasons || '1', 10);
    const posterUrl = showDetails.Poster !== 'N/A' ? showDetails.Poster : undefined;
    const plot = showDetails.Plot;
    const showTitle = title || showDetails.Title;
    const showYear = year ? parseInt(year, 10) : parseInt(showDetails.Year, 10);

    // Create or update the TV show entry
    if (!tvShow) {
      tvShow = await TVShow.create({
        id: uuidv4(),
        title: showTitle,
        year: showYear,
        imdbId,
        posterUrl,
        plot,
        totalSeasons,
      });
      console.log(`Created TV show: ${showTitle} (${showYear})`);
    } else {
      // Update existing show with latest details
      await tvShow.update({
        title: showTitle,
        year: showYear,
        posterUrl,
        plot,
        totalSeasons,
      });
      console.log(`Updated TV show: ${showTitle} (${showYear})`);
    }

    const createdMedia: MediaItem[] = [];

    // Iterate through all seasons
    for (let season = 1; season <= totalSeasons; season++) {
      const seasonDetails = await omdbService.getSeasonDetails(imdbId, season);
      
      if (seasonDetails && seasonDetails.Episodes) {
        for (const ep of seasonDetails.Episodes) {
          const episodeNum = parseInt(ep.Episode, 10);
          
          // Check if this episode already exists
          const existing = await MediaItem.findOne({
            where: {
              type: 'tv',
              title: showTitle,
              season,
              episode: episodeNum,
            },
          });

          if (existing) {
            createdMedia.push(existing);
            continue;
          }

          // Create media item for this episode
          const media = await MediaItem.create({
            id: uuidv4(),
            type: 'tv',
            title: showTitle,
            year: showYear,
            imdbId,
            posterUrl,
            plot,
            season,
            episode: episodeNum,
          });

          // Create .strm and .yml files
          await mediaService.createMediaFiles(media);
          createdMedia.push(media);
        }
      }
    }

    res.status(201).json({
      show: tvShow,
      title: showTitle,
      year: showYear,
      imdbId,
      totalSeasons,
      episodesAdded: createdMedia.length,
      episodes: createdMedia,
    });
  } catch (error) {
    console.error('Add TV show error:', error);
    res.status(500).json({ error: 'Failed to add TV show' });
  }
});

// Delete an entire TV show (all episodes)
// This is the only way to fully delete a TV show from the library
// Returns information about what was deleted for confirmation
router.delete('/tv/show/:title', async (req, res) => {
  try {
    const { title } = req.params;
    const { deleteFiles, confirmed } = req.query;
    
    // Find all episodes of this TV show
    const episodes = await MediaItem.findAll({
      where: {
        type: 'tv',
        title: title,
      },
      include: [{ model: Download, as: 'downloads' }],
    });
    
    if (episodes.length === 0) {
      return res.status(404).json({ error: 'TV show not found' });
    }

    // If not confirmed, return information about what will be deleted
    if (confirmed !== 'true') {
      const downloadedCount = episodes.filter(ep => ep.filePath && ep.diskPath).length;
      return res.json({
        requiresConfirmation: true,
        title,
        totalEpisodes: episodes.length,
        downloadedEpisodes: downloadedCount,
        message: `This will permanently delete "${title}" including ${episodes.length} episodes and ${downloadedCount} downloaded files. Files will be moved to trash for recovery.`,
      });
    }

    // Delete associated downloads from QBittorrent
    for (const episode of episodes) {
      const downloads = await Download.findAll({ where: { mediaItemId: episode.id } });
      for (const download of downloads) {
        if (download.torrentHash) {
          await qbittorrentService.deleteTorrent(download.torrentHash, deleteFiles === 'true');
        }
      }
    }

    // Use the service method to handle trash and file cleanup
    const result = await mediaService.deleteTvShow(title, deleteFiles === 'true');

    // Delete from database
    for (const episode of episodes) {
      await Download.destroy({ where: { mediaItemId: episode.id } });
      await episode.destroy();
    }

    // Also delete the TVShow entry if it exists
    await TVShow.destroy({ where: { title: title } });

    // Remove from Jellyfin
    jellyfinService.deleteTvSeriesByName(title).catch(() => {});

    res.json({ 
      success: true, 
      deletedEpisodes: result.deletedEpisodes,
      trashedFiles: result.trashedFiles,
      message: result.message,
    });
  } catch (error) {
    console.error('Delete TV show error:', error);
    res.status(500).json({ error: 'Failed to delete TV show' });
  }
});

// Add web content to the library
router.post('/web', async (req, res) => {
  try {
    const { title, channel, magnetUri } = req.body;
    
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Create media item
    const media = await MediaItem.create({
      id: uuidv4(),
      type: 'web',
      title,
      channel,
      magnetUri,
    });

    // Create .strm and .yml files
    await mediaService.createMediaFiles(media);

    // If magnet URI provided, start download
    if (magnetUri) {
      const downloadReason = `Web: ${title}${channel ? ` (${channel})` : ''}`;
      const download = await Download.create({
        id: uuidv4(),
        mediaItemId: media.id,
        magnetUri,
        status: 'pending',
        downloadReason,
      });

      const hash = await qbittorrentService.addTorrent(magnetUri);
      if (hash) {
        await download.update({ torrentHash: hash, status: 'downloading' });
        const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
        const torrentName = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : undefined;
        mediaService.updateMediaMetadata(media, { magnetUri, torrentHash: hash, torrentName }).catch(() => {});
      }
    }

    res.status(201).json(media);
  } catch (error) {
    console.error('Add web content error:', error);
    res.status(500).json({ error: 'Failed to add web content' });
  }
});

// Search for torrents and add to media item
router.post('/:id/search-torrents', async (req, res) => {
  try {
    const { id } = req.params;
    
    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    let query: string;
    if (media.type === 'movie') {
      query = `${media.title} ${media.year || ''}`;
    } else if (media.type === 'tv') {
      query = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
    } else {
      query = media.title;
    }

    const results = await torrentSearchService.search(query.trim());
    
    res.json({ results });
  } catch (error) {
    console.error('Search torrents error:', error);
    res.status(500).json({ error: 'Failed to search torrents' });
  }
});

// Start download for a media item
router.post('/:id/download', async (req, res) => {
  const { id } = req.params;
  const lockKey = `download:${id}`;
  
  // Prevent concurrent duplicate requests for the same media item
  if (downloadLocks.has(lockKey)) {
    console.log(`[Download] Request for ${id} already in-flight, waiting...`);
    // Wait briefly and return the existing download if one was created
    await new Promise(resolve => setTimeout(resolve, 2000));
    const existing = await Download.findOne({
      where: { mediaItemId: id, status: ['pending', 'downloading', 'paused'] },
    });
    if (existing) return res.json(existing);
    return res.status(409).json({ error: 'Download request already in progress' });
  }
  
  downloadLocks.add(lockKey);
  try {
    const { magnetUri, detectedEpisodes, wantedEpisodes } = req.body;
    
    if (!magnetUri) {
      return res.status(400).json({ error: 'Magnet URI is required' });
    }

    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    // Extract the magnet hash for duplicate checking
    const hashMatch = magnetUri.match(/btih:([a-fA-F0-9]+)/i);
    const magnetHash = hashMatch ? hashMatch[1].toLowerCase() : null;

    // Check for existing active downloads to prevent duplicates
    // First check by media item ID
    const existingDownload = await Download.findOne({
      where: {
        mediaItemId: media.id,
        status: ['pending', 'downloading', 'paused'],
      },
    });
    
    if (existingDownload) {
      console.log(`[Download] Already in progress for ${media.title} (mediaItemId match), returning existing`);
      return res.json(existingDownload);
    }

    // Check if there's a download with the same torrent hash (already has hash set)
    if (magnetHash) {
      const existingTorrentDownload = await Download.findOne({
        where: {
          torrentHash: magnetHash,
          status: ['pending', 'downloading', 'paused'],
        },
      });
      
      if (existingTorrentDownload) {
        console.log(`[Download] Torrent ${magnetHash} already being downloaded (hash match), returning existing`);
        return res.json(existingTorrentDownload);
      }
      
      // Also check by magnetUri in case torrentHash hasn't been set yet (race condition)
      // This handles the case where another download was just created but hasn't gotten its hash yet
      const { Op } = require('sequelize');
      const existingMagnetDownload = await Download.findOne({
        where: {
          magnetUri: {
            [Op.like]: `%${magnetHash}%`, // Match by the hash portion of the magnet URI
          },
          status: ['pending', 'downloading', 'paused'],
        },
      });
      
      if (existingMagnetDownload) {
        console.log(`[Download] Magnet ${magnetHash} already being downloaded (magnetUri match), returning existing`);
        return res.json(existingMagnetDownload);
      }
    }

    // Update media item with magnet URI
    await media.update({ magnetUri });

    // Build download reason
    let downloadReason: string;
    if (media.type === 'movie') {
      downloadReason = `Movie: ${media.title}${media.year ? ` (${media.year})` : ''}`;
    } else if (media.type === 'tv') {
      if (detectedEpisodes) {
        downloadReason = `TV: ${media.title} - ${detectedEpisodes.description || detectedEpisodes.type}`;
      } else if (media.season && media.episode) {
        downloadReason = `TV: ${media.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
      } else {
        downloadReason = `TV: ${media.title}`;
      }
    } else {
      downloadReason = `Web: ${media.title}`;
    }

    // Build the final detectedEpisodes to store
    // IMPORTANT: If wantedEpisodes is provided, use it to populate the episodes array
    // This ensures that when ensureFilePrioritiesConfigured runs during sync, it has the full list
    let finalDetectedEpisodes = detectedEpisodes;
    if (media.type === 'tv' && wantedEpisodes && Array.isArray(wantedEpisodes) && wantedEpisodes.length > 0) {
      finalDetectedEpisodes = {
        ...detectedEpisodes,
        episodes: wantedEpisodes, // Override with the explicit wanted episodes list
      };
      console.log(`[Download] Storing ${wantedEpisodes.length} wanted episodes in download record for ${media.title}`);
    }

    // Create download record with detected episodes info
    const download = await Download.create({
      id: uuidv4(),
      mediaItemId: media.id,
      magnetUri,
      status: 'pending',
      detectedEpisodes: finalDetectedEpisodes || undefined,
      downloadReason,
    });

    // Add to QBittorrent
    const hash = await qbittorrentService.addTorrent(magnetUri);
    if (hash) {
      await download.update({ torrentHash: hash, status: 'downloading' });
      
      // Extract torrent name from magnet URI dn= parameter
      const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
      const torrentName = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : undefined;
      
      // Store torrent info in .yml metadata immediately so it persists even if download is paused/cancelled
      mediaService.updateMediaMetadata(media, {
        magnetUri,
        torrentHash: hash,
        torrentName,
      }).catch(err => {
        console.error(`[Download] Failed to update metadata for ${media.title}:`, err);
      });
      
      // If this is a TV show download with specific episodes wanted,
      // configure file priorities to only download what we need
      if (media.type === 'tv' && wantedEpisodes && Array.isArray(wantedEpisodes) && wantedEpisodes.length > 0) {
        console.log(`[Download] Configuring file priorities for ${wantedEpisodes.length} wanted episodes: ${wantedEpisodes.map(e => `S${e.season}E${e.episode}`).join(', ')}`);
        // Run in background - don't block the response
        downloadManager.configureFilePriorities(hash, wantedEpisodes).catch(err => {
          console.error('Error configuring file priorities:', err);
        });
      } else if (media.type === 'tv' && finalDetectedEpisodes?.episodes && finalDetectedEpisodes.episodes.length > 0) {
        // Use episodes from finalDetectedEpisodes (which includes wantedEpisodes if provided)
        console.log(`[Download] Configuring file priorities based on detected episodes: ${finalDetectedEpisodes.episodes.length} episodes`);
        downloadManager.configureFilePriorities(hash, finalDetectedEpisodes.episodes).catch(err => {
          console.error('Error configuring file priorities:', err);
        });
      } else if (media.type === 'tv' && media.season && media.episode) {
        // Single episode download - configure to only get this episode
        console.log(`[Download] Configuring file priorities for single episode S${media.season}E${media.episode}`);
        downloadManager.configureFilePriorities(hash, [{ season: media.season, episode: media.episode }]).catch(err => {
          console.error('Error configuring file priorities:', err);
        });
      } else if (media.type === 'tv') {
        // TV download with no specific episodes - this shouldn't happen but log it
        console.log(`[Download] WARNING: TV download started without specific episodes for ${media.title}. All files will be downloaded.`);
      }
    } else {
      await download.update({ status: 'failed', error: 'Failed to add torrent' });
    }

    res.json(download);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to start download' });
  } finally {
    downloadLocks.delete(lockKey);
  }
});

// Delete media item
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteFiles, deleteMetadata } = req.query;
    
    const media = await MediaItem.findByPk(id, {
      include: [{ model: Download, as: 'downloads' }],
    });
    
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    // For TV episodes, only delete the downloaded file by default (not metadata)
    // unless explicitly requested via deleteMetadata=true
    if (media.type === 'tv' && deleteMetadata !== 'true') {
      // Only delete the downloaded file, keeping the episode in the library
      const result = await mediaService.deleteDownloadedFile(media);
      
      // Delete associated downloads from QBittorrent
      const downloads = await Download.findAll({ where: { mediaItemId: id } });
      for (const download of downloads) {
        if (download.torrentHash) {
          await qbittorrentService.deleteTorrent(download.torrentHash, true);
        }
      }
      
      // Delete download records but keep the media item
      await Download.destroy({ where: { mediaItemId: id } });
      
      return res.json({ 
        success: result.success, 
        message: result.message,
        fileDeleted: true,
        metadataPreserved: true,
      });
    }

    // For movies, web content, or when deleteMetadata=true for TV episodes
    // Delete associated downloads from QBittorrent
    const downloads = await Download.findAll({ where: { mediaItemId: id } });
    for (const download of downloads) {
      if (download.torrentHash) {
        await qbittorrentService.deleteTorrent(download.torrentHash, deleteFiles === 'true');
      }
    }

    // Move downloaded files to trash if they exist
    if (deleteFiles === 'true') {
      try {
        await mediaService.deleteDownloadedFile(media);
      } catch (e: any) {
        console.warn('Failed to move downloaded file to trash:', e.message);
      }
    }

    // Remove from Jellyfin before deleting files
    const strmPath = mediaService.getStrmPath(media);
    if (strmPath) {
      jellyfinService.deleteItemByPath(strmPath).catch(() => {});
    }

    // Delete .strm and .yml content files
    try {
      await mediaService.deleteMediaFiles(media);
    } catch (e: any) {
      console.error('Failed to delete media files:', e.message);
      // Continue with deletion even if file cleanup fails
    }

    // Delete from database
    await Download.destroy({ where: { mediaItemId: id } });
    await media.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete media error:', error);
    res.status(500).json({ error: 'Failed to delete media item' });
  }
});

// Delete only the stored media files for a media item, preserving all metadata
router.post('/:id/delete-files', async (req, res) => {
  try {
    const { id } = req.params;

    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    // Delete the downloaded file (moves to trash), clears filePath/diskPath
    const result = await mediaService.deleteDownloadedFile(media);

    // Remove associated download records and torrents from QBittorrent
    const downloads = await Download.findAll({ where: { mediaItemId: id } });
    for (const download of downloads) {
      if (download.torrentHash) {
        await qbittorrentService.deleteTorrent(download.torrentHash, true);
      }
    }
    await Download.destroy({ where: { mediaItemId: id } });

    res.json({
      success: result.success,
      message: result.message,
      fileDeleted: true,
      metadataPreserved: true,
    });
  } catch (error) {
    console.error('Delete media files error:', error);
    res.status(500).json({ error: 'Failed to delete media files' });
  }
});

// Pin/unpin media item
router.post('/:id/pin', async (req, res) => {
  try {
    const { id } = req.params;
    const { pinned } = req.body;
    
    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    
    await media.update({ pinned: pinned !== false });
    
    res.json({ success: true, pinned: media.pinned });
  } catch (error) {
    console.error('Pin media error:', error);
    res.status(500).json({ error: 'Failed to pin media item' });
  }
});

// Unpin media item
router.post('/:id/unpin', async (req, res) => {
  try {
    const { id } = req.params;
    
    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    
    await media.update({ pinned: false });
    
    res.json({ success: true, pinned: false });
  } catch (error) {
    console.error('Unpin media error:', error);
    res.status(500).json({ error: 'Failed to unpin media item' });
  }
});

// Pin an entire TV show (all episodes)
router.post('/tv/show/:title/pin', async (req, res) => {
  try {
    const { title } = req.params;
    const { pinned } = req.body;
    
    const episodes = await MediaItem.findAll({
      where: { type: 'tv', title },
    });
    
    if (episodes.length === 0) {
      return res.status(404).json({ error: 'TV show not found' });
    }
    
    for (const episode of episodes) {
      await episode.update({ pinned: pinned !== false });
    }
    
    res.json({ success: true, pinnedCount: episodes.length });
  } catch (error) {
    console.error('Pin TV show error:', error);
    res.status(500).json({ error: 'Failed to pin TV show' });
  }
});

// Get all pinned media
router.get('/pinned', async (req, res) => {
  try {
    const items = await MediaItem.findAll({
      where: { pinned: true },
      include: [{ model: Download, as: 'downloads' }],
      order: [['title', 'ASC']],
    });
    
    res.json({ items });
  } catch (error) {
    console.error('Get pinned media error:', error);
    res.status(500).json({ error: 'Failed to get pinned media' });
  }
});

// Get media details with complete information (for details page)
router.get('/:id/details', async (req, res) => {
  try {
    const { id } = req.params;
    
    const media = await MediaItem.findByPk(id, {
      include: [{ model: Download, as: 'downloads' }],
    });
    
    if (!media) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    
    // For TV episodes, find the parent TV show and redirect there
    let relatedEpisodes = 0;
    let parentShowId: string | null = null;
    if (media.type === 'tv') {
      relatedEpisodes = await MediaItem.count({
        where: { type: 'tv', title: media.title },
      });
      
      // Find the parent TVShow entity
      const parentShow = await TVShow.findOne({
        where: { title: media.title },
      });
      if (parentShow) {
        parentShowId = parentShow.id;
      }
    }
    
    // Check if file is available on disk
    const filePath = await mediaService.getMediaFilePath(media);
    const hasFile = !!filePath;
    
    res.json({
      ...media.toJSON(),
      hasFile,
      relatedEpisodes,
      parentShowId, // Frontend should redirect to /media/tv/{parentShowId} for TV episodes
    });
  } catch (error) {
    console.error('Get media details error:', error);
    res.status(500).json({ error: 'Failed to get media details' });
  }
});

/**
 * Migrate existing .strm files to use direct file paths.
 * 
 * This endpoint scans all media items that have downloaded files and updates
 * their .strm files to point directly to the file path instead of the
 * streaming endpoint. This enables Jellyfin to use direct play.
 * 
 * Called once after updating to the new approach, or can be called anytime
 * to fix any .strm files that still point to streaming endpoints.
 */
router.post('/migrate-strm-files', async (req, res) => {
  try {
    console.log('Starting .strm file migration to direct paths...');
    
    const result = await mediaService.migrateStrmFilesToDirectPaths();
    
    res.json({
      success: true,
      message: 'STRM file migration complete',
      ...result,
    });
  } catch (error) {
    console.error('STRM migration error:', error);
    res.status(500).json({ error: 'Failed to migrate STRM files' });
  }
});

/**
 * Migrate orphaned TV episodes into TVShow entities.
 * 
 * This endpoint scans all MediaItem records with type='tv' and ensures
 * each unique show title has a corresponding TVShow entity. This fixes
 * the issue where episodes were added without their parent show.
 */
router.post('/migrate-tv-episodes', async (req, res) => {
  try {
    console.log('Starting TV episode migration...');
    
    // Find all unique TV show titles from episodes
    const episodes = await MediaItem.findAll({
      where: { type: 'tv' },
      attributes: ['title', 'year', 'imdbId', 'posterUrl', 'plot'],
    });
    
    // Group by title to find unique shows
    const showTitles = new Map<string, { year?: number; imdbId?: string; posterUrl?: string; plot?: string }>();
    for (const ep of episodes) {
      if (!showTitles.has(ep.title)) {
        showTitles.set(ep.title, {
          year: ep.year,
          imdbId: ep.imdbId,
          posterUrl: ep.posterUrl,
          plot: ep.plot,
        });
      }
    }
    
    let createdCount = 0;
    let existingCount = 0;
    
    for (const [title, data] of showTitles) {
      // Check if TVShow already exists
      const existingShow = await TVShow.findOne({
        where: { title },
      });
      
      if (existingShow) {
        existingCount++;
        continue;
      }
      
      // Try to get more details from OMDB if we have an IMDB ID
      let totalSeasons = 1;
      if (data.imdbId) {
        try {
          const details = await omdbService.getDetails(data.imdbId);
          if (details && details.totalSeasons) {
            totalSeasons = parseInt(details.totalSeasons, 10);
          }
        } catch (e) {
          // Continue without OMDB details
        }
      }
      
      // Create the TVShow entity
      await TVShow.create({
        id: uuidv4(),
        title,
        year: data.year,
        imdbId: data.imdbId,
        posterUrl: data.posterUrl,
        plot: data.plot,
        totalSeasons,
      });
      
      console.log(`Created TVShow entity for: ${title}`);
      createdCount++;
    }
    
    res.json({
      success: true,
      message: 'TV episode migration complete',
      created: createdCount,
      existing: existingCount,
      totalShows: createdCount + existingCount,
    });
  } catch (error) {
    console.error('TV migration error:', error);
    res.status(500).json({ error: 'Failed to migrate TV episodes' });
  }
});

export default router;
