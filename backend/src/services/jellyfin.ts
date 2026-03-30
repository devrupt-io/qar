import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import { Setting } from '../models';

export interface JellyfinUser {
  Id: string;
  Name: string;
  ServerId: string;
  HasPassword: boolean;
  HasConfiguredPassword: boolean;
  HasConfiguredEasyPassword: boolean;
}

export interface JellyfinAuthResult {
  User: JellyfinUser;
  AccessToken: string;
  ServerId: string;
}

export interface JellyfinLibrary {
  Name: string;
  CollectionType: string;
  ItemId: string;
  RefreshStatus: string;
}

/**
 * Extracts a concise error message from an Axios error or generic error.
 * Avoids logging verbose stack traces and internal axios details.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const data = error.response?.data;
    
    // Try to get a meaningful message from the response
    let message = '';
    if (typeof data === 'string') {
      message = data;
    } else if (data?.message) {
      message = data.message;
    } else if (data?.Message) {
      message = data.Message;
    } else if (data?.error) {
      message = data.error;
    }
    
    if (status) {
      return `HTTP ${status}${statusText ? ` ${statusText}` : ''}${message ? `: ${message}` : ''}`;
    }
    
    // Network error (no response)
    if (error.code === 'ECONNREFUSED') {
      return 'Connection refused - Jellyfin may not be running';
    }
    if (error.code === 'ETIMEDOUT') {
      return 'Connection timed out';
    }
    if (error.code) {
      return `Network error: ${error.code}`;
    }
    
    return error.message || 'Unknown axios error';
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return String(error);
}

export class JellyfinService {
  private baseUrl: string;
  private client: AxiosInstance;
  private adminToken: string | null = null;
  private adminUserId: string | null = null;
  private setupComplete: boolean = false;

  // Default credentials for auto-setup
  private readonly DEFAULT_USERNAME = 'qar';
  private readonly DEFAULT_PASSWORD = 'qar';
  
  // Client identification for Jellyfin API
  private readonly CLIENT_NAME = 'Qar';
  private readonly CLIENT_VERSION = '1.0.0';
  private readonly DEVICE_NAME = 'Qar Backend';
  private readonly DEVICE_ID = 'qar-backend-001';

  constructor() {
    this.baseUrl = config.jellyfinUrl;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000, // 10 second timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Get the X-Emby-Authorization header required by Jellyfin.
   * This header identifies the client application.
   */
  private getAuthorizationHeader(token?: string): string {
    let auth = `MediaBrowser Client="${this.CLIENT_NAME}", Device="${this.DEVICE_NAME}", DeviceId="${this.DEVICE_ID}", Version="${this.CLIENT_VERSION}"`;
    if (token) {
      auth += `, Token="${token}"`;
    }
    return auth;
  }

  /**
   * Set the Jellyfin server name via the System/Configuration API.
   */
  async setServerName(name: string): Promise<void> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot set server name: no authentication token');
        return;
      }
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      // Get current configuration
      const configResponse = await this.client.get('/System/Configuration', { headers });
      const currentConfig = configResponse.data;

      // Update the server name
      currentConfig.ServerName = name;

      await this.client.post('/System/Configuration', currentConfig, { headers });
      console.log(`Jellyfin server name set to: ${name}`);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to set Jellyfin server name:', message);
    }
  }

  /**
   * Check if Jellyfin server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.client.get('/System/Info/Public');
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the Jellyfin server ID
   */
  async getServerId(): Promise<string | null> {
    try {
      const response = await this.client.get('/System/Info/Public');
      return response.data?.Id || null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get the Jellyfin server name
   */
  async getServerName(): Promise<string | null> {
    try {
      const response = await this.client.get('/System/Info/Public');
      return response.data?.ServerName || 'Qar Media Server';
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if Jellyfin has been set up (has at least one user)
   */
  async isSetUp(): Promise<boolean> {
    try {
      const response = await this.client.get('/Startup/Configuration');
      // If we can access startup config, wizard is still pending
      return false;
    } catch (error: any) {
      // 401/403 means server is already configured
      if (error.response?.status === 401 || error.response?.status === 403) {
        return true;
      }
      // Check if it's a "first time setup" type error
      return false;
    }
  }

  /**
   * Check if setup has been completed successfully
   */
  isSetupComplete(): boolean {
    return this.setupComplete;
  }

  /**
   * Mark setup as complete
   */
  markSetupComplete(): void {
    this.setupComplete = true;
  }

  /**
   * Complete the Jellyfin setup wizard automatically
   */
  async autoSetup(): Promise<{ success: boolean; message: string }> {
    try {
      // Check if already set up
      const setupComplete = await this.isSetUp();
      if (setupComplete) {
        // Try to authenticate with default credentials
        const auth = await this.authenticate(this.DEFAULT_USERNAME, this.DEFAULT_PASSWORD);
        if (auth) {
          this.setupComplete = true;
          return { success: true, message: 'Jellyfin is already configured' };
        }
        return { success: false, message: 'Jellyfin is configured but credentials are different' };
      }

      console.log('Starting Jellyfin auto-setup...');

      const headers = {
        'X-Emby-Authorization': this.getAuthorizationHeader(),
      };

      // Step 1: Get startup configuration
      await this.client.get('/Startup/Configuration', { headers });

      // Step 2: Set startup configuration (language, metadata, etc.)
      await this.client.post('/Startup/Configuration', {
        UICulture: 'en-US',
        MetadataCountryCode: 'US',
        PreferredMetadataLanguage: 'en',
      }, { headers });

      // Step 3: Get first user configuration
      await this.client.get('/Startup/User', { headers });

      // Step 4: Create admin user
      await this.client.post('/Startup/User', {
        Name: this.DEFAULT_USERNAME,
        Password: this.DEFAULT_PASSWORD,
      }, { headers });

      // Step 5: Configure remote access (allow all) — may fail on newer Jellyfin versions
      try {
        await this.client.post('/Startup/RemoteAccess', {
          EnableRemoteAccess: true,
          EnableAutomaticPortMapping: false,
        }, { headers });
      } catch (e: unknown) {
        console.warn('Jellyfin RemoteAccess setup step failed (non-critical):', getErrorMessage(e));
      }

      // Step 6: Complete startup
      await this.client.post('/Startup/Complete', {}, { headers });

      console.log('Jellyfin auto-setup complete');

      // Step 7: Set server name to "Qar"
      await this.setServerName('Qar');

      // Now authenticate to get admin token
      await this.authenticate(this.DEFAULT_USERNAME, this.DEFAULT_PASSWORD);

      // Setup media libraries
      await this.setupLibraries();

      this.setupComplete = true;
      return { success: true, message: 'Jellyfin setup completed successfully' };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Jellyfin auto-setup error:', message);
      return { success: false, message };
    }
  }

  /**
   * Authenticate with Jellyfin and get an access token
   */
  async authenticate(username: string, password: string): Promise<JellyfinAuthResult | null> {
    try {
      const response = await this.client.post<JellyfinAuthResult>(
        '/Users/AuthenticateByName',
        {
          Username: username,
          Pw: password,
        },
        {
          headers: {
            'X-Emby-Authorization': this.getAuthorizationHeader(),
          },
        }
      );

      this.adminToken = response.data.AccessToken;
      this.adminUserId = response.data.User.Id;

      // Store token in database for persistence
      await Setting.upsert({ key: 'jellyfinToken', value: this.adminToken });
      await Setting.upsert({ key: 'jellyfinUserId', value: this.adminUserId });

      return response.data;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Jellyfin authentication failed:', message);
      return null;
    }
  }

  /**
   * Get a fresh access token for a user session
   */
  async getAccessToken(): Promise<string | null> {
    // First check if we have a stored token
    if (!this.adminToken) {
      const tokenSetting = await Setting.findOne({ where: { key: 'jellyfinToken' } });
      if (tokenSetting) {
        this.adminToken = tokenSetting.value;
      }
    }

    // Validate token is still valid
    if (this.adminToken) {
      try {
        const response = await this.client.get('/Users/Me', {
          headers: {
            'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken),
          },
        });
        if (response.status === 200) {
          return this.adminToken;
        }
      } catch (error) {
        // Token invalid, try to re-authenticate
        this.adminToken = null;
      }
    }

    // Try to authenticate with default credentials
    const auth = await this.authenticate(this.DEFAULT_USERNAME, this.DEFAULT_PASSWORD);
    return auth?.AccessToken || null;
  }

  /**
   * Setup media libraries pointing to /media directory
   * Called during initial setup to create all libraries.
   * Also updates existing libraries if their names don't match.
   */
  async setupLibraries(): Promise<void> {
    if (!this.adminToken) {
      throw new Error('Not authenticated');
    }

    const headers = { 
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken),
    };

    try {
      // Get existing libraries
      const librariesResponse = await this.client.get('/Library/VirtualFolders', { headers });
      const existingLibraries = librariesResponse.data as JellyfinLibrary[];

      const mediaBase = config.paths.jellyfinMediaPath;
      const librariesToCreate = [
        { name: 'Movies', type: 'movies', path: `${mediaBase}/movies` },
        { name: 'TV', type: 'tvshows', path: `${mediaBase}/tv` },
        { name: 'Web', type: 'homevideos', path: `${mediaBase}/web` },
      ];

      for (const lib of librariesToCreate) {
        // Check if library exists by collection type
        const existingByType = existingLibraries.find(
          (l) => l.CollectionType === lib.type
        );
        
        const existingByName = existingLibraries.find(
          (l) => l.Name === lib.name
        );

        if (existingByType && existingByType.Name !== lib.name) {
          // Library exists but with wrong name - rename it
          try {
            await this.client.post(
              '/Library/VirtualFolders/Name',
              {},
              { 
                headers,
                params: { 
                  name: existingByType.Name,
                  newName: lib.name,
                }
              }
            );
            console.log(`Renamed Jellyfin library: ${existingByType.Name} -> ${lib.name}`);
          } catch (error: unknown) {
            const message = getErrorMessage(error);
            console.error(`Failed to rename library ${existingByType.Name}:`, message);
          }
        } else if (!existingByType && !existingByName) {
          // Library doesn't exist - create it
          try {
            // Jellyfin's VirtualFolders API uses query params for name/type
            // and body for paths and library options
            await this.client.post(
              '/Library/VirtualFolders',
              {
                LibraryOptions: {
                  EnablePhotos: false,
                  EnableRealtimeMonitor: true,
                  EnableChapterImageExtraction: false,
                  ExtractChapterImagesDuringLibraryScan: false,
                  SaveLocalMetadata: false,
                  EnableInternetProviders: true,
                },
              },
              { 
                headers,
                params: { 
                  name: lib.name,
                  collectionType: lib.type,
                  paths: lib.path,
                  refreshLibrary: false,
                }
              }
            );
            console.log(`Created Jellyfin library: ${lib.name}`);
          } catch (error: unknown) {
            const message = getErrorMessage(error);
            console.error(`Failed to create library ${lib.name}:`, message);
          }
        } else {
          console.log(`Jellyfin library ${lib.name} already configured`);
        }
      }

      // Trigger library scan
      await this.client.post('/Library/Refresh', {}, { headers });
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to setup libraries:', message);
    }
  }

  /**
   * Ensure libraries exist - can be called anytime to verify/create libraries.
   * Also ensures the server name is set to "Qar".
   */
  async ensureLibraries(): Promise<void> {
    // Make sure we have authentication
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot ensure libraries: no authentication token');
        return;
      }
    }

    // Ensure server name is set to Qar
    await this.setServerName('Qar');

    await this.setupLibraries();
  }

  /**
   * Find a Jellyfin library item by its file path.
   * Used to get the Jellyfin item ID for refreshing after .strm file updates.
   * 
   * @param filePath - The path to search for (e.g., /media/movies/Title (Year)/Title (Year).strm)
   * @returns The Jellyfin item ID if found, null otherwise
   */
  async findItemByPath(filePath: string): Promise<string | null> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot find item: no authentication token');
        return null;
      }
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      // Search for items by path - Jellyfin indexes files by their path
      const response = await this.client.get('/Items', {
        headers,
        params: {
          fields: 'Path',
          path: filePath,
          recursive: true,
        },
      });

      if (response.data?.Items?.length > 0) {
        return response.data.Items[0].Id;
      }

      // If direct path search fails, try searching by name
      const pathParts = filePath.split('/');
      const fileName = pathParts[pathParts.length - 1].replace(/\.(strm|mp4|mkv)$/, '');
      
      const searchResponse = await this.client.get('/Items', {
        headers,
        params: {
          searchTerm: fileName,
          recursive: true,
          limit: 10,
        },
      });

      if (searchResponse.data?.Items?.length > 0) {
        // Return the first matching item
        return searchResponse.data.Items[0].Id;
      }

      return null;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to find Jellyfin item by path:', message);
      return null;
    }
  }

  /**
   * Refresh a specific Jellyfin library item's metadata.
   * This is called after updating a .strm file to point to a direct file path,
   * so Jellyfin re-scans the item and picks up the new media source.
   * 
   * @param itemId - The Jellyfin item ID to refresh
   * @returns true if refresh was queued successfully
   */
  async refreshItem(itemId: string): Promise<boolean> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot refresh item: no authentication token');
        return false;
      }
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      await this.client.post(`/Items/${itemId}/Refresh`, {}, {
        headers,
        params: {
          metadataRefreshMode: 'Default',
          imageRefreshMode: 'None',
          replaceAllMetadata: false,
          replaceAllImages: false,
        },
      });
      
      console.log(`Jellyfin item refresh queued: ${itemId}`);
      return true;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to refresh Jellyfin item:', message);
      return false;
    }
  }

  /**
   * Refresh a Jellyfin item by searching for it using the .strm file path.
   * Combines findItemByPath and refreshItem into a single convenience method.
   * 
   * @param strmFilePath - Path to the .strm file
   * @returns true if the item was found and refresh was queued
   */
  async refreshItemByPath(strmFilePath: string): Promise<boolean> {
    const itemId = await this.findItemByPath(strmFilePath);
    if (!itemId) {
      console.log(`Could not find Jellyfin item for path: ${strmFilePath}`);
      return false;
    }
    return this.refreshItem(itemId);
  }

  /**
   * Trigger a full library scan in Jellyfin.
   * This ensures newly downloaded files are picked up.
   */
  async scanLibrary(): Promise<boolean> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot scan library: no authentication token');
        return false;
      }
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      await this.client.post('/Library/Refresh', {}, { headers });
      console.log('Jellyfin library scan triggered');
      return true;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to trigger Jellyfin library scan:', message);
      return false;
    }
  }

  /**
   * Delete a Jellyfin item by its ID.
   */
  async deleteItem(itemId: string): Promise<boolean> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) return false;
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      await this.client.delete(`/Items/${itemId}`, { headers });
      console.log(`Deleted Jellyfin item: ${itemId}`);
      return true;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to delete Jellyfin item:', message);
      return false;
    }
  }

  /**
   * Delete a Jellyfin item found by searching for it via its .strm file path or name.
   * Used when removing media from Qar to also remove from Jellyfin.
   */
  async deleteItemByPath(strmFilePath: string): Promise<boolean> {
    const itemId = await this.findItemByPath(strmFilePath);
    if (!itemId) {
      console.log(`No Jellyfin item found for path: ${strmFilePath}`);
      return false;
    }
    return this.deleteItem(itemId);
  }

  /**
   * Delete a Jellyfin TV series by searching for it by name.
   */
  async deleteTvSeriesByName(seriesName: string): Promise<boolean> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) return false;
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      const response = await this.client.get('/Items', {
        headers,
        params: {
          searchTerm: seriesName,
          includeItemTypes: 'Series',
          recursive: true,
          limit: 5,
        },
      });

      if (response.data?.Items?.length > 0) {
        for (const item of response.data.Items) {
          if (item.Name === seriesName) {
            await this.deleteItem(item.Id);
            return true;
          }
        }
      }
      return false;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to find/delete Jellyfin TV series:', message);
      return false;
    }
  }

  /**
   * Mark a Jellyfin item as unwatched (not played).
   * This ensures the item appears as "new" in the library after download.
   * 
   * @param itemId - The Jellyfin item ID
   * @returns true if the item was marked as unwatched
   */
  async markItemUnwatched(itemId: string): Promise<boolean> {
    if (!this.adminToken || !this.adminUserId) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot mark item unwatched: no authentication token');
        return false;
      }
      // Get user ID if we don't have it
      const userIdSetting = await Setting.findOne({ where: { key: 'jellyfinUserId' } });
      if (userIdSetting) {
        this.adminUserId = userIdSetting.value;
      }
    }

    if (!this.adminUserId) {
      console.log('Cannot mark item unwatched: no user ID');
      return false;
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      // Mark as unplayed
      await this.client.delete(`/Users/${this.adminUserId}/PlayedItems/${itemId}`, {
        headers,
      });
      
      console.log(`Jellyfin item marked as unwatched: ${itemId}`);
      return true;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to mark Jellyfin item as unwatched:', message);
      return false;
    }
  }

  /**
   * Mark a Jellyfin item as unwatched by searching for it using the .strm file path.
   * Combines findItemByPath and markItemUnwatched into a single convenience method.
   * 
   * @param strmFilePath - Path to the .strm file
   * @returns true if the item was found and marked as unwatched
   */
  async markItemUnwatchedByPath(strmFilePath: string): Promise<boolean> {
    const itemId = await this.findItemByPath(strmFilePath);
    if (!itemId) {
      console.log(`Could not find Jellyfin item for path: ${strmFilePath}`);
      return false;
    }
    return this.markItemUnwatched(itemId);
  }

  /**
   * Get watch history for the admin user.
   * Returns items that have been played, with play count and favorite status.
   */
  async getWatchHistory(): Promise<Array<{
    name: string;
    type: 'Movie' | 'Series' | 'Episode';
    played: boolean;
    playCount: number;
    isFavorite: boolean;
    lastPlayedDate?: string;
  }>> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) return [];
    }
    if (!this.adminUserId) {
      const userIdSetting = await Setting.findOne({ where: { key: 'jellyfinUserId' } });
      if (userIdSetting) this.adminUserId = userIdSetting.value;
      if (!this.adminUserId) return [];
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      const results: Array<{
        name: string;
        type: 'Movie' | 'Series' | 'Episode';
        played: boolean;
        playCount: number;
        isFavorite: boolean;
        lastPlayedDate?: string;
      }> = [];

      // Get played movies and series
      for (const itemType of ['Movie', 'Series'] as const) {
        const resp = await this.client.get(`/Users/${this.adminUserId}/Items`, {
          headers,
          params: {
            IncludeItemTypes: itemType,
            Recursive: true,
            Fields: 'UserDataPlayCount,UserDataLastPlayedDate',
            IsPlayed: true,
            Limit: 200,
          },
        });

        for (const item of resp.data.Items || []) {
          results.push({
            name: item.Name,
            type: itemType,
            played: item.UserData?.Played ?? false,
            playCount: item.UserData?.PlayCount ?? 0,
            isFavorite: item.UserData?.IsFavorite ?? false,
            lastPlayedDate: item.UserData?.LastPlayedDate,
          });
        }
      }

      // Also get favorites that may not have been played
      const favResp = await this.client.get(`/Users/${this.adminUserId}/Items`, {
        headers,
        params: {
          IncludeItemTypes: 'Movie,Series',
          Recursive: true,
          IsFavorite: true,
          Limit: 200,
        },
      });

      for (const item of favResp.data.Items || []) {
        const existing = results.find(r => r.name === item.Name && r.type === (item.Type === 'Movie' ? 'Movie' : 'Series'));
        if (!existing) {
          results.push({
            name: item.Name,
            type: item.Type === 'Movie' ? 'Movie' : 'Series',
            played: item.UserData?.Played ?? false,
            playCount: item.UserData?.PlayCount ?? 0,
            isFavorite: item.UserData?.IsFavorite ?? true,
            lastPlayedDate: item.UserData?.LastPlayedDate,
          });
        } else {
          existing.isFavorite = true;
        }
      }

      return results;
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to get watch history from Jellyfin:', message);
      return [];
    }
  }

  /**
   * Get the Jellyfin status including whether it's set up and accessible
   */
  async getStatus(): Promise<{
    available: boolean;
    configured: boolean;
    url: string;
    hasToken: boolean;
  }> {
    const available = await this.isAvailable();
    const configured = available ? await this.isSetUp() : false;
    const token = await this.getAccessToken();

    return {
      available,
      configured,
      url: this.baseUrl,
      hasToken: !!token,
    };
  }

  /**
   * Get the URL to redirect users to Jellyfin (with auth if available)
   */
  async getRedirectUrl(): Promise<string> {
    const token = await this.getAccessToken();
    if (token) {
      // Use the frontend redirect page
      return `/jellyfin-redirect?token=${encodeURIComponent(token)}`;
    }
    return this.baseUrl;
  }

  /**
   * Get the Jellyfin URL to watch a specific item.
   * Searches Jellyfin for the item by name and returns a direct URL to play it.
   * 
   * @param title - The title to search for
   * @param type - The media type (movie, tv, web)
   * @param season - For TV shows, the season number
   * @param episode - For TV shows, the episode number
   * @returns Object with itemId and playUrl, or null if not found
   */
  async getWatchUrl(
    title: string, 
    type: 'movie' | 'tv' | 'web',
    season?: number,
    episode?: number,
    externalBaseUrl?: string
  ): Promise<{ itemId: string; detailsUrl: string; playUrl: string } | null> {
    if (!this.adminToken) {
      const token = await this.getAccessToken();
      if (!token) {
        console.log('Cannot get watch URL: no authentication token');
        return null;
      }
    }

    const headers = {
      'X-Emby-Authorization': this.getAuthorizationHeader(this.adminToken!),
    };

    try {
      let searchType: string;
      
      switch (type) {
        case 'movie':
          searchType = 'Movie';
          break;
        case 'tv':
          searchType = season && episode ? 'Episode' : 'Series';
          break;
        case 'web':
          searchType = 'Video';
          break;
        default:
          searchType = 'Video';
      }

      // Use SearchTerm for Jellyfin search API
      let response = await this.client.get('/Items', {
        headers,
        params: {
          SearchTerm: title,
          IncludeItemTypes: searchType,
          Recursive: true,
          Limit: 50,
          Fields: 'Path,Overview,ParentId',
        },
      });

      let items = response.data?.Items || [];
      console.log(`[jellyfin] Search for "${title}" (${searchType}) returned ${items.length} items:`, 
        items.slice(0, 5).map((i: any) => ({ Name: i.Name, Type: i.Type, Id: i.Id })));
      
      // If type-filtered search returned nothing, try without type filter
      if (items.length === 0) {
        response = await this.client.get('/Items', {
          headers,
          params: {
            SearchTerm: title,
            Recursive: true,
            Limit: 50,
            Fields: 'Path,Overview,ParentId',
          },
        });
        items = response.data?.Items || [];
        console.log(`[jellyfin] Unfiltered search for "${title}" returned ${items.length} items:`, 
          items.slice(0, 5).map((i: any) => ({ Name: i.Name, Type: i.Type, Id: i.Id })));
      }
      
      let matchedItem = null;
      const titleLower = title.toLowerCase();
      
      // First pass: exact name match
      for (const item of items) {
        const itemName = (item.Name || '').toLowerCase();
        const seriesName = (item.SeriesName || '').toLowerCase();
        
        if (type === 'movie' || type === 'web') {
          if (itemName === titleLower) {
            matchedItem = item;
            break;
          }
        } else if (type === 'tv') {
          if (season && episode) {
            // Match specific episode
            if (seriesName === titleLower && 
                item.ParentIndexNumber === season && 
                item.IndexNumber === episode) {
              matchedItem = item;
              break;
            }
          } else {
            // Match series
            if (itemName === titleLower) {
              matchedItem = item;
              break;
            }
          }
        }
      }
      
      // Second pass: fuzzy match (contains)
      if (!matchedItem) {
        for (const item of items) {
          const itemName = (item.Name || '').toLowerCase();
          const seriesName = (item.SeriesName || '').toLowerCase();
          
          if (type === 'movie' || type === 'web') {
            if (itemName.includes(titleLower) || titleLower.includes(itemName)) {
              matchedItem = item;
              break;
            }
          } else if (type === 'tv') {
            if (season && episode) {
              if ((seriesName.includes(titleLower) || titleLower.includes(seriesName)) &&
                  item.ParentIndexNumber === season && 
                  item.IndexNumber === episode) {
                matchedItem = item;
                break;
              }
            } else {
              if (itemName.includes(titleLower) || titleLower.includes(itemName)) {
                matchedItem = item;
                break;
              }
            }
          }
        }
      }
      
      // Third pass: if nothing matched and we have results, try the first result
      if (!matchedItem && items.length > 0) {
        matchedItem = items[0];
        console.log(`[jellyfin] Using best available match: "${matchedItem.Name}" for "${title}"`);
      }

      if (!matchedItem) {
        console.log(`[jellyfin] Item not found for: "${title}" (${type})`);
        return null;
      }

      const itemId = matchedItem.Id;
      const serverId = matchedItem.ServerId;
      
      const baseUrl = externalBaseUrl || 'http://localhost:8096';
      const detailsUrl = `${baseUrl}/web/index.html#/details?id=${itemId}&serverId=${serverId}`;
      const playUrl = `${baseUrl}/web/index.html#/video?id=${itemId}&serverId=${serverId}`;

      return { itemId, detailsUrl, playUrl };
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error('Failed to get Jellyfin watch URL:', message);
      return null;
    }
  }
}

export const jellyfinService = new JellyfinService();
