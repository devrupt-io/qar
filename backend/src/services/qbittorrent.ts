import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { Download, MediaItem } from '../models';

export interface QBittorrentTorrent {
  hash: string;
  name: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  state: string;
  size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  save_path: string;
  content_path: string; // The actual path where files are downloaded (may differ from save_path + name)
}

export interface QBittorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number; // 0 = don't download, 1 = normal, 6 = high, 7 = maximum
  is_seed: boolean;
  piece_range: number[];
  availability: number;
}

export class QBittorrentService {
  private client: AxiosInstance;
  private sid: string | null = null;
  private available: boolean | null = null;
  private lastAvailabilityCheck: number = 0;
  private readonly AVAILABILITY_CACHE_MS = 30000; // Cache availability for 30 seconds
  
  // Flag to track if we can use the API without authentication
  // (when subnet whitelist is enabled in QBittorrent)
  private authBypassEnabled: boolean | null = null;
  private isBanned: boolean = false;
  private banResetTime: number = 0;

  constructor() {
    this.client = axios.create({
      baseURL: config.qbittorrentUrl,
      timeout: 10000,
    });
  }

  // Check if QBittorrent is available (VPN may not be configured)
  // Caches the result to avoid spamming the QBittorrent API
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    
    // Use cached result if recent enough
    if (this.available !== null && (now - this.lastAvailabilityCheck) < this.AVAILABILITY_CACHE_MS) {
      return this.available;
    }
    
    try {
      // Try to get version - this endpoint works with subnet whitelist bypass
      const response = await this.client.get('/api/v2/app/version', { timeout: 5000 });
      
      // If we get here without auth, subnet whitelist bypass is working
      this.authBypassEnabled = true;
      this.available = true;
      this.lastAvailabilityCheck = now;
      this.isBanned = false;
      return true;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        // 403 Forbidden means QBittorrent is available but needs authentication
        // This could be because:
        // 1. Subnet whitelist is not configured
        // 2. We're banned from too many failed login attempts
        if (error.response?.status === 403) {
          const responseData = error.response?.data;
          
          // Check if we're IP banned
          if (typeof responseData === 'string' && responseData.includes('banned')) {
            if (!this.isBanned) {
              console.warn('QBittorrent: IP is banned due to too many failed authentication attempts');
              console.warn('QBittorrent: The ban will typically expire in 1 hour, or restart the container');
            }
            this.isBanned = true;
            this.banResetTime = now + 3600000; // Ban typically lasts 1 hour
            // Still mark as available - it's running, just we're banned
            this.available = true;
            this.authBypassEnabled = false;
            this.lastAvailabilityCheck = now;
            return true;
          }
          
          // Not banned, just needs auth
          this.authBypassEnabled = false;
          this.available = true;
          this.lastAvailabilityCheck = now;
          return true;
        }
      }
      
