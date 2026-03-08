/**
 * Content Scanner Service
 * 
 * Scans the content/ and storage/ directories to recover media items
 * that exist on disk but are not in the database. This is useful when:
 * - Migrating to a new server without database backup
 * - Recovering from database loss
 * - Importing media from another system
 * 
 * Features:
 * - Scans content/ for .strm and .yml files
 * - Scans storage/ for video files (movies and TV shows)
 * - Looks up metadata from OMDB API
 * - Rate-limited to avoid hammering APIs (default: 100 items/hour)
 * - Tracks scan state in database to avoid re-scanning
 * - Runs automatically at startup with configurable interval
 */

import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import YAML from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { MediaItem, TVShow, Setting } from '../models';
import { omdbService } from './omdb';
import { mediaService, MediaMetadata } from './media';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const access = promisify(fs.access);

// Extended metadata format for YAML files (includes recovery info)
export interface ExtendedMediaMetadata extends MediaMetadata {
  // Standard fields
  title: string;
  year?: number;
  imdbId?: string;
  magnetUri?: string;
  season?: number;
  episode?: number;
  addedAt: string;
  
  // Extended fields for recovery
  posterUrl?: string;
  plot?: string;
  totalSeasons?: number;  // For TV shows
  scannedAt?: string;     // When this was last scanned/recovered
  recoveredFrom?: 'content' | 'storage';  // How this entry was created
}

export interface ScanResult {
  type: 'movie' | 'tv' | 'web';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  imdbId?: string;
  source: 'content' | 'storage';
  filePath?: string;       // Path to video file in storage
  strmPath?: string;       // Path to .strm file in content
  ymlPath?: string;        // Path to .yml file in content
  metadata?: ExtendedMediaMetadata;
  alreadyInDb: boolean;
  needsOmdbLookup: boolean;
}

export interface ScanProgress {
  phase: 'idle' | 'scanning-content' | 'scanning-storage' | 'processing' | 'complete';
  totalItems: number;
  processedItems: number;
  itemsThisHour: number;
  maxItemsPerHour: number;
  lastScanTime?: Date;
  nextScanTime?: Date;
  errors: string[];
}

class ContentScannerService {
  private scanProgress: ScanProgress = {
    phase: 'idle',
    totalItems: 0,
    processedItems: 0,
    itemsThisHour: 0,
    maxItemsPerHour: 100,
    errors: [],
  };
  
  private itemsProcessedThisHour: number = 0;
  private hourStartTime: Date = new Date();
  private isRunning: boolean = false;
  private scanIntervalMs: number = 60 * 60 * 1000; // 1 hour default
  private scanTimer: NodeJS.Timeout | null = null;

  /**
   * Get the current scan progress
   */
  getProgress(): ScanProgress {
    return { ...this.scanProgress };
  }

  /**
   * Reset the hourly rate limit counter if an hour has passed
   */
  private checkRateLimitReset(): void {
    const now = new Date();
    const hourElapsed = now.getTime() - this.hourStartTime.getTime() >= 60 * 60 * 1000;
    
    if (hourElapsed) {
      this.itemsProcessedThisHour = 0;
      this.hourStartTime = now;
      console.log('[ContentScanner] Rate limit counter reset');
    }
  }

  /**
   * Check if we can process more items this hour
   */
  private canProcessMore(): boolean {
    this.checkRateLimitReset();
    return this.itemsProcessedThisHour < this.scanProgress.maxItemsPerHour;
  }

  /**
   * Set the maximum items to process per hour (for rate limiting)
   */
  setMaxItemsPerHour(max: number): void {
    this.scanProgress.maxItemsPerHour = max;
    console.log(`[ContentScanner] Rate limit set to ${max} items/hour`);
  }

