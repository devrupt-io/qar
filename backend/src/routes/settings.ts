import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Setting } from '../models';
import { qbittorrentService } from '../services/qbittorrent';
import { omdbService } from '../services/omdb';
import { dockerService } from '../services/docker';
import { openRouterService } from '../services/ai';
import { config } from '../config';

const router = Router();
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

// The auth.conf file for VPN credentials (username on line 1, password on line 2)
// This is simpler and handles special characters better than environment variables
const AUTH_CONF_PATH = path.join(config.paths.config, 'auth.conf');

// The vpn.conf file for VPN settings (PIA_REGION, PORT_FORWARDING)
// This file is read by the VPN container's startup wrapper script
const VPN_CONF_PATH = path.join(config.paths.config, 'vpn.conf');

// Helper to check if VPN credentials are configured in the database
export async function isVpnConfigured(): Promise<boolean> {
  const usernameSetting = await Setting.findOne({ where: { key: 'vpnUsername' } });
  const passwordSetting = await Setting.findOne({ where: { key: 'vpnPassword' } });
  
  const hasUsername = !!(usernameSetting && usernameSetting.value && usernameSetting.value.trim() !== '');
  const hasPassword = !!(passwordSetting && passwordSetting.value && passwordSetting.value.trim() !== '');
  
  return hasUsername && hasPassword;
}
// Helper to get the effective OMDB API key (database setting takes priority over environment)
async function getEffectiveOmdbApiKey(): Promise<string> {
  const dbSetting = await Setting.findOne({ where: { key: 'omdbApiKey' } });
  if (dbSetting && dbSetting.value) {
    return dbSetting.value;
  }
  return config.omdbApiKey;
}

