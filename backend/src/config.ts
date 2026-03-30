import dotenv from 'dotenv';
import fs from 'fs';

// Load configuration in priority order (dotenv does NOT override existing values):
// 1. Process environment variables (always highest priority)
// 2. .env file (for Docker / development)
// 3. /etc/qar/qar.conf (for native Linux package installs)
dotenv.config();
const confPath = process.env.QAR_CONF_PATH || '/etc/qar/qar.conf';
if (fs.existsSync(confPath)) {
  dotenv.config({ path: confPath });
}

export type DbDialect = 'postgres' | 'sqlite';

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  dbDialect: (process.env.DB_DIALECT || 'postgres') as DbDialect,
  databaseUrl: process.env.DATABASE_URL || 'postgres://qar:qar_password@localhost:5432/qar',
  sqlitePath: process.env.SQLITE_PATH || '/qar/data/qar.db',
  qbittorrentUrl: process.env.QBITTORRENT_URL || 'http://127.0.0.1:8888',
  jellyfinUrl: process.env.JELLYFIN_URL || 'http://127.0.0.1:8096',
  omdbApiKey: process.env.OMDB_API_KEY || '',
  
  paths: {
    content: process.env.CONTENT_PATH || '/qar/content',
    disks: process.env.DISKS_PATH || '/qar/disks',
    downloads: process.env.DOWNLOADS_PATH || '/qar/downloads',
    config: process.env.CONFIG_PATH || '/qar/config',
    // Jellyfin media path: where Jellyfin sees the content directory
    // In Docker: /media (volume mount), in native installs: same as CONTENT_PATH
    jellyfinMediaPath: process.env.JELLYFIN_MEDIA_PATH || process.env.CONTENT_PATH || '/qar/content',
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