  /**
   * Parse a movie directory name to extract title and year
   * Format: "Title (Year)" or "Title"
   */
  parseMovieDirName(dirName: string): { title: string; year?: number } {
    const match = dirName.match(/^(.+?)\s*\((\d{4})\)\s*$/);
    if (match) {
      return { title: match[1].trim(), year: parseInt(match[2], 10) };
    }
    return { title: dirName };
  }

  /**
   * Parse a TV episode filename to extract title, season, and episode
   * Formats: "Title S01E01.ext", "Title S01E01.strm", "Title S01E01.yml"
   */
  parseEpisodeFileName(fileName: string): { title: string; season: number; episode: number } | null {
    // Remove extension
    const baseName = fileName.replace(/\.(strm|yml|mp4|mkv|avi|mov)$/i, '');
    
    // Match S01E01 pattern
    const match = baseName.match(/^(.+?)\s+S(\d+)E(\d+)$/i);
    if (match) {
      return {
        title: match[1].trim(),
        season: parseInt(match[2], 10),
        episode: parseInt(match[3], 10),
      };
    }
    
    return null;
  }

  /**
   * Parse a season directory name to extract season number
   * Format: "Season 1", "Season 01", "S1", "S01"
   */
  parseSeasonDirName(dirName: string): number | null {
    const match = dirName.match(/^(?:Season\s*|S)(\d+)$/i);
    return match ? parseInt(match[1], 10) : null;
  }

  /**
   * Read and parse a YAML metadata file
   */
  async readYamlMetadata(ymlPath: string): Promise<ExtendedMediaMetadata | null> {
    try {
      const content = await readFile(ymlPath, 'utf8');
      return YAML.parse(content) as ExtendedMediaMetadata;
    } catch (e) {
      return null;
    }
  }

  /**
   * Write extended metadata to a YAML file
   */
  async writeYamlMetadata(ymlPath: string, metadata: ExtendedMediaMetadata): Promise<void> {
    const content = YAML.stringify(metadata);
    await writeFile(ymlPath, content);
  }

  /**
   * Scan the content directory for .strm/.yml files
   */
  async scanContentDirectory(): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const contentPath = config.paths.content;

    console.log(`[ContentScanner] Scanning content directory: ${contentPath}`);

    // Scan movies
    const moviesPath = path.join(contentPath, 'movies');
    try {
      const movieDirs = await readdir(moviesPath);
      
      for (const movieDir of movieDirs) {
        const movieDirPath = path.join(moviesPath, movieDir);
        const dirStat = await stat(movieDirPath);
        
        if (!dirStat.isDirectory()) continue;
        
        const { title, year } = this.parseMovieDirName(movieDir);
        const files = await readdir(movieDirPath);
        
        const strmFile = files.find(f => f.endsWith('.strm'));
        const ymlFile = files.find(f => f.endsWith('.yml'));
        
        if (strmFile) {
          const strmPath = path.join(movieDirPath, strmFile);
          const ymlPath = ymlFile ? path.join(movieDirPath, ymlFile) : undefined;
          const metadata = ymlPath ? await this.readYamlMetadata(ymlPath) : undefined;
          
          results.push({
            type: 'movie',
            title: metadata?.title || title,
            year: metadata?.year || year,
            imdbId: metadata?.imdbId,
            source: 'content',
            strmPath,
            ymlPath,
            metadata: metadata || undefined,
            alreadyInDb: false, // Will be checked later
            needsOmdbLookup: !metadata?.imdbId,
          });
        }
      }
    } catch (e) {
      console.log('[ContentScanner] No movies directory or error scanning:', e);
    }

