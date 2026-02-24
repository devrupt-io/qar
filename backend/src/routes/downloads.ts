import { Router } from 'express';
import { Download, MediaItem } from '../models';
import { qbittorrentService } from '../services/qbittorrent';
import { downloadManager } from '../services/downloadManager';

const router = Router();

// Get all downloads
router.get('/', async (req, res) => {
  try {
    // Sync with QBittorrent first
    await qbittorrentService.syncDownloads();

    const downloads = await Download.findAll({
      include: [{ model: MediaItem, as: 'mediaItem' }],
      order: [['createdAt', 'DESC']],
    });

    res.json({ downloads });
  } catch (error) {
    console.error('Get downloads error:', error);
    res.status(500).json({ error: 'Failed to get downloads' });
  }
});

// Get active downloads only
router.get('/active', async (req, res) => {
  try {
    // Sync with QBittorrent first
    await qbittorrentService.syncDownloads();

    const downloads = await Download.findAll({
      where: {
        status: ['pending', 'downloading', 'paused'],
      },
      include: [{ model: MediaItem, as: 'mediaItem' }],
      order: [['createdAt', 'DESC']],
    });

    res.json({ downloads });
  } catch (error) {
    console.error('Get active downloads error:', error);
    res.status(500).json({ error: 'Failed to get active downloads' });
  }
});

// Get global transfer info
router.get('/transfer/info', async (req, res) => {
  try {
    const info = await qbittorrentService.getGlobalTransferInfo();
    res.json(info || {});
  } catch (error) {
    console.error('Get transfer info error:', error);
    res.status(500).json({ error: 'Failed to get transfer info' });
  }
});

// Get download history (completed downloads)
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await downloadManager.getDownloadHistory(limit);
    res.json({ downloads: history });
  } catch (error) {
    console.error('Get download history error:', error);
    res.status(500).json({ error: 'Failed to get download history' });
  }
});

// Get single download
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Sync with QBittorrent first
    await qbittorrentService.syncDownloads();

    const download = await Download.findByPk(id, {
      include: [{ model: MediaItem, as: 'mediaItem' }],
    });

    if (!download) {
      return res.status(404).json({ error: 'Download not found' });
    }

    res.json(download);
  } catch (error) {
    console.error('Get download error:', error);
    res.status(500).json({ error: 'Failed to get download' });
  }
});

// Pause download
router.post('/:id/pause', async (req, res) => {
  try {
    const { id } = req.params;

    const download = await Download.findByPk(id);
    if (!download) {
      return res.status(404).json({ error: 'Download not found' });
    }

    if (download.torrentHash) {
      const success = await qbittorrentService.pauseTorrent(download.torrentHash);
      if (success) {
        await download.update({ status: 'paused' });
      }
    }

    res.json(download);
  } catch (error) {
    console.error('Pause download error:', error);
    res.status(500).json({ error: 'Failed to pause download' });
  }
});

// Resume download
router.post('/:id/resume', async (req, res) => {
  try {
    const { id } = req.params;

    const download = await Download.findByPk(id);
    if (!download) {
      return res.status(404).json({ error: 'Download not found' });
    }

    if (download.torrentHash) {
      const success = await qbittorrentService.resumeTorrent(download.torrentHash);
      if (success) {
        await download.update({ status: 'downloading' });
      }
    }

    res.json(download);
  } catch (error) {
    console.error('Resume download error:', error);
    res.status(500).json({ error: 'Failed to resume download' });
  }
});

// Cancel/delete download
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteFiles } = req.query;

    const download = await Download.findByPk(id);
    if (!download) {
      return res.status(404).json({ error: 'Download not found' });
    }

    if (download.torrentHash) {
      await qbittorrentService.deleteTorrent(download.torrentHash, deleteFiles === 'true');
    }

    await download.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error('Delete download error:', error);
    res.status(500).json({ error: 'Failed to delete download' });
  }
});

