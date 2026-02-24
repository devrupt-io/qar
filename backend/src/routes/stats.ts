import { Router } from 'express';
import { MediaItem, Download } from '../models';
import { mediaService } from '../services/media';
import { qbittorrentService } from '../services/qbittorrent';
import { omdbService } from '../services/omdb';
import { isVpnConfigured } from './settings';
import { config } from '../config';
import { Op } from 'sequelize';

const router = Router();

// Get overall stats
router.get('/', async (req, res) => {
  try {
    // Get disk stats
    const diskStats = await mediaService.getDiskStats();
    
    // Get media counts
    const movieCount = await MediaItem.count({ where: { type: 'movie' } });
    const tvCount = await MediaItem.count({ where: { type: 'tv' } });
    const webCount = await MediaItem.count({ where: { type: 'web' } });
    
    // Get download stats
    const activeDownloads = await Download.count({
      where: { status: { [Op.in]: ['pending', 'downloading'] } },
    });
    const completedDownloads = await Download.count({
      where: { status: 'completed' },
    });
    const failedDownloads = await Download.count({
      where: { status: 'failed' },
    });
    
    // Get transfer info
    const transferInfo = await qbittorrentService.getGlobalTransferInfo();
    
    res.json({
      disks: diskStats,
      media: {
        movies: movieCount,
        tv: tvCount,
        web: webCount,
        total: movieCount + tvCount + webCount,
      },
      downloads: {
        active: activeDownloads,
        completed: completedDownloads,
        failed: failedDownloads,
      },
      transfer: transferInfo || {
        dl_info_speed: 0,
        up_info_speed: 0,
        dl_info_data: 0,
        up_info_data: 0,
      },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Get disk stats only
router.get('/disks', async (req, res) => {
  try {
    const diskStats = await mediaService.getDiskStats();
    res.json({ disks: diskStats });
  } catch (error) {
    console.error('Get disk stats error:', error);
    res.status(500).json({ error: 'Failed to get disk stats' });
  }
});

// Get library stats only
router.get('/library', async (req, res) => {
  try {
    const movieCount = await MediaItem.count({ where: { type: 'movie' } });
    const tvCount = await MediaItem.count({ where: { type: 'tv' } });
    const webCount = await MediaItem.count({ where: { type: 'web' } });
    
    // Get recent additions - limit to 3 for dashboard
    const limit = parseInt(req.query.limit as string) || 3;
    const recentItems = await MediaItem.findAll({
      order: [['createdAt', 'DESC']],
      limit,
    });
    
    res.json({
      counts: {
        movies: movieCount,
        tv: tvCount,
        web: webCount,
        total: movieCount + tvCount + webCount,
      },
      recent: recentItems,
    });
  } catch (error) {
    console.error('Get library stats error:', error);
    res.status(500).json({ error: 'Failed to get library stats' });
  }
});

// Get system status for first-time setup and health checks
router.get('/system', async (req, res) => {
  try {
    const omdbConfigured = omdbService.isConfigured();
    const vpnCredentialsConfigured = await isVpnConfigured();
    const vpnAvailable = await qbittorrentService.isAvailable();
    
    // Get disk stats
    const diskStats = await mediaService.getDiskStats();
    const hasStorage = diskStats.length > 0 && diskStats.some(d => d.freeBytes > 0);
    const hasOnlyDefaultStorage = diskStats.length === 1 && diskStats[0].name === config.paths.defaultDisk;
    
    const issues: string[] = [];
    
    if (!omdbConfigured) {
      issues.push('OMDB API key not configured - movie/TV search disabled. Get a free key at https://www.omdbapi.com/apikey.aspx');
    }
    
    // VPN status: differentiate between "not configured" and "configured but not available"
    if (!vpnCredentialsConfigured) {
      issues.push('VPN credentials not configured - downloading disabled. Enter your PIA VPN username and password in Settings.');
    } else if (!vpnAvailable) {
      issues.push('VPN configured but QBittorrent not available - it may still be starting up. Try restarting QBittorrent from Settings.');
    }
    
    if (!hasStorage) {
      issues.push('No storage configured - add disks using the host setup script.');
    }
    // Note: Default storage is a valid configuration, not a warning
    
    // Determine VPN status message
    let vpnMessage: string;
    if (vpnAvailable) {
      vpnMessage = 'VPN/QBittorrent available and connected';
    } else if (vpnCredentialsConfigured) {
      vpnMessage = 'VPN configured but QBittorrent not yet available';
    } else {
      vpnMessage = 'VPN credentials not configured';
    }
    
    res.json({
      omdb: {
        configured: omdbConfigured,
        message: omdbConfigured ? 'OMDB API key configured' : 'OMDB API key not set',
      },
      vpn: {
        configured: vpnCredentialsConfigured,
        available: vpnAvailable,
        message: vpnMessage,
      },
      storage: {
        configured: hasStorage,
        disks: diskStats.length,
        message: hasStorage ? `${diskStats.length} disk(s) available` : 'No storage configured',
      },
      issues,
      healthy: issues.length === 0,
    });
  } catch (error) {
    console.error('Get system status error:', error);
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

export default router;
