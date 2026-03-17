/**
 * Progress Video Routes
 * 
 * These endpoints serve live video streams showing download progress.
 * When a user plays content in Jellyfin that hasn't been downloaded yet,
 * they see a video showing the download status instead of an error.
 * 
 * Once the download completes:
 * 1. The file is moved to storage
 * 2. The .strm file is updated to point to the direct file path
 * 3. Jellyfin is refreshed to enable direct play
 * 
 * The .strm files initially contain URLs to these progress endpoints,
 * which are then updated to direct file paths after download completes.
 * 
 * Auto-download: When content is accessed that isn't downloading,
 * the system will automatically attempt to find and download it.
 */
import { Router } from 'express';
import { MediaItem, Download, Setting } from '../models';
import { slugify } from '../services/media';
import { progressVideoService } from '../services/progressVideo';
import { qbittorrentService } from '../services/qbittorrent';
import { autoDownloadService } from '../services/autoDownload';
import { downloadManager } from '../services/downloadManager';

const router = Router();

/**
 * Bump the download priority when a user starts watching the progress stream.
 * This ensures the content the user is actively waiting for gets downloaded first.
 * 
 * For TV episodes, this also boosts the specific file priority within the torrent
 * so that the episode the user wants to watch downloads before others.
 */
async function bumpDownloadPriority(media: MediaItem): Promise<void> {
  try {
    // For TV episodes, use the enhanced priority boost that targets specific files
    if (media.type === 'tv') {
      const boosted = await downloadManager.boostEpisodePriority(media);
      if (boosted) {
        console.log(`[Progress] Episode priority boosted for: ${media.title} S${media.season}E${media.episode}`);
        return;
      }
      // Fall through to regular priority bump if episode boost failed
    }

    // For movies, use the movie priority boost
    if (media.type === 'movie') {
      const boosted = await downloadManager.boostMoviePriority(media);
      if (boosted) {
        console.log(`[Progress] Movie priority boosted for: ${media.title}`);
        return;
      }
      // Fall through to regular priority bump if movie boost failed
    }

    // Find the download for this media item
    const download = await Download.findOne({
      where: { mediaItemId: media.id },
    });

    if (!download || !download.torrentHash) {
      return;
    }

    // Only bump priority for active downloads
    if (download.status !== 'downloading' && download.status !== 'pending' && download.status !== 'paused') {
      return;
    }

    console.log(`[Progress] Bumping priority for: ${media.title} (hash: ${download.torrentHash})`);

    // Set to top of queue
    await qbittorrentService.setTopPriority(download.torrentHash);
    
    // Enable first/last piece priority for faster initial playback
    await qbittorrentService.setFirstLastPiecePriority(download.torrentHash);
    
    // Force start if it's queued or paused
    if (download.status === 'pending' || download.status === 'paused') {
      await qbittorrentService.forceResume(download.torrentHash);
      
      // Update status to downloading
      if (download.status === 'paused') {
        await download.update({ status: 'downloading' });
      }
    }

    console.log(`[Progress] Priority bumped for: ${media.title}`);
  } catch (error) {
    console.error('[Progress] Error bumping download priority:', error);
  }
}

/**
 * Check if media needs auto-download and trigger it if so.
 * This runs when someone accesses content that isn't being downloaded.
 * Respects the autoDownloadEnabled setting (defaults to true).
 */
async function triggerAutoDownloadIfNeeded(media: MediaItem): Promise<void> {
  try {
    // Check if auto-download is enabled (defaults to true)
    const autoDownloadSetting = await Setting.findOne({ where: { key: 'autoDownloadEnabled' } });
    const autoDownloadEnabled = !autoDownloadSetting || autoDownloadSetting.value !== 'false';
    
    if (!autoDownloadEnabled) {
      console.log(`[Progress] Auto-download disabled by setting, skipping for: ${media.title}`);
      return;
    }

    // For TV episodes, check if there's an active download for any episode of this show
    // (A season pack download might be downloading this episode as part of a larger torrent)
    let hasActiveDownload = false;
    
    if (media.type === 'tv') {
      // Find any active download for this TV show by looking at associated media items
      const activeDownloads = await Download.findAll({
        where: {
          status: ['pending', 'downloading', 'paused'],
        },
        include: [{
          model: MediaItem,
          as: 'mediaItem',
          required: true,
        }],
      });
      
      hasActiveDownload = activeDownloads.some(d => {
        const downloadMedia = (d as any).mediaItem as MediaItem | undefined;
        return downloadMedia && downloadMedia.type === 'tv' && downloadMedia.title === media.title;
      });
    } else {
      // For movies/web, check directly by media item ID
      const existingDownload = await Download.findOne({
        where: { mediaItemId: media.id },
      });
      hasActiveDownload = existingDownload !== null && existingDownload.status !== 'failed';
    }

    // Only trigger auto-download if there's no active download
    if (!hasActiveDownload) {
      console.log(`[Progress] Triggering auto-download for: ${media.title}`);
      // Don't await - let it run in background
      autoDownloadService.attemptAutoDownload(media).then(result => {
        if (result.success) {
          console.log(`[Progress] Auto-download started: ${result.message}`);
        } else {
          console.log(`[Progress] Auto-download not started: ${result.message}`);
        }
      }).catch(err => {
        console.error('[Progress] Auto-download error:', err);
      });
    } else {
      // If there's an active download, bump its priority since user is watching
      await bumpDownloadPriority(media);
    }
  } catch (error) {
    console.error('[Progress] Error checking auto-download:', error);
  }
}