      // Only log on transition from available to unavailable, or first check
      if (this.available !== false) {
        console.warn('QBittorrent is not available (VPN may not be configured or container not running)');
      }
      this.available = false;
      this.lastAvailabilityCheck = now;
      return false;
    }
  }

  // Force a fresh availability check (bypasses cache)
  async checkAvailabilityNow(): Promise<boolean> {
    this.available = null;
    this.lastAvailabilityCheck = 0;
    return this.isAvailable();
  }

  // Reset availability check (call after VPN config changes)
  resetAvailability(): void {
    this.available = null;
    this.lastAvailabilityCheck = 0;
    this.sid = null;
    this.authBypassEnabled = null;
    this.isBanned = false;
  }

  private async ensureAuth(): Promise<boolean> {
    if (!(await this.isAvailable())) {
      return false;
    }
    
    // If we're banned, don't try to authenticate
    if (this.isBanned) {
      const now = Date.now();
      if (now < this.banResetTime) {
        // Still banned, but check if auth bypass is working
        if (this.authBypassEnabled) {
          return true;
        }
        return false;
      }
      // Ban should have expired, reset and try again
      this.isBanned = false;
    }
    
    // If subnet whitelist bypass is enabled, we don't need a session cookie
    if (this.authBypassEnabled === true) {
      return true;
    }
    
    // If we already have a session, use it
    if (this.sid) {
      return true;
    }

    // Try to authenticate
    // Note: With the subnet whitelist enabled in QBittorrent, we shouldn't
    // reach this point. But if we do, try to log in.
    try {
      const response = await this.client.post('/api/v2/auth/login', 
        'username=admin&password=adminadmin',
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const cookie = response.headers['set-cookie'];
      if (cookie) {
        const sidMatch = cookie[0].match(/SID=([^;]+)/);
        if (sidMatch) {
          this.sid = sidMatch[1];
          return true;
        }
      }
      
      // Check if login was successful based on response
      // QBittorrent returns "Ok." on success, "Fails." on failure
      if (response.data === 'Ok.') {
        return true;
      }
      
      console.warn('QBittorrent: Login failed - incorrect credentials');
      return false;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        if (typeof responseData === 'string' && responseData.includes('banned')) {
          console.warn('QBittorrent: IP is banned due to too many failed authentication attempts');
          this.isBanned = true;
          this.banResetTime = Date.now() + 3600000;
        } else {
          console.warn('QBittorrent auth error:', error.message);
        }
      } else {
        console.error('QBittorrent auth error:', error);
      }
      return false;
    }
  }

  // Get headers for API requests (includes session cookie if available)
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    
    // Only include cookie if we have one and auth bypass is not enabled
    if (this.sid && !this.authBypassEnabled) {
      headers['Cookie'] = `SID=${this.sid}`;
    }
    
    return headers;
  }

  async addTorrent(magnetUri: string, savePath?: string): Promise<string | null> {
    if (!(await this.ensureAuth())) {
      console.warn('Cannot add torrent: QBittorrent not available or not authenticated');
      return null;
    }

    try {
      const formData = new URLSearchParams();
      formData.append('urls', magnetUri);
      if (savePath) {
        formData.append('savepath', savePath);
      }
      formData.append('autoTMM', 'false');

      await this.client.post('/api/v2/torrents/add', formData.toString(), {
        headers: this.getHeaders(),
      });

      // Extract hash from magnet URI
      const hashMatch = magnetUri.match(/btih:([a-fA-F0-9]+)/);
      return hashMatch ? hashMatch[1].toLowerCase() : null;
    } catch (error) {
      console.error('Add torrent error:', error);
      return null;
    }
  }

  async getTorrents(): Promise<QBittorrentTorrent[]> {
    if (!(await this.ensureAuth())) {
      return [];
    }

    try {
      const response = await this.client.get('/api/v2/torrents/info', {
        headers: this.getHeaders(),
      });

      return response.data;
    } catch (error) {
      console.error('Get torrents error:', error);
      return [];
    }
  }

  async getTorrent(hash: string): Promise<QBittorrentTorrent | null> {
    const torrents = await this.getTorrents();
    return torrents.find(t => t.hash.toLowerCase() === hash.toLowerCase()) || null;
  }

  async pauseTorrent(hash: string): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post('/api/v2/torrents/pause', `hashes=${hash}`, {
        headers: this.getHeaders(),
      });
      return true;
    } catch (error) {
      console.error('Pause torrent error:', error);
      return false;
    }
  }

  async resumeTorrent(hash: string): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post('/api/v2/torrents/resume', `hashes=${hash}`, {
        headers: this.getHeaders(),
      });
      return true;
    } catch (error) {
      console.error('Resume torrent error:', error);
      return false;
    }
  }

  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/delete',
        `hashes=${hash}&deleteFiles=${deleteFiles}`,
        {
          headers: this.getHeaders(),
        }
      );
      return true;
    } catch (error) {
      console.error('Delete torrent error:', error);
      return false;
    }
  }

  async getGlobalTransferInfo(): Promise<any> {
    if (!(await this.ensureAuth())) {
      return null;
    }

    try {
      const response = await this.client.get('/api/v2/transfer/info', {
        headers: this.getHeaders(),
      });
      return response.data;
    } catch (error) {
      console.error('Get transfer info error:', error);
      return null;
    }
  }

  async setSpeedLimits(downloadLimit: number, uploadLimit: number): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/transfer/setDownloadLimit',
        `limit=${downloadLimit}`,
        {
          headers: this.getHeaders(),
        }
      );

      await this.client.post(
        '/api/v2/transfer/setUploadLimit',
        `limit=${uploadLimit}`,
        {
          headers: this.getHeaders(),
        }
      );

      return true;
    } catch (error) {
      console.error('Set speed limits error:', error);
      return false;
    }
  }

  // Sync downloads with database
  async syncDownloads(): Promise<void> {
    const torrents = await this.getTorrents();
    
    for (const torrent of torrents) {
      const download = await Download.findOne({
        where: { torrentHash: torrent.hash },
      });

      if (download) {
        let status = download.status;
        
        if (torrent.progress >= 1) {
          status = 'completed';
        } else if (torrent.state === 'pausedDL' || torrent.state === 'pausedUP') {
          status = 'paused';
        } else if (torrent.state === 'error') {
          status = 'failed';
        } else {
          status = 'downloading';
        }

        await download.update({
          progress: torrent.progress * 100,
          downloadSpeed: torrent.dlspeed,
          eta: torrent.eta,
          status,
        });
      }
    }
  }

  /**
   * Get the list of files in a torrent.
   */
  async getTorrentFiles(hash: string): Promise<QBittorrentFile[]> {
    if (!(await this.ensureAuth())) {
      return [];
    }

    try {
      const response = await this.client.get('/api/v2/torrents/files', {
        params: { hash },
        headers: this.getHeaders(),
      });
      return response.data;
    } catch (error) {
      console.error('Get torrent files error:', error);
      return [];
    }
  }

  /**
   * Set file priorities in a torrent.
   * @param hash - Torrent hash
   * @param fileIds - Array of file indices (0-based)
   * @param priority - 0 = don't download, 1 = normal, 6 = high, 7 = maximum
   */
  async setFilePriority(hash: string, fileIds: number[], priority: number): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/filePrio',
        `hash=${hash}&id=${fileIds.join('|')}&priority=${priority}`,
        {
          headers: this.getHeaders(),
        }
      );
      return true;
    } catch (error) {
      console.error('Set file priority error:', error);
      return false;
    }
  }

  /**
   * Set torrent queue priority to highest (first in queue).
   * This makes the torrent download before others.
   * @param hash - Torrent hash
   */
  async setTopPriority(hash: string): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/topPrio',
        `hashes=${hash}`,
        {
          headers: this.getHeaders(),
        }
      );
      console.log(`[QBittorrent] Set torrent ${hash} to top priority`);
      return true;
    } catch (error) {
      console.error('Set top priority error:', error);
      return false;
    }
  }

  /**
   * Enable first/last piece priority for a torrent.
   * This helps start playback sooner for streaming.
   * @param hash - Torrent hash
   */
  async setFirstLastPiecePriority(hash: string): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/setFirstLastPiecePrio',
        `hashes=${hash}`,
        {
          headers: this.getHeaders(),
        }
      );
      console.log(`[QBittorrent] Enabled first/last piece priority for ${hash}`);
      return true;
    } catch (error) {
      console.error('Set first/last piece priority error:', error);
      return false;
    }
  }

  /**
   * Force resume a paused or queued torrent.
   * This bypasses queue limits and starts downloading immediately.
   * @param hash - Torrent hash
   */
  async forceResume(hash: string): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/setForceStart',
        `hashes=${hash}&value=true`,
        {
          headers: this.getHeaders(),
        }
      );
      console.log(`[QBittorrent] Force started torrent ${hash}`);
      return true;
    } catch (error) {
      console.error('Force resume error:', error);
      return false;
    }
  }

  /**
   * Enable or disable sequential download for a torrent.
   * When enabled, files are downloaded in order (first to last piece).
   * This is useful for streaming/playback as earlier parts are ready sooner.
   * @param hash - Torrent hash
   * @param enable - Whether to enable sequential download
   */
  async setSequentialDownload(hash: string, enable: boolean): Promise<boolean> {
    if (!(await this.ensureAuth())) {
      return false;
    }

    try {
      await this.client.post(
        '/api/v2/torrents/toggleSequentialDownload',
        `hashes=${hash}`,
        {
          headers: this.getHeaders(),
        }
      );
      console.log(`[QBittorrent] Toggled sequential download for ${hash}`);
      return true;
    } catch (error) {
      console.error('Set sequential download error:', error);
      return false;
    }
  }
}

export const qbittorrentService = new QBittorrentService();
