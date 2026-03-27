import { Sequelize, DataTypes, Model, Optional } from 'sequelize';
import { config } from '../config';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
});

// Media Item Types
export type MediaType = 'movie' | 'tv' | 'web';
export type DownloadStatus = 'pending' | 'downloading' | 'completed' | 'failed' | 'paused';

// Media Item Model
interface MediaItemAttributes {
  id: string;
  type: MediaType;
  title: string;
  year?: number;
  imdbId?: string;
  imdbRating?: number;
  posterUrl?: string;
  plot?: string;
  season?: number;
  episode?: number;
  channel?: string;
  diskPath?: string;
  filePath?: string;
  magnetUri?: string;
  pinned?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MediaItemCreationAttributes extends Optional<MediaItemAttributes, 'id'> {}

export class MediaItem extends Model<MediaItemAttributes, MediaItemCreationAttributes> implements MediaItemAttributes {
  public id!: string;
  public type!: MediaType;
  public title!: string;
  public year?: number;
  public imdbId?: string;
  public imdbRating?: number;
  public posterUrl?: string;
  public plot?: string;
  public season?: number;
  public episode?: number;
  public channel?: string;
  public diskPath?: string;
  public filePath?: string;
  public magnetUri?: string;
  public pinned?: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

MediaItem.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM('movie', 'tv', 'web'),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    year: {
      type: DataTypes.INTEGER,
    },
    imdbId: {
      type: DataTypes.STRING,
    },
    imdbRating: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    posterUrl: {
      type: DataTypes.STRING,
    },
    plot: {
      type: DataTypes.TEXT,
    },
    season: {
      type: DataTypes.INTEGER,
    },
    episode: {
      type: DataTypes.INTEGER,
    },
    channel: {
      type: DataTypes.STRING,
    },
    diskPath: {
      type: DataTypes.STRING,
    },
    filePath: {
      type: DataTypes.STRING,
    },
    magnetUri: {
      type: DataTypes.TEXT,
    },
    pinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'media_items',
  }
);

// Download Model
interface DownloadAttributes {
  id: string;
  mediaItemId?: string;
  tvShowId?: string;
  magnetUri: string;
  status: DownloadStatus;
  progress: number;
  downloadSpeed?: number;
  eta?: number;
  torrentHash?: string;
  /** The actual torrent name from QBittorrent */
  torrentName?: string;
  error?: string;
  totalSize?: number;
  downloadedSize?: number;
  completedAt?: Date;
  episodeIds?: string[];
  // Detected episode info from torrent name (for TV show downloads)
  detectedEpisodes?: {
    type: 'complete' | 'season' | 'range' | 'episode' | 'unknown';
    isComplete: boolean;
    seasons: number[];
    episodes: Array<{ season: number; episode: number }>;
    description: string;
  };
  // Human-readable reason for the download (e.g., "Movie: The Matrix (1999)", "TV: Breaking Bad S01E01")
  downloadReason?: string;
  // Whether this download was initiated by the auto-download system
  isAutoDownload?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface DownloadCreationAttributes extends Optional<DownloadAttributes, 'id' | 'progress'> {}

export class Download extends Model<DownloadAttributes, DownloadCreationAttributes> implements DownloadAttributes {
  public id!: string;
  public mediaItemId?: string;
  public tvShowId?: string;
  public magnetUri!: string;
  public status!: DownloadStatus;
  public progress!: number;
  public downloadSpeed?: number;
  public eta?: number;
  public torrentHash?: string;
  public torrentName?: string;
  public error?: string;
  public totalSize?: number;
  public downloadedSize?: number;
  public completedAt?: Date;
  public episodeIds?: string[];
  public detectedEpisodes?: {
    type: 'complete' | 'season' | 'range' | 'episode' | 'unknown';
    isComplete: boolean;
    seasons: number[];
    episodes: Array<{ season: number; episode: number }>;
    description: string;
  };
  public downloadReason?: string;
  public isAutoDownload?: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Download.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    mediaItemId: {
      type: DataTypes.UUID,
      allowNull: true,
      // Reference added via association after all models are defined
    },
    tvShowId: {
      type: DataTypes.UUID,
      allowNull: true,
      // Reference added via association after all models are defined
    },
    magnetUri: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'downloading', 'completed', 'failed', 'paused'),
      defaultValue: 'pending',
    },
    progress: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
    },
    downloadSpeed: {
      type: DataTypes.FLOAT,
    },
    eta: {
      type: DataTypes.INTEGER,
    },
    torrentHash: {
      type: DataTypes.STRING,
    },
    torrentName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    error: {
      type: DataTypes.TEXT,
    },
    totalSize: {
      type: DataTypes.BIGINT,
    },
    downloadedSize: {
      type: DataTypes.BIGINT,
    },
    completedAt: {
      type: DataTypes.DATE,
    },
    episodeIds: {
      type: DataTypes.ARRAY(DataTypes.UUID),
      allowNull: true,
      defaultValue: [],
    },
    detectedEpisodes: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    downloadReason: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isAutoDownload: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'downloads',
  }
);