// Helper function to find media by slug-based path
async function findMediaByPath(
  type: string,
  titleSlug: string,
  yearOrEpisode?: string
): Promise<MediaItem | null> {
  const where: any = { type };
  const allMedia = await MediaItem.findAll({ where });
  
  for (const media of allMedia) {
    const mediaSlug = slugify(media.title);
    
    if (mediaSlug === titleSlug) {
      if (type === 'movie') {
        const year = parseInt(yearOrEpisode || '0', 10);
        if (!year || media.year === year) {
          return media;
        }
      } else if (type === 'tv') {
        if (yearOrEpisode) {
          const match = yearOrEpisode.toLowerCase().match(/s(\d+)e(\d+)/);
          if (match) {
            const season = parseInt(match[1], 10);
            const episode = parseInt(match[2], 10);
            if (media.season === season && media.episode === episode) {
              return media;
            }
          }
        }
      } else {
        return media;
      }
    }
  }
  
  return null;
}

// Progress video for movies: /progress/movies/:title/:year
router.get('/movies/:title/:year', async (req, res) => {
  try {
    const { title, year } = req.params;
    const media = await findMediaByPath('movie', title, year);
    
    if (!media) {
      return res.status(404).json({ error: 'Movie not found' });
    }
    
    // Sync downloads to get latest status
    await qbittorrentService.syncDownloads();
    
    // Trigger auto-download if content is not being downloaded
    await triggerAutoDownloadIfNeeded(media);
    
    return progressVideoService.streamProgress(media, res);
  } catch (error) {
    console.error('Progress video error:', error);
    res.status(500).json({ error: 'Failed to generate progress video' });
  }
});

// Progress video for TV episodes: /progress/tv/:title/:episode
router.get('/tv/:title/:episode', async (req, res) => {
  try {
    const { title, episode } = req.params;
    const media = await findMediaByPath('tv', title, episode);
    
    if (!media) {
      return res.status(404).json({ error: 'Episode not found' });
    }
    
    await qbittorrentService.syncDownloads();
    
    // Trigger auto-download if content is not being downloaded
    await triggerAutoDownloadIfNeeded(media);
    
    return progressVideoService.streamProgress(media, res);
  } catch (error) {
    console.error('Progress video error:', error);
    res.status(500).json({ error: 'Failed to generate progress video' });
  }
});

// Progress video for web content: /progress/web/:title
router.get('/web/:title', async (req, res) => {
  try {
    const { title } = req.params;
    const media = await findMediaByPath('web', title);
    
    if (!media) {
      return res.status(404).json({ error: 'Content not found' });
    }
    
    await qbittorrentService.syncDownloads();
    
    // Trigger auto-download if content is not being downloaded
    await triggerAutoDownloadIfNeeded(media);
    
    return progressVideoService.streamProgress(media, res);
  } catch (error) {
    console.error('Progress video error:', error);
    res.status(500).json({ error: 'Failed to generate progress video' });
  }
});

// Legacy route: Progress video by ID (for backwards compatibility)
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const media = await MediaItem.findByPk(id);
    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    await qbittorrentService.syncDownloads();
    
    // Trigger auto-download if content is not being downloaded
    await triggerAutoDownloadIfNeeded(media);
    
    return progressVideoService.streamProgress(media, res);
  } catch (error) {
    console.error('Progress video error:', error);
    res.status(500).json({ error: 'Failed to generate progress video' });
  }
});

export default router;