// Get all settings
router.get('/', async (req, res) => {
  try {
    const settings = await Setting.findAll();
    
    const settingsMap: Record<string, string> = {};
    for (const setting of settings) {
      settingsMap[setting.key] = setting.value;
    }
    
    // Include environment-based settings if not overridden in database
    // OMDB API key: show from database if set, otherwise from environment
    if (!settingsMap.omdbApiKey && config.omdbApiKey) {
      settingsMap.omdbApiKey = config.omdbApiKey;
    }
    
    // OpenRouter settings: show from database if set, otherwise from environment
    if (!settingsMap.openrouterApiKey && process.env.OPENROUTER_API_KEY) {
      settingsMap.openrouterApiKey = process.env.OPENROUTER_API_KEY;
    }
    if (!settingsMap.openrouterModel) {
      settingsMap.openrouterModel = process.env.OPENROUTER_CHAT_MODEL || 'qwen/qwen3-8b';
    }
    
    // VPN settings: first check database, then vpn.conf file, then environment
    if (!settingsMap.vpnRegion) {
      const regionFromConf = await getRegionFromVpnConf();
      if (regionFromConf) {
        settingsMap.vpnRegion = regionFromConf;
      } else if (process.env.PIA_REGION) {
        settingsMap.vpnRegion = process.env.PIA_REGION;
      }
    }
    
    // Port forwarding defaults to enabled
    if (!settingsMap.portForwarding) {
      settingsMap.portForwarding = 'true';
    }
    
    // Include default torrent search settings if not configured (array format)
    if (!settingsMap.preferredCodecs) {
      settingsMap.preferredCodecs = JSON.stringify(config.defaults.preferredCodecs);
    }
    if (!settingsMap.preferredResolutions) {
      settingsMap.preferredResolutions = JSON.stringify(config.defaults.preferredResolutions);
    }
    if (!settingsMap.preferredMovieGroups) {
      settingsMap.preferredMovieGroups = JSON.stringify(config.defaults.preferredMovieGroups);
    }
    
    // Also include legacy single-value settings for backward compatibility
    if (!settingsMap.preferredCodec) {
      settingsMap.preferredCodec = config.defaults.preferredCodecs[0];
    }
    if (!settingsMap.preferredResolution) {
      settingsMap.preferredResolution = config.defaults.preferredResolutions[0];
    }
    if (!settingsMap.preferredMovieGroup) {
      settingsMap.preferredMovieGroup = config.defaults.preferredMovieGroups[0];
    }
    
    res.json(settingsMap);
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Get specific setting
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    const setting = await Setting.findOne({ where: { key } });
    
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    
    res.json({ key: setting.key, value: setting.value });
  } catch (error) {
    console.error('Get setting error:', error);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

// Update settings
router.put('/', async (req, res) => {
  try {
    const settings = req.body;
    
    if (typeof settings !== 'object') {
      return res.status(400).json({ error: 'Invalid settings format' });
    }
    
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value !== 'string') continue;
      
      await Setting.upsert({
        key,
        value,
      });
    }
    
    // Handle special settings
    if (settings.downloadSpeedLimit !== undefined || settings.uploadSpeedLimit !== undefined) {
      // Get the unit (defaults to MB if not specified)
      const unit = settings.speedLimitUnit || 'MB';
      const multiplier = unit === 'MB' ? 1024 * 1024 : 1024; // Convert to bytes/s for QBittorrent API
      
      const downloadLimit = parseInt(settings.downloadSpeedLimit || '0', 10) * multiplier;
      const uploadLimit = parseInt(settings.uploadSpeedLimit || '0', 10) * multiplier;
      await qbittorrentService.setSpeedLimits(downloadLimit, uploadLimit);
    }
    
    // Update OMDB API key in the service if it was changed
    if (settings.omdbApiKey !== undefined) {
      omdbService.setApiKey(settings.omdbApiKey);
    }
    
    // Update OpenRouter settings in the service if they were changed
    if (settings.openrouterApiKey !== undefined) {
      openRouterService.setApiKey(settings.openrouterApiKey);
    }
    if (settings.openrouterModel !== undefined) {
      openRouterService.setModel(settings.openrouterModel);
    }
    
    // Update VPN credentials in auth.conf file (username on line 1, password on line 2)
    // This method handles special characters better than environment variables
    if (settings.vpnUsername !== undefined || settings.vpnPassword !== undefined) {
      await updateAuthConf(settings.vpnUsername, settings.vpnPassword);
      // Reset QBittorrent availability check since VPN settings changed
      qbittorrentService.resetAvailability();
    }
    
    // Update VPN region and port forwarding in vpn.conf file
    // This file is read by the VPN container's startup wrapper script
    if (settings.vpnRegion !== undefined || settings.portForwarding !== undefined) {
      await updateVpnConf(settings.vpnRegion, settings.portForwarding);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Update specific setting
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'Value must be a string' });
    }
    
    await Setting.upsert({ key, value });
    
    res.json({ key, value });
  } catch (error) {
    console.error('Update setting error:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Get VPN status - checks both configuration and availability
router.get('/vpn/status', async (req, res) => {
  try {
    // Check if VPN credentials are configured in the database
    const configured = await isVpnConfigured();
    
    // Check if QBittorrent is accessible (implies VPN is working)
    const isAvailable = await qbittorrentService.isAvailable();
    
    if (isAvailable) {
      res.json({
        configured: true,
        available: true,
        connected: true,
        message: 'VPN connection active - QBittorrent available',
      });
    } else if (configured) {
      res.json({
        configured: true,
        available: false,
        connected: false,
        message: 'VPN credentials configured but QBittorrent not available. Try restarting QBittorrent.',
      });
    } else {
      res.json({
        configured: false,
        available: false,
        connected: false,
        message: 'VPN credentials not configured. Please enter your PIA VPN username and password in Settings.',
      });
    }
  } catch (error) {
    res.json({
      configured: false,
      available: false,
      connected: false,
      message: 'Error checking VPN status',
    });
  }
});

// The container name for the QBittorrent/VPN container
const VPN_CONTAINER_NAME = 'pia-qbittorrent';

// Restart QBittorrent container (after VPN settings change)
// Uses Docker API to restart the container. The VPN container uses a startup
// wrapper that reads configuration from bind-mounted files, so a simple restart
// is sufficient to apply any settings changes.
router.post('/vpn/restart', async (req, res) => {
  try {
    console.log('Syncing VPN settings and restarting container via Docker API...');
    
    // Reset availability cache
    qbittorrentService.resetAvailability();
    
    // Check if VPN credentials are configured
    const vpnConfigured = await isVpnConfigured();
    
    if (!vpnConfigured) {
      return res.status(400).json({
        success: false,
        message: 'VPN credentials not configured. Please save VPN settings first.',
      });
    }
    
    // Get the settings from database
    const usernameSetting = await Setting.findOne({ where: { key: 'vpnUsername' } });
    const passwordSetting = await Setting.findOne({ where: { key: 'vpnPassword' } });
    const regionSetting = await Setting.findOne({ where: { key: 'vpnRegion' } });
    const portForwardingSetting = await Setting.findOne({ where: { key: 'portForwarding' } });
    
    const newRegion = regionSetting?.value || 'Netherlands';
    const newPortForwarding = portForwardingSetting?.value || 'true';
    
    // Write credentials to auth.conf (username on line 1, password on line 2)
    await updateAuthConf(usernameSetting?.value || '', passwordSetting?.value || '');
    console.log('VPN credentials written to auth.conf');
    
    // Write region and port forwarding to vpn.conf
    // This file is read by the VPN container's startup wrapper
    await updateVpnConf(newRegion, newPortForwarding);
    console.log('VPN settings written to vpn.conf');
    
    // Check if Docker API is available
    const dockerAvailable = await dockerService.isDockerAvailable();
    if (!dockerAvailable) {
      return res.json({
        success: false,
        message: 'Docker API not available. Settings saved but container cannot be restarted automatically. Please restart the pia-qbittorrent container manually.',
        needsRestart: true,
      });
    }
    
    // Restart the container using Docker API
    // The startup wrapper will read the updated config files on restart
    const restartResult = await dockerService.restartVpnContainer();
    
    res.json({
      success: restartResult.success,
      message: restartResult.message,
      needsRestart: !restartResult.success,
      data: restartResult.data,
    });
  } catch (error: any) {
    console.error('VPN restart error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to process VPN restart request',
      message: error.message,
    });
  }
});

// Interface for PIA VPN region
interface VpnRegion {
  id: string;
  name: string;
  country: string;
  portForward: boolean;
}

// Cached VPN regions with timestamp
let cachedRegions: VpnRegion[] | null = null;
let regionsCacheTime: number = 0;
const REGIONS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Get available VPN regions from PIA server list
router.get('/vpn/regions', async (req, res) => {
  try {
    // Return cached regions if still valid
    if (cachedRegions && Date.now() - regionsCacheTime < REGIONS_CACHE_TTL) {
      return res.json(cachedRegions);
    }
    
    console.log('Fetching VPN regions from PIA server list...');
    const response = await fetch('https://serverlist.piaservers.net/vpninfo/servers/v6');
    
    if (!response.ok) {
      throw new Error(`Failed to fetch regions: ${response.status}`);
    }
    
    // The response format is: JSON content followed by newline and base64 signature
    // We need to extract just the JSON part
    const text = await response.text();
    const jsonEndIndex = text.lastIndexOf(']}');
    if (jsonEndIndex === -1) {
      throw new Error('Invalid response format: cannot find JSON end');
    }
    const jsonText = text.substring(0, jsonEndIndex + 2);
    const data = JSON.parse(jsonText) as { regions: Array<{ id: string; name: string; country: string; port_forward: boolean; offline: boolean }> };
    
    // Extract regions and sort by name
    const regions: VpnRegion[] = data.regions
      .filter((r) => !r.offline)
      .map((r) => ({
        id: r.id,
        name: r.name,
        country: r.country,
        portForward: r.port_forward === true,
      }))
      .sort((a: VpnRegion, b: VpnRegion) => a.name.localeCompare(b.name));
    
    // Cache the results
    cachedRegions = regions;
    regionsCacheTime = Date.now();
    
    res.json(regions);
  } catch (error: any) {
    console.error('Failed to fetch VPN regions:', error);
    
    // Return cached regions if available, even if stale
    if (cachedRegions) {
      return res.json(cachedRegions);
    }
    
    // Return a fallback list if we can't fetch regions
    res.json([
      { id: 'nl_amsterdam', name: 'Netherlands', country: 'NL', portForward: true },
      { id: 'swiss', name: 'Switzerland', country: 'CH', portForward: true },
      { id: 'sweden', name: 'SE Stockholm', country: 'SE', portForward: true },
      { id: 'de-frankfurt', name: 'DE Frankfurt', country: 'DE', portForward: true },
      { id: 'de-berlin', name: 'DE Berlin', country: 'DE', portForward: true },
      { id: 'france', name: 'France', country: 'FR', portForward: true },
      { id: 'uk', name: 'UK London', country: 'GB', portForward: true },
      { id: 'us-newjersey', name: 'US East', country: 'US', portForward: false },
      { id: 'us3', name: 'US West', country: 'US', portForward: false },
      { id: 'ca', name: 'CA Montreal', country: 'CA', portForward: true },
      { id: 'japan', name: 'JP Tokyo', country: 'JP', portForward: true },
    ]);
  }
});

// Helper to read vpnRegion from vpn.conf file
async function getRegionFromVpnConf(): Promise<string | null> {
  try {
    const content = await readFile(VPN_CONF_PATH, 'utf8');
    for (const line of content.split('\n')) {
      if (line.startsWith('PIA_REGION=')) {
        return line.split('=')[1].trim();
      }
    }
  } catch {
    // File doesn't exist, return null
  }
  return null;
}

// Helper to update auth.conf file (username on line 1, password on line 2)
// This is the preferred method for j4ym0/pia-qbittorrent as it handles special characters
async function updateAuthConf(username?: string, password?: string): Promise<void> {
  await mkdir(path.dirname(AUTH_CONF_PATH), { recursive: true });
  
  // Read existing values if only one is provided
  let finalUsername = username || '';
  let finalPassword = password || '';
  
  try {
    const existing = await readFile(AUTH_CONF_PATH, 'utf8');
    const lines = existing.trim().split('\n');
    if (!username && lines[0]) finalUsername = lines[0];
    if (!password && lines[1]) finalPassword = lines[1];
  } catch {
    // File doesn't exist yet, that's fine
  }
  
  const content = `${finalUsername}\n${finalPassword}\n`;
  await writeFile(AUTH_CONF_PATH, content, { mode: 0o600 });
}

// Helper to update vpn.conf file for region and port forwarding settings
// This file is read by the VPN container's startup wrapper script (vpn-startup.sh)
async function updateVpnConf(region?: string, portForwarding?: string): Promise<void> {
  await mkdir(path.dirname(VPN_CONF_PATH), { recursive: true });
  
  // Read existing values if only some are provided
  let finalRegion = region || 'Netherlands';
  let finalPortForwarding = portForwarding || 'true';
  
  try {
    const existing = await readFile(VPN_CONF_PATH, 'utf8');
    // Parse existing values
    for (const line of existing.split('\n')) {
      if (line.startsWith('PIA_REGION=') && !region) {
        finalRegion = line.split('=')[1];
      }
      if (line.startsWith('PORT_FORWARDING=') && !portForwarding) {
        finalPortForwarding = line.split('=')[1];
      }
    }
  } catch {
    // File doesn't exist yet, that's fine
  }
  
  const content = `# VPN Configuration for Qar
# This file is read by the VPN container at startup
# Changes to this file require a container restart to take effect

# PIA VPN Region
PIA_REGION=${finalRegion}

# Enable port forwarding for better download speeds (true/false)
PORT_FORWARDING=${finalPortForwarding}
`;
  
  await writeFile(VPN_CONF_PATH, content, { mode: 0o644 });
}

export default router;