    // Scan TV shows
    const tvPath = path.join(contentPath, 'tv');
    try {
      const tvShowDirs = await readdir(tvPath);
      
      for (const showDir of tvShowDirs) {
        const showDirPath = path.join(tvPath, showDir);
        const showStat = await stat(showDirPath);
        
        if (!showStat.isDirectory()) continue;
        
        const seasonDirs = await readdir(showDirPath);
        
        for (const seasonDir of seasonDirs) {
          const seasonNum = this.parseSeasonDirName(seasonDir);
          if (!seasonNum) continue;
          
          const seasonDirPath = path.join(showDirPath, seasonDir);
          const seasonStat = await stat(seasonDirPath);
          
          if (!seasonStat.isDirectory()) continue;
          
          const files = await readdir(seasonDirPath);
          const strmFiles = files.filter(f => f.endsWith('.strm'));
          
          for (const strmFile of strmFiles) {
            const parsed = this.parseEpisodeFileName(strmFile);
            if (!parsed) continue;
            
            const strmPath = path.join(seasonDirPath, strmFile);
            const ymlFile = strmFile.replace('.strm', '.yml');
            const ymlPath = files.includes(ymlFile) 
              ? path.join(seasonDirPath, ymlFile) 
              : undefined;
            const metadata = ymlPath ? await this.readYamlMetadata(ymlPath) : undefined;
            
            results.push({
              type: 'tv',
              title: metadata?.title || showDir,
              year: metadata?.year,
              season: parsed.season,
              episode: parsed.episode,
              imdbId: metadata?.imdbId,
              source: 'content',
              strmPath,
              ymlPath,
              metadata: metadata || undefined,
              alreadyInDb: false,
              needsOmdbLookup: !metadata?.imdbId,
            });
          }
        }
      }
    } catch (e) {
      console.log('[ContentScanner] No tv directory or error scanning:', e);
    }

    // Scan web content
    const webPath = path.join(contentPath, 'web');
    try {
      const channelDirs = await readdir(webPath);
      
      for (const channelDir of channelDirs) {
        const channelDirPath = path.join(webPath, channelDir);
        const channelStat = await stat(channelDirPath);
        
        if (!channelStat.isDirectory()) continue;
        
        const files = await readdir(channelDirPath);
        const strmFiles = files.filter(f => f.endsWith('.strm'));
        
        for (const strmFile of strmFiles) {
          const strmPath = path.join(channelDirPath, strmFile);
          const baseName = strmFile.replace('.strm', '');
          const ymlFile = `${baseName}.yml`;
          const ymlPath = files.includes(ymlFile)
            ? path.join(channelDirPath, ymlFile)
            : undefined;
          const metadata = ymlPath ? await this.readYamlMetadata(ymlPath) : undefined;
          
          results.push({
            type: 'web',
            title: metadata?.title || baseName,
            source: 'content',
            strmPath,
            ymlPath,
            metadata: metadata || undefined,
            alreadyInDb: false,
            needsOmdbLookup: false, // Web content doesn't use OMDB
          });
        }
      }
    } catch (e) {
      console.log('[ContentScanner] No web directory or error scanning:', e);
    }

