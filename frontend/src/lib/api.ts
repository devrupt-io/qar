// Always use relative /api path - Next.js rewrites handle routing to backend
const API_BASE = '/api';

// Rewrite localhost in URLs returned by the backend to use the browser's hostname.
// This ensures Jellyfin and other service URLs work when accessed via LAN IP.
function rewriteHost(url: string): string {
  if (typeof window === 'undefined') return url;
  const currentHost = window.location.hostname;
  if (currentHost === 'localhost' || currentHost === '127.0.0.1') return url;
  return url.replace(/\/\/localhost([:/])/g, `//${currentHost}$1`);
}

async function fetchApi(endpoint: string, options?: RequestInit) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Search
  searchOmdb: (query: string, type?: string) => {
    const params = new URLSearchParams({ q: query });
    if (type) params.append('type', type);
    return fetchApi(`/search/omdb?${params}`);
  },

  searchTorrents: (query: string, category?: string, applyPreferences?: boolean, overrides?: {
    codec?: string;
    resolution?: string;
    group?: string;
  }) => {
    const params = new URLSearchParams({ q: query });
    if (category) params.append('category', category);
    if (applyPreferences) params.append('applyPreferences', 'true');
    if (overrides?.codec) params.append('overrideCodec', overrides.codec);
    if (overrides?.resolution) params.append('overrideResolution', overrides.resolution);
    if (overrides?.group) params.append('overrideGroup', overrides.group);
    return fetchApi(`/search/torrents?${params}`);
  },

  // Search for TV show torrents with improved search strategies
  searchTvTorrents: (title: string, searchType: 'complete' | 'season' | 'episode', season?: number, episode?: number) => {
    const params = new URLSearchParams({ title, searchType });
    if (season) params.append('season', String(season));
    if (episode) params.append('episode', String(episode));
    return fetchApi(`/search/torrents/tv?${params}`);
  },

  // Fetch magnet URI for a specific torrent (on-demand)
  fetchMagnetUri: (detailsUrl: string) => {
    return fetchApi('/search/torrents/magnet', {
      method: 'POST',
      body: JSON.stringify({ detailsUrl }),
    });
  },

  // Check Tor health
  checkTorHealth: () => {
    return fetchApi('/search/tor/health');
  },

  // Reinitialize Tor connection
  reinitializeTor: () => {
    return fetchApi('/search/tor/reinitialize', { method: 'POST' });
  },

  // Detect episodes from a torrent name
  detectEpisodes: (torrentName: string, showTitle?: string, validationOptions?: {
    expectedType?: 'complete' | 'season' | 'episode';
    expectedSeason?: number;
    expectedEpisode?: number;
    totalSeasons?: number;
    episodesPerSeason?: Record<number, number>;
  }) => {
    return fetchApi('/search/detect-episodes', {
      method: 'POST',
      body: JSON.stringify({ torrentName, showTitle, ...validationOptions }),
    });
  },

  // Get search preferences
  getSearchPreferences: () => {
    return fetchApi('/search/preferences');
  },

  getOmdbDetails: (imdbId: string) => {
    return fetchApi(`/search/omdb/${imdbId}`);
  },

  // Media
  getMedia: (type?: string) => {
    const params = type ? `?type=${type}` : '';
    return fetchApi(`/media${params}`);
  },

  getMediaItem: (id: string) => {
    return fetchApi(`/media/${id}`);
  },

  addMovie: (data: { imdbId?: string; title: string; year?: string; magnetUri?: string }) => {
    return fetchApi('/media/movie', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  addTvShow: (data: { imdbId?: string; title: string; year?: string; season?: number; episode?: number; magnetUri?: string }) => {
    return fetchApi('/media/tv', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Add entire TV show (all seasons and episodes)
  addTvShowFull: (data: { imdbId: string; title: string; year?: string }) => {
    return fetchApi('/media/tv/show', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Get a TV show with all its episodes
  getTvShow: (id: string) => {
    return fetchApi(`/media/tv/shows/${id}`);
  },

  // Get all TV shows
  getTvShows: () => {
    return fetchApi('/media/tv/shows');
  },

  // Migrate orphaned TV episodes into TVShow entities
  migrateTvEpisodes: () => {
    return fetchApi('/media/migrate-tv-episodes', {
      method: 'POST',
    });
  },

  addWebContent: (data: { title: string; channel?: string; magnetUri?: string }) => {
    return fetchApi('/media/web', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  deleteMedia: (id: string, deleteFiles?: boolean) => {
    const params = deleteFiles ? '?deleteFiles=true' : '';
    return fetchApi(`/media/${id}${params}`, {
      method: 'DELETE',
    });
  },

  // Delete only the stored media files, preserving metadata
  deleteMediaFiles: (id: string) => {
    return fetchApi(`/media/${id}/delete-files`, {
      method: 'POST',
    });
  },

  // Delete entire TV show (all episodes)
  deleteTvShow: (title: string, deleteFiles?: boolean) => {
    const params = deleteFiles ? '?deleteFiles=true' : '';
    return fetchApi(`/media/tv/show/${encodeURIComponent(title)}${params}`, {
      method: 'DELETE',
    });
  },

  // Pin/unpin media
  pinMedia: (id: string, pinned = true) => {
    return fetchApi(`/media/${id}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
  },

  unpinMedia: (id: string) => {
    return fetchApi(`/media/${id}/unpin`, {
      method: 'POST',
    });
  },

  pinTvShow: (title: string, pinned = true) => {
    return fetchApi(`/media/tv/show/${encodeURIComponent(title)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
  },

  getPinnedMedia: () => {
    return fetchApi('/media/pinned');
  },

  getMediaDetails: (id: string) => {
    return fetchApi(`/media/${id}/details`);
  },

  startDownload: (mediaId: string, magnetUri: string, detectedEpisodes?: {
    type: string;
    isComplete: boolean;
    seasons: number[];
    episodes: Array<{ season: number; episode: number }>;
    description: string;
  }, wantedEpisodes?: Array<{ season: number; episode: number }>) => {
    return fetchApi(`/media/${mediaId}/download`, {
      method: 'POST',
      body: JSON.stringify({ magnetUri, detectedEpisodes, wantedEpisodes }),
    });
  },

  searchMediaTorrents: (mediaId: string) => {
    return fetchApi(`/media/${mediaId}/search-torrents`, {
      method: 'POST',
    });
  },

  // Downloads
  getDownloads: () => {
    return fetchApi('/downloads');
  },

  getActiveDownloads: () => {
    return fetchApi('/downloads/active');
  },

  getDownload: (id: string) => {
    return fetchApi(`/downloads/${id}`);
  },

  pauseDownload: (id: string) => {
    return fetchApi(`/downloads/${id}/pause`, {
      method: 'POST',
    });
  },

  resumeDownload: (id: string) => {
    return fetchApi(`/downloads/${id}/resume`, {
      method: 'POST',
    });
  },

  deleteDownload: (id: string, deleteFiles?: boolean) => {
    const params = deleteFiles ? '?deleteFiles=true' : '';
    return fetchApi(`/downloads/${id}${params}`, {
      method: 'DELETE',
    });
  },

  getDownloadHistory: (limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi(`/downloads/history${params}`);
  },

  triggerDownloadSync: () => {
    return fetchApi('/downloads/sync', {
      method: 'POST',
    });
  },

  cleanupDownloads: () => {
    return fetchApi('/downloads/cleanup', {
      method: 'POST',
    });
  },

  // Stats
  getStats: () => {
    return fetchApi('/stats');
  },

  getDiskStats: () => {
    return fetchApi('/stats/disks');
  },

  getLibraryStats: () => {
    return fetchApi('/stats/library');
  },

  // Settings
  getSettings: () => {
    return fetchApi('/settings');
  },

  updateSettings: (settings: Record<string, string>) => {
    return fetchApi('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },

  getVpnStatus: () => {
    return fetchApi('/settings/vpn/status');
  },

  getVpnRegions: () => {
    return fetchApi('/settings/vpn/regions');
  },

  restartVpn: () => {
    return fetchApi('/settings/vpn/restart', {
      method: 'POST',
    });
  },

  getSystemStatus: () => {
    return fetchApi('/stats/system');
  },

  // Jellyfin
  getJellyfinStatus: () => {
    return fetchApi('/jellyfin/status');
  },

  setupJellyfin: () => {
    return fetchApi('/jellyfin/setup', {
      method: 'POST',
    });
  },

  getJellyfinToken: async () => {
    const data = await fetchApi('/jellyfin/token');
    if (data.redirectUrl) data.redirectUrl = rewriteHost(data.redirectUrl);
    if (data.jellyfinUrl) data.jellyfinUrl = rewriteHost(data.jellyfinUrl);
    return data;
  },

  refreshJellyfinLibraries: () => {
    return fetchApi('/jellyfin/refresh-libraries', {
      method: 'POST',
    });
  },

  // Get Jellyfin watch URL for a specific media item
  getJellyfinWatchUrl: async (title: string, type: 'movie' | 'tv' | 'web', season?: number, episode?: number) => {
    const params = new URLSearchParams({ title, type });
    if (season) params.append('season', String(season));
    if (episode) params.append('episode', String(episode));
    const data = await fetchApi(`/jellyfin/watch-url?${params}`);
    if (data.detailsUrl) data.detailsUrl = rewriteHost(data.detailsUrl);
    if (data.playUrl) data.playUrl = rewriteHost(data.playUrl);
    if (data.fallbackUrl) data.fallbackUrl = rewriteHost(data.fallbackUrl);
    return data;
  },

  // AI Recommendations
  getRecommendations: (refresh?: boolean) => {
    const params = refresh ? '?refresh=true' : '';
    return fetchApi(`/recommendations${params}`);
  },

  dismissRecommendation: (title: string, year: number) => {
    return fetchApi('/recommendations/dismiss', {
      method: 'POST',
      body: JSON.stringify({ title, year }),
    });
  },

  restoreRecommendation: (title: string, year: number) => {
    return fetchApi('/recommendations/restore', {
      method: 'POST',
      body: JSON.stringify({ title, year }),
    });
  },

  restoreAllRecommendations: () => {
    return fetchApi('/recommendations/restore-all', { method: 'POST' });
  },

  getDismissedRecommendations: () => {
    return fetchApi('/recommendations/dismissed');
  },

  clearRecommendationsCache: () => {
    return fetchApi('/recommendations/clear-cache', { method: 'POST' });
  },

  testOpenRouterConnection: () => {
    return fetchApi('/recommendations/test');
  },
};