// Trigger a manual sync with QBittorrent
router.post('/sync', async (req, res) => {
  try {
    await downloadManager.triggerSync();
    res.json({ success: true, message: 'Sync triggered' });
  } catch (error) {
    console.error('Manual sync error:', error);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

// Clean up duplicate and stale downloads
// Removes duplicate download records for the same media item
router.post('/cleanup', async (req, res) => {
  try {
    let removedCount = 0;
    let fixedCount = 0;
    
    // Find all media items with multiple downloads
    const allDownloads = await Download.findAll({
      include: [{ model: MediaItem, as: 'mediaItem' }],
      order: [['createdAt', 'DESC']],
    });
    
    // Group downloads by media item ID
    const downloadsByMediaItem = new Map<string, Download[]>();
    for (const download of allDownloads) {
      const mediaItemId = download.mediaItemId;
      if (mediaItemId) {
        if (!downloadsByMediaItem.has(mediaItemId)) {
          downloadsByMediaItem.set(mediaItemId, []);
        }
        downloadsByMediaItem.get(mediaItemId)!.push(download);
      }
    }
    
    // For each media item with multiple downloads, keep only the most relevant one
    for (const [mediaItemId, downloads] of downloadsByMediaItem) {
      if (downloads.length > 1) {
        // Sort: active downloads first, then by createdAt desc
        downloads.sort((a, b) => {
          const statusOrder: Record<string, number> = { 
            downloading: 0, 
            pending: 1, 
            paused: 2, 
            completed: 3, 
            failed: 4 
          };
          const statusDiff = (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5);
          if (statusDiff !== 0) return statusDiff;
          return new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime();
        });
        
        // Keep the first (most relevant), remove the rest
        const toKeep = downloads[0];
        for (let i = 1; i < downloads.length; i++) {
          const duplicate = downloads[i];
          console.log(`Removing duplicate download ${duplicate.id} for media item ${mediaItemId}`);
          
          // Don't delete torrent from QBittorrent if the main download is using it
          if (duplicate.torrentHash && duplicate.torrentHash !== toKeep.torrentHash) {
            await qbittorrentService.deleteTorrent(duplicate.torrentHash, false);
          }
          
          await duplicate.destroy();
          removedCount++;
        }
      }
    }
    
    // Also fix any completed downloads without completedAt
    // Use raw query to find records where completedAt is NULL
    const completedWithoutDate = await Download.findAll({
      where: {
        status: 'completed',
      },
    });
    
    for (const download of completedWithoutDate) {
      if (!download.completedAt) {
        await download.update({ completedAt: new Date() });
        fixedCount++;
      }
    }
    
    res.json({ 
      success: true, 
      message: `Cleanup complete: removed ${removedCount} duplicates, fixed ${fixedCount} timestamps` 
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: 'Failed to cleanup downloads' });
  }
});

// Clean up orphaned downloads - downloads whose torrents no longer exist in QBittorrent
router.post('/cleanup-orphaned', async (req, res) => {
  try {
    const result = await downloadManager.cleanupOrphanedDownloads();
    res.json({
      success: true,
      message: `Cleanup complete: ${result.removed} removed, ${result.markedFailed} marked as failed`,
      ...result,
    });
  } catch (error) {
    console.error('Cleanup orphaned error:', error);
    res.status(500).json({ error: 'Failed to cleanup orphaned downloads' });
  }
});

// Reset a corrupt/incomplete download
// This removes the corrupt file and resets the download state
router.post('/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await downloadManager.resetCorruptDownload(id);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Reset download error:', error);
    res.status(500).json({ error: 'Failed to reset download' });
  }
});

// Validate a downloaded file
// Checks if the file has valid media content
router.get('/:id/validate', async (req, res) => {
  try {
    const { id } = req.params;
    
    const download = await Download.findByPk(id);
    if (!download) {
      return res.status(404).json({ error: 'Download not found' });
    }
    
    if (!download.mediaItemId) {
      return res.status(400).json({ error: 'Download has no associated media item' });
    }
    
    const result = await downloadManager.validateStorageFile(download.mediaItemId);
    res.json(result);
  } catch (error) {
    console.error('Validate download error:', error);
    res.status(500).json({ error: 'Failed to validate download' });
  }
});

// Boost priority for a specific media item (episode)
// Sets file priority to maximum so it downloads before other files
router.post('/boost-priority/:mediaItemId', async (req, res) => {
  try {
    const { mediaItemId } = req.params;
    
    const mediaItem = await MediaItem.findByPk(mediaItemId);
    if (!mediaItem) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    
    let boosted = false;
    
    // Use appropriate boost method based on media type
    if (mediaItem.type === 'tv') {
      boosted = await downloadManager.boostEpisodePriority(mediaItem);
    } else if (mediaItem.type === 'movie') {
      boosted = await downloadManager.boostMoviePriority(mediaItem);
    }
    
    if (boosted) {
      res.json({ 
        success: true, 
        message: `Priority boosted for ${mediaItem.title}${mediaItem.type === 'tv' ? ` S${mediaItem.season}E${mediaItem.episode}` : ''}` 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'Could not boost priority - no active download found or file already complete' 
      });
    }
  } catch (error) {
    console.error('Boost priority error:', error);
    res.status(500).json({ error: 'Failed to boost priority' });
  }
});

export default router;