    console.log(`[ContentScanner] Found ${results.length} items in content directory`);
    return results;
  }

  /**
   * Scan the storage directory for video files
   */
  async scanStorageDirectory(): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    const disks = await mediaService.getDiskStats();

    console.log(`[ContentScanner] Scanning ${disks.length} storage disk(s)`);

    for (const disk of disks) {
      // Scan movies
      const moviesPath = path.join(disk.path, 'movies');
      try {
        const movieDirs = await readdir(moviesPath);
        
        for (const movieDir of movieDirs) {
          const movieDirPath = path.join(moviesPath, movieDir);
          const dirStat = await stat(movieDirPath);
          
          if (!dirStat.isDirectory()) continue;
          
          const { title, year } = this.parseMovieDirName(movieDir);
          const files = await readdir(movieDirPath);
          
          // Find video files
          const videoFile = files.find(f => 
            f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.avi')
          );
          
          if (videoFile) {
            results.push({
              type: 'movie',
              title,
              year,
              source: 'storage',
              filePath: path.join(movieDirPath, videoFile),
              alreadyInDb: false,
              needsOmdbLookup: true,
            });
          }
        }
      } catch (e) {
        // Movies directory doesn't exist
      }

      // Scan TV shows
      const tvPath = path.join(disk.path, 'tv');
      try {
        const tvShowDirs = await readdir(tvPath);
        
        for (const showDir of tvShowDirs) {
          const showDirPath = path.join(tvPath, showDir);
          const showStat = await stat(showDirPath);
          
          if (!showStat.isDirectory()) continue;
          
          const seasonDirs = await readdir(showDirPath);
          
          for (const seasonDir of seasonDirs) {
            const seasonNum = this.parseSeasonDirName(seasonDir);
            if (!seasonNum) continue;
            
            const seasonDirPath = path.join(showDirPath, seasonDir);
            const seasonStat = await stat(seasonDirPath);
            
            if (!seasonStat.isDirectory()) continue;
            
            const files = await readdir(seasonDirPath);
            const videoFiles = files.filter(f => 
              f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.avi')
            );
            
            for (const videoFile of videoFiles) {
              // Try to parse episode info from filename
              const parsed = this.parseEpisodeFileName(videoFile);
              
              if (parsed) {
                results.push({
                  type: 'tv',
                  title: showDir,
                  season: parsed.season,
                  episode: parsed.episode,
                  source: 'storage',
                  filePath: path.join(seasonDirPath, videoFile),
                  alreadyInDb: false,
                  needsOmdbLookup: true,
                });
              }
            }
          }
        }
      } catch (e) {
        // TV directory doesn't exist
      }

      // Scan web content
      const webPath = path.join(disk.path, 'web');
      try {
        const channelDirs = await readdir(webPath);
        
        for (const channelDir of channelDirs) {
          const channelDirPath = path.join(webPath, channelDir);
          const channelStat = await stat(channelDirPath);
          
          if (!channelStat.isDirectory()) continue;
          
          const files = await readdir(channelDirPath);
          const videoFiles = files.filter(f =>
            f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.avi')
          );
          
          for (const videoFile of videoFiles) {
            const baseName = videoFile.replace(/\.(mp4|mkv|avi)$/i, '');
            
            results.push({
              type: 'web',
              title: baseName,
              source: 'storage',
              filePath: path.join(channelDirPath, videoFile),
              alreadyInDb: false,
              needsOmdbLookup: false,
            });
          }
        }
      } catch (e) {
        // Web directory doesn't exist
      }
    }

    console.log(`[ContentScanner] Found ${results.length} items in storage directories`);
    return results;
  }

  /**
   * Check which scan results already exist in the database
   */
  async markExistingItems(results: ScanResult[]): Promise<ScanResult[]> {
    for (const result of results) {
      let existing: MediaItem | null = null;
      
      if (result.type === 'movie') {
        existing = await MediaItem.findOne({
          where: {
            type: 'movie',
            title: result.title,
            year: result.year,
          },
        });
      } else if (result.type === 'tv') {
        existing = await MediaItem.findOne({
          where: {
            type: 'tv',
            title: result.title,
            season: result.season,
            episode: result.episode,
          },
        });
      } else if (result.type === 'web') {
        existing = await MediaItem.findOne({
          where: {
            type: 'web',
            title: result.title,
          },
        });
      }
      
      if (existing) {
        result.alreadyInDb = true;
        
        // If item exists but has no file path and we found one, update it
        if (result.filePath && !existing.filePath) {
          const diskPath = path.dirname(path.dirname(result.filePath));
          await existing.update({
            diskPath,
            filePath: path.relative(diskPath, result.filePath),
          });
          console.log(`[ContentScanner] Updated file path for existing: ${result.title}`);
        }
        
        // If we have OMDB info in the YAML but not in DB, update it
        if (result.metadata?.imdbId && !existing.imdbId) {
          await existing.update({
            imdbId: result.metadata.imdbId,
            posterUrl: result.metadata.posterUrl || existing.posterUrl,
            plot: result.metadata.plot || existing.plot,
          });
          console.log(`[ContentScanner] Updated OMDB info for existing: ${result.title}`);
        }
        
        // Mark if this item needs an OMDB lookup to fix missing poster
        if (!existing.posterUrl && (result.type === 'movie' || result.type === 'tv')) {
          result.needsOmdbLookup = true;
          result.alreadyInDb = false; // Process this item to get the poster
        }
      }
    }
    
    return results;
  }

  /**
   * Look up OMDB metadata for a scan result
   */
  async lookupOmdbMetadata(result: ScanResult): Promise<{
    imdbId?: string;
    posterUrl?: string;
    plot?: string;
    year?: number;
    totalSeasons?: number;
  } | null> {
    if (!omdbService.isConfigured()) {
      return null;
    }

    try {
      // Search by title and type
      const searchType = result.type === 'tv' ? 'series' : 
                        result.type === 'movie' ? 'movie' : undefined;
      
      let searchQuery = result.title;
      if (result.year) {
        searchQuery += ` ${result.year}`;
      }
      
      const searchResults = await omdbService.search(result.title, searchType);
      
      if (!searchResults || searchResults.length === 0) {
        return null;
      }

      // Find best match
      let bestMatch = searchResults[0];
      
      // If we have a year, try to find exact match
      if (result.year) {
        const exactMatch = searchResults.find(r => 
          r.Year === String(result.year) || r.Year.startsWith(String(result.year))
        );
        if (exactMatch) {
          bestMatch = exactMatch;
        }
      }

      // Get full details
      const details = await omdbService.getDetails(bestMatch.imdbID);
      
      if (!details) {
        return {
          imdbId: bestMatch.imdbID,
          posterUrl: bestMatch.Poster !== 'N/A' ? bestMatch.Poster : undefined,
        };
      }

      return {
        imdbId: details.imdbID,
        posterUrl: details.Poster !== 'N/A' ? details.Poster : undefined,
        plot: details.Plot,
        year: parseInt(details.Year, 10),
        totalSeasons: details.totalSeasons ? parseInt(details.totalSeasons, 10) : undefined,
      };
    } catch (error) {
      console.error(`[ContentScanner] OMDB lookup failed for ${result.title}:`, error);
      return null;
    }
  }

  /**
   * Check if an existing item needs updating and update it
   * Returns the existing item if found and updated, null otherwise
   */
  private async findAndUpdateExisting(result: ScanResult): Promise<MediaItem | null> {
    let existing: MediaItem | null = null;
    
    if (result.type === 'movie') {
      existing = await MediaItem.findOne({
        where: {
          type: 'movie',
          title: result.title,
          year: result.year,
        },
      });
    } else if (result.type === 'tv') {
      existing = await MediaItem.findOne({
        where: {
          type: 'tv',
          title: result.title,
          season: result.season,
          episode: result.episode,
        },
      });
    } else if (result.type === 'web') {
      existing = await MediaItem.findOne({
        where: {
          type: 'web',
          title: result.title,
        },
      });
    }
    
    return existing;
  }

  /**
   * Process a single scan result - create database entries and update files
   */
  async processScanResult(result: ScanResult): Promise<boolean> {
    if (result.alreadyInDb) {
      return true; // Already processed
    }

    if (!this.canProcessMore()) {
      return false; // Rate limited
    }

    this.itemsProcessedThisHour++;
    this.scanProgress.itemsThisHour = this.itemsProcessedThisHour;

    console.log(`[ContentScanner] Processing: ${result.type} - ${result.title}` +
      (result.season ? ` S${String(result.season).padStart(2, '0')}E${String(result.episode).padStart(2, '0')}` : ''));

    try {
      // Check if this item already exists (may need updating, not creation)
      const existingItem = await this.findAndUpdateExisting(result);
      
      // Look up OMDB metadata if needed
      let omdbData: Awaited<ReturnType<typeof this.lookupOmdbMetadata>> = null;
      
      if (result.needsOmdbLookup && (result.type === 'movie' || result.type === 'tv')) {
        omdbData = await this.lookupOmdbMetadata(result);
        
        if (omdbData) {
          result.imdbId = omdbData.imdbId;
        }
      }

      // For TV shows, ensure TVShow entity exists and has poster
      if (result.type === 'tv') {
        let tvShow = await TVShow.findOne({ where: { title: result.title } });
        
        if (!tvShow) {
          tvShow = await TVShow.create({
            id: uuidv4(),
            title: result.title,
            year: omdbData?.year || result.year,
            imdbId: omdbData?.imdbId || result.imdbId,
            posterUrl: omdbData?.posterUrl || result.metadata?.posterUrl,
            plot: omdbData?.plot || result.metadata?.plot,
            totalSeasons: omdbData?.totalSeasons || result.metadata?.totalSeasons,
          });
          console.log(`[ContentScanner] Created TVShow: ${result.title}`);
        } else if (!tvShow.posterUrl && omdbData?.posterUrl) {
          // Update existing TV show with missing poster
          await tvShow.update({
            posterUrl: omdbData.posterUrl,
            imdbId: omdbData.imdbId || tvShow.imdbId,
            plot: omdbData.plot || tvShow.plot,
          });
          console.log(`[ContentScanner] Updated TVShow poster: ${result.title}`);
        }
      }

      let mediaItem: MediaItem;
      
      if (existingItem) {
        // Update existing item with new data (especially poster URL)
        const updates: Partial<typeof existingItem> = {};
        
        if (omdbData?.posterUrl && !existingItem.posterUrl) {
          updates.posterUrl = omdbData.posterUrl;
        }
        if (omdbData?.imdbId && !existingItem.imdbId) {
          updates.imdbId = omdbData.imdbId;
        }
        if (omdbData?.plot && !existingItem.plot) {
          updates.plot = omdbData.plot;
        }
        if (result.filePath && !existingItem.filePath) {
          updates.diskPath = path.dirname(path.dirname(result.filePath));
          updates.filePath = path.relative(
            path.dirname(path.dirname(result.filePath)),
            result.filePath
          );
        }
        
        if (Object.keys(updates).length > 0) {
          await existingItem.update(updates);
          console.log(`[ContentScanner] Updated MediaItem: ${existingItem.type} - ${existingItem.title}` +
            (updates.posterUrl ? ' (added poster)' : ''));
        }
        
        mediaItem = existingItem;
      } else {
        // Create new MediaItem
        mediaItem = await MediaItem.create({
          id: uuidv4(),
          type: result.type,
          title: result.title,
          year: omdbData?.year || result.year,
          imdbId: omdbData?.imdbId || result.imdbId,
          posterUrl: omdbData?.posterUrl || result.metadata?.posterUrl,
          plot: omdbData?.plot || result.metadata?.plot,
          season: result.season,
          episode: result.episode,
          // Set file path if we have a storage file
          diskPath: result.filePath ? path.dirname(path.dirname(result.filePath)) : undefined,
          filePath: result.filePath ? path.relative(
            path.dirname(path.dirname(result.filePath)),
            result.filePath
          ) : undefined,
        });

        console.log(`[ContentScanner] Created MediaItem: ${mediaItem.type} - ${mediaItem.title}`);
      }

      // Create/update .strm and .yml files if needed
      if (result.source === 'storage' && !result.strmPath) {
        // We have a storage file but no content files - create them
        await mediaService.createMediaFiles(mediaItem);
        
        // If we have the file, update .strm to point directly to it
        if (result.filePath) {
          await mediaService.updateStrmFileToDirectPath(mediaItem, result.filePath);
        }
      }

      // Update YAML file with extended metadata
      const ymlPath = result.ymlPath || this.getYmlPath(result);
      if (ymlPath) {
        const extendedMetadata: ExtendedMediaMetadata = {
          title: result.title,
          year: omdbData?.year || result.year,
          imdbId: omdbData?.imdbId || result.imdbId,
          magnetUri: result.metadata?.magnetUri || undefined,
          season: result.season,
          episode: result.episode,
          addedAt: result.metadata?.addedAt || new Date().toISOString(),
          posterUrl: omdbData?.posterUrl || result.metadata?.posterUrl,
          plot: omdbData?.plot || result.metadata?.plot,
          totalSeasons: omdbData?.totalSeasons,
          scannedAt: new Date().toISOString(),
          recoveredFrom: result.source,
        };
        
        await this.writeYamlMetadata(ymlPath, extendedMetadata);
      }

      return true;
    } catch (error: any) {
      console.error(`[ContentScanner] Error processing ${result.title}:`, error.message);
      this.scanProgress.errors.push(`${result.title}: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the expected YML path for a scan result
   */
  private getYmlPath(result: ScanResult): string | null {
    const contentPath = config.paths.content;
    
    switch (result.type) {
      case 'movie':
        return path.join(
          contentPath, 
          'movies', 
          `${result.title} (${result.year})`,
          `${result.title} (${result.year}).yml`
        );
      case 'tv':
        const s = String(result.season || 1).padStart(2, '0');
        const e = String(result.episode || 1).padStart(2, '0');
        return path.join(
          contentPath,
          'tv',
          result.title,
          `Season ${result.season || 1}`,
          `${result.title} S${s}E${e}.yml`
        );
      case 'web':
        return path.join(
          contentPath,
          'web',
          'Unknown',  // Web content needs a channel
          `${result.title}.yml`
        );
      default:
        return null;
    }
  }

  /**
   * Run a full scan of content and storage directories
   */
  async runFullScan(): Promise<{
    scannedItems: number;
    newItems: number;
    updatedItems: number;
    errors: number;
  }> {
    if (this.isRunning) {
      console.log('[ContentScanner] Scan already in progress');
      return { scannedItems: 0, newItems: 0, updatedItems: 0, errors: 0 };
    }

    this.isRunning = true;
    this.scanProgress.phase = 'scanning-content';
    this.scanProgress.errors = [];

    const stats = {
      scannedItems: 0,
      newItems: 0,
      updatedItems: 0,
      errors: 0,
    };

    try {
      // Scan content directory
      const contentResults = await this.scanContentDirectory();
      
      // Scan storage directory
      this.scanProgress.phase = 'scanning-storage';
      const storageResults = await this.scanStorageDirectory();
      
      // Merge results, preferring storage results (they have file paths)
      const resultMap = new Map<string, ScanResult>();
      
      for (const result of contentResults) {
        const key = this.getResultKey(result);
        resultMap.set(key, result);
      }
      
      // Merge storage results
      for (const result of storageResults) {
        const key = this.getResultKey(result);
        const existing = resultMap.get(key);
        
        if (existing) {
          // Merge: use content metadata but add storage file path
          existing.filePath = result.filePath;
          existing.needsOmdbLookup = existing.needsOmdbLookup && result.needsOmdbLookup;
        } else {
          resultMap.set(key, result);
        }
      }
      
      const allResults = Array.from(resultMap.values());
      stats.scannedItems = allResults.length;
      
      // Mark items that already exist in database
      this.scanProgress.phase = 'processing';
      await this.markExistingItems(allResults);
      
      this.scanProgress.totalItems = allResults.length;
      this.scanProgress.processedItems = 0;
      
      // Process new items (rate-limited)
      for (const result of allResults) {
        if (result.alreadyInDb) {
          stats.updatedItems++;
          this.scanProgress.processedItems++;
          continue;
        }
        
        if (!this.canProcessMore()) {
          console.log(`[ContentScanner] Rate limit reached (${this.scanProgress.maxItemsPerHour}/hour). Stopping.`);
          break;
        }
        
        const success = await this.processScanResult(result);
        
        if (success) {
          stats.newItems++;
        } else {
          stats.errors++;
        }
        
        this.scanProgress.processedItems++;
      }
      
      this.scanProgress.phase = 'complete';
      this.scanProgress.lastScanTime = new Date();
      this.scanProgress.nextScanTime = new Date(Date.now() + this.scanIntervalMs);
      
      console.log(`[ContentScanner] Scan complete: ${stats.scannedItems} scanned, ` +
        `${stats.newItems} new, ${stats.updatedItems} updated, ${stats.errors} errors`);
      
      // Save scan timestamp
      await this.saveScanTimestamp();
      
      // Validate file paths - clear any stale entries where files were deleted
      await mediaService.validateFilePaths();
      
    } catch (error) {
      console.error('[ContentScanner] Scan failed:', error);
      this.scanProgress.phase = 'idle';
      stats.errors++;
    } finally {
      this.isRunning = false;
    }

    return stats;
  }

  /**
   * Get a unique key for a scan result
   */
  private getResultKey(result: ScanResult): string {
    if (result.type === 'movie') {
      return `movie:${result.title}:${result.year || 0}`;
    } else if (result.type === 'tv') {
      return `tv:${result.title}:${result.season}:${result.episode}`;
    } else {
      return `web:${result.title}`;
    }
  }

  /**
   * Save the last scan timestamp to the database
   */
  private async saveScanTimestamp(): Promise<void> {
    try {
      const [setting] = await Setting.findOrCreate({
        where: { key: 'contentScanner.lastScan' },
        defaults: { 
          id: uuidv4(),
          key: 'contentScanner.lastScan',
          value: new Date().toISOString(),
        },
      });
      
      await setting.update({ value: new Date().toISOString() });
    } catch (error) {
      console.error('[ContentScanner] Failed to save scan timestamp:', error);
    }
  }

  /**
   * Get the last scan timestamp from the database
   */
  async getLastScanTimestamp(): Promise<Date | null> {
    try {
      const setting = await Setting.findOne({
        where: { key: 'contentScanner.lastScan' },
      });
      
      return setting ? new Date(setting.value) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Start the periodic content scanner
   */
  start(intervalMs: number = 60 * 60 * 1000): void {
    this.scanIntervalMs = intervalMs;
    
    console.log(`[ContentScanner] Starting with ${intervalMs / 1000}s interval`);
    
    // Run initial scan after a short delay (let other services initialize)
    setTimeout(async () => {
      // First, fix any legacy .strm paths from before multi-disk support
      try {
        console.log('[ContentScanner] Checking for legacy .strm paths to fix...');
        const fixResult = await mediaService.fixAllLegacyStrmPaths();
        if (fixResult.fixed > 0) {
          console.log(`[ContentScanner] Fixed ${fixResult.fixed} legacy .strm paths`);
        }
      } catch (e) {
        console.error('[ContentScanner] Error fixing legacy .strm paths:', e);
      }
      
      const lastScan = await this.getLastScanTimestamp();
      const timeSinceLastScan = lastScan ? Date.now() - lastScan.getTime() : Infinity;
      
      if (timeSinceLastScan > intervalMs) {
        console.log('[ContentScanner] Running initial scan...');
        await this.runFullScan();
      } else {
        console.log(`[ContentScanner] Last scan was ${Math.round(timeSinceLastScan / 1000)}s ago, ` +
          `next scan in ${Math.round((intervalMs - timeSinceLastScan) / 1000)}s`);
        this.scanProgress.lastScanTime = lastScan || undefined;
        this.scanProgress.nextScanTime = new Date(Date.now() + intervalMs - timeSinceLastScan);
      }
    }, 10000); // 10 second delay
    
    // Set up periodic scanning
    this.scanTimer = setInterval(async () => {
      await this.runFullScan();
    }, intervalMs);
  }

  /**
   * Stop the periodic content scanner
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
      console.log('[ContentScanner] Stopped');
    }
  }
}

export const contentScannerService = new ContentScannerService();