// Settings Model
interface SettingAttributes {
  id: string;
  key: string;
  value: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SettingCreationAttributes extends Optional<SettingAttributes, 'id'> {}

export class Setting extends Model<SettingAttributes, SettingCreationAttributes> implements SettingAttributes {
  public id!: string;
  public key!: string;
  public value!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Setting.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    key: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'settings',
  }
);

// TV Show Model - represents a TV show (not individual episodes)
interface TVShowAttributes {
  id: string;
  title: string;
  year?: number;
  imdbId?: string;
  imdbRating?: number;
  posterUrl?: string;
  plot?: string;
  totalSeasons?: number;
  pinned?: boolean;
  ended?: boolean;
  lastChecked?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface TVShowCreationAttributes extends Optional<TVShowAttributes, 'id'> {}

export class TVShow extends Model<TVShowAttributes, TVShowCreationAttributes> implements TVShowAttributes {
  public id!: string;
  public title!: string;
  public year?: number;
  public imdbId?: string;
  public imdbRating?: number;
  public posterUrl?: string;
  public plot?: string;
  public totalSeasons?: number;
  public pinned?: boolean;
  public ended?: boolean;
  public lastChecked?: Date;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

TVShow.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    year: {
      type: DataTypes.INTEGER,
    },
    imdbId: {
      type: DataTypes.STRING,
      unique: true,
    },
    imdbRating: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    posterUrl: {
      type: DataTypes.STRING,
    },
    plot: {
      type: DataTypes.TEXT,
    },
    totalSeasons: {
      type: DataTypes.INTEGER,
    },
    pinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    ended: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    lastChecked: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'tv_shows',
  }
);

// Associations - these must be defined after all models are initialized
// Using the association methods to establish foreign key relationships
// This ensures proper table creation order during sync
MediaItem.hasMany(Download, { 
  foreignKey: { 
    name: 'mediaItemId', 
    allowNull: true 
  }, 
  as: 'downloads',
  onDelete: 'SET NULL',
  onUpdate: 'CASCADE'
});
Download.belongsTo(MediaItem, { foreignKey: 'mediaItemId', as: 'mediaItem' });

TVShow.hasMany(Download, { 
  foreignKey: { 
    name: 'tvShowId', 
    allowNull: true 
  }, 
  as: 'downloads',
  onDelete: 'SET NULL',
  onUpdate: 'CASCADE'
});
Download.belongsTo(TVShow, { foreignKey: 'tvShowId', as: 'tvShow' });

// Helper function to sync models in the correct order
export async function syncModels(options?: { force?: boolean; alter?: boolean }) {
  // Sync tables without foreign keys first, then with
  await MediaItem.sync(options);
  await TVShow.sync(options);
  await Setting.sync(options);
  await Download.sync(options);
}

export { sequelize as default };
