import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgres://qar:qar_password@localhost:5432/qar',
  qbittorrentUrl: process.env.QBITTORRENT_URL || 'http://localhost:8888',
  jellyfinUrl: process.env.JELLYFIN_URL || 'http://jellyfin:8096',
  omdbApiKey: process.env.OMDB_API_KEY || '',
  
  paths: {
    content: process.env.CONTENT_PATH || '/qar/content',
    disks: process.env.DISKS_PATH || '/qar/disks',
    downloads: process.env.DOWNLOADS_PATH || '/qar/downloads',
    config: process.env.CONFIG_PATH || '/qar/config',
    // Default disk name (used when no external disks have the content)
    defaultDisk: process.env.DEFAULT_DISK || 'default',
    // Trash directory for deleted files (allows recovery)
    trash: process.env.TRASH_PATH || '/qar/disks/default/.trash',
  },
  
  // Default settings for torrent search (arrays allow multiple preferences)
  defaults: {
    preferredCodecs: ['x264'],
    preferredResolutions: ['720p', '1080p'],
    preferredMovieGroups: ['yify', 'yts', 'galaxyrg', 'ettv', 'rarbg'],
  },
  
  tor: {
    host: process.env.TOR_HOST || '127.0.0.1',
    port: parseInt(process.env.TOR_PORT || '9050', 10),
  },
  
  leet: {
    // Primary: Tor hidden service (most private, but slower)
    onionUrl: 'http://l337xdarkkaqfwzntnfk5bmoaroivtl6xsbatabvlb52umg6v3ch44yd.onion',
    // Fallback: Clearnet mirrors (faster, but less private - only used if Tor fails)
    clearnetUrls: [
      'https://1337x.to',
      'https://1337x.st',
      'https://x1337x.ws',
      'https://1337x.gd',
    ],
  },
};
