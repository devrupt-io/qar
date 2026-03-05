import { Router } from 'express';
import { jellyfinService } from '../services/jellyfin';
import { config } from '../config';
import { Setting } from '../models';

const router = Router();

// Get Jellyfin status
router.get('/status', async (req, res) => {
  try {
    const status = await jellyfinService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Jellyfin status error:', error);
    res.status(500).json({ error: 'Failed to get Jellyfin status' });
  }
});

// Helper to get the Jellyfin base URL for external (client-facing) URLs.
// Returns localhost:8096 — the frontend replaces the hostname when needed
// since the backend cannot reliably determine the client's hostname
// (requests are proxied through Next.js).
function getExternalJellyfinUrl(): string {
  return 'http://localhost:8096';
}

// Fallback redirect endpoint - redirects to Jellyfin-hosted login page
// The actual login page is mounted at /jellyfin/jellyfin-web/qar-login.html
// and is served by Jellyfin at http://localhost:8096/web/qar-login.html
router.get('/redirect', async (req, res) => {
  const { token, userId } = req.query;
  const jellyfinBase = getExternalJellyfinUrl();
  
  // Redirect to the Jellyfin-hosted qar-login.html page
  let redirectUrl = `${jellyfinBase}/web/qar-login.html`;
  if (token) {
    redirectUrl += `?token=${encodeURIComponent(token as string)}`;
    if (userId) {
      redirectUrl += `&userId=${encodeURIComponent(userId as string)}`;
    }
  }
  
  res.redirect(redirectUrl);
});

// Auto-setup Jellyfin
router.post('/setup', async (req, res) => {
  try {
    const result = await jellyfinService.autoSetup();
    res.json(result);
  } catch (error: any) {
    console.error('Jellyfin setup error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get access token and redirect URL for Jellyfin
router.get('/token', async (req, res) => {
  try {
    const token = await jellyfinService.getAccessToken();
    const jellyfinBase = getExternalJellyfinUrl();
    
    // Also get the userId and serverId
    const userIdSetting = await Setting.findOne({ where: { key: 'jellyfinUserId' } });
    const userId = userIdSetting?.value || '';
    
    // Get the actual server ID from Jellyfin
    const serverId = await jellyfinService.getServerId();
    const serverName = await jellyfinService.getServerName();
    
    if (token && serverId) {
      // Build the redirect URL to the Jellyfin-hosted qar-login.html page
      // This page is mounted into Jellyfin's web directory and runs on Jellyfin's origin
      // so it can properly set localStorage credentials for automatic login
      const redirectUrl = `${jellyfinBase}/web/qar-login.html?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}&serverId=${encodeURIComponent(serverId)}&serverName=${encodeURIComponent(serverName || 'Qar Media Server')}`;
      
      res.json({ 
        token, 
        userId,
        serverId,
        serverName,
        jellyfinUrl: jellyfinBase,
        redirectUrl
      });
    } else if (token) {
      // Have token but no server ID - fallback
      const redirectUrl = `${jellyfinBase}/web/qar-login.html?token=${encodeURIComponent(token)}&userId=${encodeURIComponent(userId)}`;
      
      res.json({ 
        token, 
        userId,
        jellyfinUrl: jellyfinBase,
        redirectUrl
      });
    } else {
      res.status(404).json({ error: 'No access token available' });
    }
  } catch (error) {
    console.error('Jellyfin token error:', error);
    res.status(500).json({ error: 'Failed to get access token' });
  }
});

// Refresh Jellyfin libraries
router.post('/refresh-libraries', async (req, res) => {
  try {
    await jellyfinService.setupLibraries();
    res.json({ success: true, message: 'Libraries refreshed' });
  } catch (error: any) {
    console.error('Jellyfin library refresh error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get watch URL for a specific media item
// Returns Jellyfin URLs for both the details page and direct play
router.get('/watch-url', async (req, res) => {
  try {
    const { title, type, season, episode } = req.query;
    
    if (!title || !type) {
      return res.status(400).json({ error: 'title and type are required' });
    }
    
    const mediaType = type as 'movie' | 'tv' | 'web';
    const seasonNum = season ? parseInt(season as string, 10) : undefined;
    const episodeNum = episode ? parseInt(episode as string, 10) : undefined;
    
    const result = await jellyfinService.getWatchUrl(
      title as string, 
      mediaType, 
      seasonNum, 
      episodeNum,
      getExternalJellyfinUrl()
    );
    
    if (!result) {
      // Item not found in Jellyfin - return fallback URL
      return res.json({
        found: false,
        fallbackUrl: getExternalJellyfinUrl(),
        message: 'Item not found in Jellyfin library. It may need a library refresh.',
      });
    }
    
    res.json({
      found: true,
      ...result,
    });
  } catch (error: any) {
    console.error('Get watch URL error:', error);
    res.status(500).json({ error: 'Failed to get watch URL' });
  }
});

export default router;
