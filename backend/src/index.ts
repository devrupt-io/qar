import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { sequelize, MediaItem, TVShow } from './models';
import { omdbService } from './services/omdb';
import { jellyfinService } from './services/jellyfin';
import { downloadManager } from './services/downloadManager';
import mediaRoutes from './routes/media';
import searchRoutes from './routes/search';
import downloadRoutes from './routes/downloads';
import settingsRoutes from './routes/settings';
import statsRoutes from './routes/stats';
import streamRoutes from './routes/stream';
import progressRoutes from './routes/progress';
import jellyfinRoutes from './routes/jellyfin';
import scannerRoutes from './routes/scanner';
import recommendationsRoutes from './routes/recommendations';
import { contentScannerService } from './services/contentScanner';
import { openRouterService } from './services/ai';
import { mediaService } from './services/media';
import { episodeRefreshService } from './services/episodeRefresh';

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/media', mediaRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/jellyfin', jellyfinRoutes);
app.use('/api/scanner', scannerRoutes);
app.use('/api/recommendations', recommendationsRoutes);
app.use('/progress', progressRoutes);
// Legacy /stream route kept for backwards compatibility but deprecated
app.use('/stream', streamRoutes);

// Error handling
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Ensures the content directories exist (movies, tv, web).
 * These directories are where .strm files are stored and mounted to Jellyfin.
 */
function ensureContentDirectories(): void {
  const contentDirs = ['movies', 'tv', 'web'];
  
  for (const dir of contentDirs) {
    const dirPath = path.join(config.paths.content, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log(`Created content directory: ${dirPath}`);
    }
  }
}

/**
 * Migrates orphaned TV episodes (MediaItem records with type='tv') into TVShow entities.
 * This ensures every TV show title has a corresponding TVShow record in the database.
 * Runs automatically at startup to fix any inconsistencies.
 */
async function migrateOrphanedTVEpisodes(): Promise<void> {
  try {
    console.log('Checking for orphaned TV episodes...');
    
    // Find all unique TV show titles from episodes
    const episodes = await MediaItem.findAll({
      where: { type: 'tv' },
      attributes: ['title', 'year', 'imdbId', 'posterUrl', 'plot'],
    });
    
    if (episodes.length === 0) {
      console.log('No TV episodes found, skipping migration');
      return;
    }
    
    // Group by title to find unique shows
    const showTitles = new Map<string, { year?: number; imdbId?: string; posterUrl?: string; plot?: string }>();
    for (const ep of episodes) {
      if (!showTitles.has(ep.title)) {
        showTitles.set(ep.title, {
          year: ep.year,
          imdbId: ep.imdbId,
          posterUrl: ep.posterUrl,
          plot: ep.plot,
        });
      }
    }
    
    let createdCount = 0;
    
    for (const [title, data] of showTitles) {
      // Check if TVShow already exists
      const existingShow = await TVShow.findOne({
        where: { title },
      });
      
      if (existingShow) {
        continue;
      }
      
      // Create the TVShow entity
      await TVShow.create({
        id: uuidv4(),
        title,
        year: data.year,
        imdbId: data.imdbId,
        posterUrl: data.posterUrl,
        plot: data.plot,
        totalSeasons: 1, // Will be updated if OMDB data is available
      });
      
      console.log(`Created TVShow entity for orphaned episodes: ${title}`);
      createdCount++;
    }
    
    if (createdCount > 0) {
      console.log(`Migrated ${createdCount} TV show(s) from orphaned episodes`);
    } else {
      console.log('No orphaned TV episodes found, all shows have TVShow entities');
    }
  } catch (error) {
    console.error('Error migrating orphaned TV episodes:', error);
    // Non-fatal error, continue startup
  }
}

/**
 * Attempts a single Jellyfin setup operation.
 * Returns true if setup completed successfully, false otherwise.
 */
async function attemptJellyfinSetup(): Promise<boolean> {
  try {
    const jellyfinStatus = await jellyfinService.getStatus();
    
    if (!jellyfinStatus.available) {
      console.log('Jellyfin not available yet');
      return false;
    }
    
    if (!jellyfinStatus.configured) {
      console.log('Jellyfin not configured, running auto-setup...');
      const result = await jellyfinService.autoSetup();
      if (result.success) {
        console.log('Jellyfin auto-setup completed successfully');
        return true;
      } else {
        console.error('Jellyfin auto-setup failed:', result.message);
        return false;
      }
    } else {
      console.log('Jellyfin already configured');
      // Ensure we have a valid token
      const token = await jellyfinService.getAccessToken();
      if (token) {
        // Always ensure libraries exist (even for pre-configured Jellyfin)
        console.log('Ensuring Jellyfin libraries are configured...');
        await jellyfinService.ensureLibraries();
        jellyfinService.markSetupComplete();
        return true;
      }
      return false;
    }
  } catch (e: any) {
    console.log('Jellyfin setup attempt failed:', e.message || 'Unknown error');
    return false;
  }
}

/**
 * Starts a periodic background task that attempts Jellyfin setup.
 * Continues checking every interval until setup is complete.
 * Uses exponential backoff to avoid excessive logging.
 */
function startJellyfinBackgroundSetup(): void {
  const INITIAL_INTERVAL = 5000;    // 5 seconds initial
  const MAX_INTERVAL = 60000;       // 1 minute max
  let currentInterval = INITIAL_INTERVAL;
  let attemptCount = 0;
  
  const trySetup = async () => {
    // If already set up, stop trying
    if (jellyfinService.isSetupComplete()) {
      return;
    }
    
    attemptCount++;
    const success = await attemptJellyfinSetup();
    
    if (success) {
      console.log('Jellyfin background setup completed successfully');
      return;
    }
    
    // Increase interval with exponential backoff
    currentInterval = Math.min(currentInterval * 1.5, MAX_INTERVAL);
    
    // Only log every few attempts to avoid spam
    if (attemptCount <= 3 || attemptCount % 5 === 0) {
      console.log(`Jellyfin setup pending, will retry in ${Math.round(currentInterval / 1000)}s (attempt ${attemptCount})`);
    }
    
    // Schedule next attempt
    setTimeout(trySetup, currentInterval);
  };
  
  // Start the first attempt after a short delay
  setTimeout(trySetup, INITIAL_INTERVAL);
}

// Start server
async function start() {
  try {
    // Connect to database
    await sequelize.authenticate();
    console.log('Database connected');
    
    // Sync models
    await sequelize.sync({ alter: true });
    console.log('Models synchronized');
    
    // Ensure content directories exist (movies, tv, web)
    ensureContentDirectories();
    
    // Migrate any orphaned TV episodes into TVShow entities
    await migrateOrphanedTVEpisodes();

    // Initialize OMDB service with database settings
    await omdbService.initializeFromDatabase();
    
    // Initialize OpenRouter AI service with database settings
    await openRouterService.initializeFromDatabase();
    
    // Start periodic Jellyfin setup in the background
    // This will keep trying until Jellyfin is available and configured
    startJellyfinBackgroundSetup();

    // Start the download manager (periodic sync every 30 seconds)
    downloadManager.start();
    
    // Start the content scanner (scans every hour, rate-limited to 100 items/hour)
    // This recovers media from existing content/ and storage/ directories
    contentScannerService.start(60 * 60 * 1000);

    // Start periodic episode refresh (checks active shows for new episodes)
    episodeRefreshService.start();
    
    // Validate file paths on startup - clears stale entries where files were deleted
    mediaService.validateFilePaths().catch(err => {
      console.error('Error validating file paths:', err);
    });
    
    app.listen(config.port, () => {
      console.log(`Backend server running on port ${config.port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
