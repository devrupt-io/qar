import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { Op } from 'sequelize';
import { Download, MediaItem } from '../models';
import { qbittorrentService, QBittorrentTorrent, QBittorrentFile } from './qbittorrent';
import { mediaService } from './media';
import { jellyfinService } from './jellyfin';
import { config } from '../config';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const copyFile = promisify(fs.copyFile);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const open = promisify(fs.open);
const read = promisify(fs.read);
const close = promisify(fs.close);

// Track which files we've already processed to avoid re-processing
// Key: torrentHash:fileIndex, Value: timestamp when processed
const processedFiles = new Map<string, number>();

// Clean up old entries from processedFiles (older than 1 hour)
function cleanupProcessedFilesCache(): void {
  const oneHourAgo = Date.now() - 3600000;
  for (const [key, timestamp] of processedFiles.entries()) {
    if (timestamp < oneHourAgo) {
      processedFiles.delete(key);
    }
  }
}

// Interval for checking download progress (30 seconds)
const SYNC_INTERVAL_MS = 30000;

// Interval for cleaning up orphaned downloads (5 minutes)
const CLEANUP_INTERVAL_MS = 300000;

class DownloadManager {
  private syncIntervalId: NodeJS.Timeout | null = null;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private isSyncing = false;

  /**
   * Map QBittorrent's save path to our local path.
   * QBittorrent may report paths like "/downloads" which we need to map to "/qar/downloads"
   */
  private mapDownloadPath(qbtPath: string): string {
    // If QBittorrent reports /downloads, map it to our config path
    if (qbtPath.startsWith('/downloads')) {
      return qbtPath.replace('/downloads', config.paths.downloads);
    }
    // If already an absolute path with our prefix, use it as-is
    if (qbtPath.startsWith(config.paths.downloads)) {
      return qbtPath;
    }
    // Fallback: join with downloads path
    return path.join(config.paths.downloads, path.basename(qbtPath));
  }

  /**
   * Start the periodic download sync loop.
   * This runs every 30 seconds to check download progress and handle completions.
   * Also runs orphaned download cleanup every 5 minutes.
   */
  start(): void {
    if (this.syncIntervalId) {
      console.log('Download manager already running');
      return;
    }

    console.log(`Download manager started (sync interval: ${SYNC_INTERVAL_MS / 1000}s, cleanup interval: ${CLEANUP_INTERVAL_MS / 1000}s)`);
    
    // Run immediately on start
    this.syncDownloads();

    // Schedule periodic syncs
    this.syncIntervalId = setInterval(() => {
      this.syncDownloads();
    }, SYNC_INTERVAL_MS);
    
    // Schedule periodic cleanup of orphaned downloads
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupOrphanedDownloads().catch(err => {
        console.error('[DownloadManager] Auto-cleanup error:', err);
      });
    }, CLEANUP_INTERVAL_MS);
    
    // Run initial cleanup after 30 seconds (give time for QBittorrent to be available)
    setTimeout(() => {
      this.cleanupOrphanedDownloads().catch(err => {
        console.error('[DownloadManager] Initial cleanup error:', err);
      });
    }, 30000);
  }

  /**
   * Stop the periodic download sync loop.
   */
  stop(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    console.log('Download manager stopped');
  }

  /**
   * Sync all downloads with QBittorrent and handle completed ones.
   */
  async syncDownloads(): Promise<void> {
    // Prevent concurrent syncs
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;

    try {
      // Check if QBittorrent is available
      const available = await qbittorrentService.isAvailable();
      if (!available) {
        return;
      }

      // Get all torrents from QBittorrent
      const torrents = await qbittorrentService.getTorrents();
      
      // Get all active downloads from database (including completed ones that may need file processing)
      const activeDownloads = await Download.findAll({
        where: {
          status: ['pending', 'downloading', 'paused', 'completed'],
        },
        include: [{ model: MediaItem, as: 'mediaItem' }],
      });

      // Update each download's status
      for (const download of activeDownloads) {
        const torrent = torrents.find(
          (t) => t.hash.toLowerCase() === download.torrentHash?.toLowerCase()
        );

        if (torrent) {
          // Check if we need to configure file priorities (for TV episodes)
          await this.ensureFilePrioritiesConfigured(download, torrent);
          
          await this.updateDownloadFromTorrent(download, torrent);
          
          // For TV series downloads, process completed files incrementally
          // This allows episodes to be available before the entire season/series is done
          const mediaItem = (download as any).mediaItem as MediaItem | undefined;
          if (mediaItem?.type === 'tv' && download.status === 'downloading') {
            await this.processCompletedFilesIncrementally(download, torrent);
          }
        }
        // Note: We no longer log for missing torrents here - use cleanupOrphanedDownloads() to handle them
      }

      // Clean up old entries from the processed files cache
      cleanupProcessedFilesCache();

      // Also check for completed downloads that may need file processing
      await this.processCompletedDownloadsWithoutFiles();
    } catch (error) {
      console.error('Download sync error:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Ensure file priorities are configured for a torrent.
   * This is needed for TV content where we only want specific episodes.
   * 
   * Uses the detectedEpisodes from the download record if available,
   * otherwise falls back to the single media item's episode.
   */
  private async ensureFilePrioritiesConfigured(
    download: Download,
    torrent: QBittorrentTorrent
  ): Promise<void> {
    try {
      const mediaItem = (download as any).mediaItem as MediaItem | undefined;
      if (!mediaItem || mediaItem.type !== 'tv') {
        return; // Only configure for TV content
      }

      // Check if files are available
      const files = await qbittorrentService.getTorrentFiles(torrent.hash);
      if (files.length === 0) {
        return; // Metadata not loaded yet
      }

      // Check if any media files are selected
      const mediaFiles = files.filter(f => this.isMediaFile(f.name));
      const selectedFiles = mediaFiles.filter(f => f.priority > 0);

      // If we have media files but none selected, we need to configure priorities
      if (mediaFiles.length > 0 && selectedFiles.length === 0) {
        // Use detectedEpisodes from download record if available
        // This contains all episodes we want to download from the torrent
        const detectedEpisodes = download.detectedEpisodes;
        let wantedEpisodes: Array<{ season: number; episode: number }>;
        
        console.log(`[DownloadManager] ensureFilePrioritiesConfigured for ${mediaItem.title}: detectedEpisodes =`, JSON.stringify(detectedEpisodes));
        
        if (detectedEpisodes?.episodes && detectedEpisodes.episodes.length > 0) {
          // Use the full list of detected episodes - this is the primary path
          // The episodes array should contain all episodes we want from this torrent
          wantedEpisodes = detectedEpisodes.episodes;
          console.log(`[DownloadManager] Configuring file priorities for: ${mediaItem.title} - ${detectedEpisodes.description} (${wantedEpisodes.length} episodes)`);
          console.log(`[DownloadManager] Episodes to download: ${wantedEpisodes.map(e => `S${e.season}E${e.episode}`).join(', ')}`);
        } else if (detectedEpisodes?.type === 'complete' || detectedEpisodes?.type === 'season') {
          // For complete series or season packs without specific episode list,
          // we want all episodes - set all media files to download
          console.log(`[DownloadManager] Configuring file priorities for: ${mediaItem.title} - ${detectedEpisodes.description} (all files - no specific episodes listed)`);
          const allFileIds = mediaFiles.map(f => f.index);
          if (allFileIds.length > 0) {
            await qbittorrentService.setFilePriority(torrent.hash, allFileIds, 1);
            console.log(`[DownloadManager] Selected all ${allFileIds.length} media files for download`);
          }
          return;
        } else {
          // Fall back to single episode from media item
          // This should only happen if detectedEpisodes is missing entirely
          wantedEpisodes = [{ 
            season: mediaItem.season || 1, 
            episode: mediaItem.episode || 1 
          }];
          console.log(`[DownloadManager] Fallback: Configuring file priorities for single episode: ${mediaItem.title} S${mediaItem.season}E${mediaItem.episode}`);
        }
        
        const selectedCount = await this.configureFilePriorities(torrent.hash, wantedEpisodes);
        if (selectedCount > 0) {
          console.log(`[DownloadManager] Selected ${selectedCount} files for download`);
        } else {
          console.log(`[DownloadManager] Warning: Could not select any files for ${detectedEpisodes?.description || `S${mediaItem.season}E${mediaItem.episode}`}`);
          // If we can't find the specific episodes, download everything as fallback
          // This can happen if the torrent contains different episode format than expected
          const allFileIds = mediaFiles.map(f => f.index);
          if (allFileIds.length > 0) {
            await qbittorrentService.setFilePriority(torrent.hash, allFileIds, 1);
            console.log(`[DownloadManager] Fallback: Selected all ${allFileIds.length} media files for download`);
          }
        }
      } else if (selectedFiles.length > 1) {
        // Files are already selected - ensure sequential priorities are applied.
        // If all selected files have the same priority, re-apply sequential ordering.
        const detectedEpisodes = download.detectedEpisodes;
        if (detectedEpisodes?.episodes && detectedEpisodes.episodes.length > 1) {
          const priorities = new Set(selectedFiles.map(f => f.priority));
          if (priorities.size === 1) {
            console.log(`[DownloadManager] Re-applying sequential priorities for ${mediaItem.title}`);
            await this.configureFilePriorities(torrent.hash, detectedEpisodes.episodes);
          }
        }
      }
    } catch (error) {
      console.error('[DownloadManager] Error ensuring file priorities:', error);
    }
  }

  /**
   * Process completed files incrementally for an active torrent download.
   * 
   * This allows users to watch completed episodes while the rest of a season/series
   * is still downloading. For each completed file:
   * 1. Copy it to storage
   * 2. Update the .strm file to point to the direct path
   * 3. Mark the file as "do not download" in QBittorrent (priority 0)
   * 4. Delete the file from downloads directory to free up space
   * 
   * This is crucial for large series downloads that would otherwise take days.
   */
  private async processCompletedFilesIncrementally(
    download: Download,
    torrent: QBittorrentTorrent
  ): Promise<void> {
    try {
      const mediaItem = (download as any).mediaItem as MediaItem | undefined;
      if (!mediaItem || mediaItem.type !== 'tv') {
        return;
      }

      // Get all files in the torrent
      const files = await qbittorrentService.getTorrentFiles(torrent.hash);
      if (files.length === 0) {
        return;
      }

      // Find files that are 100% complete and still set to download (priority > 0)
      const completedFiles = files.filter(f => 
        f.progress >= 1 && 
        f.priority > 0 && 
        this.isMediaFile(f.name)
      );

      if (completedFiles.length === 0) {
        return;
      }

      // Map QBittorrent path to our local path
      const contentPath = this.mapDownloadPath(torrent.content_path);
      
      // Get all episodes for this TV show
      const allEpisodes = await MediaItem.findAll({
        where: {
          type: 'tv',
          title: mediaItem.title,
        },
      });

      let processedCount = 0;

      for (const file of completedFiles) {
        // Check if we've already processed this file
        const fileKey = `${torrent.hash}:${file.index}`;
        if (processedFiles.has(fileKey)) {
          continue;
        }

        // Extract episode info from filename
        const episodeInfo = this.extractEpisodeFromFilename(file.name);
        if (!episodeInfo) {
          console.log(`[IncrementalProcess] Could not extract episode info from: ${file.name}`);
          continue;
        }

        // Find the matching episode in our database
        let matchingEpisode = allEpisodes.find(
          ep => ep.season === episodeInfo.season && ep.episode === episodeInfo.episode
        );

        if (!matchingEpisode) {
          // Episode not in database - create it automatically
          console.log(`[IncrementalProcess] Creating missing episode S${episodeInfo.season}E${episodeInfo.episode} for: ${mediaItem.title}`);
          const createdEpisode = await this.createMissingEpisode(mediaItem, episodeInfo.season, episodeInfo.episode);
          if (!createdEpisode) {
            console.log(`[IncrementalProcess] Failed to create episode S${episodeInfo.season}E${episodeInfo.episode}`);
            continue;
          }
          matchingEpisode = createdEpisode;
          // Add to allEpisodes so we don't try to create it again
          allEpisodes.push(matchingEpisode);
        }

        // Check if this episode already has a file (already processed)
        if (matchingEpisode.filePath && matchingEpisode.diskPath) {
          // Already processed, but make sure QBittorrent file priority is set to 0
          // and the file is deleted from downloads (cleanup from previous runs)
          if (file.priority > 0) {
            await qbittorrentService.setFilePriority(torrent.hash, [file.index], 0);
            console.log(`[IncrementalProcess] Set priority 0 for already-processed: S${episodeInfo.season}E${episodeInfo.episode}`);
            
            // Also try to delete the file if it still exists
            const torrentFolder = path.basename(torrent.content_path);
            const downloadFilePath = path.join(this.mapDownloadPath(torrent.save_path), file.name);
            try {
              await unlink(downloadFilePath);
              console.log(`[IncrementalProcess] Cleaned up stale file: ${downloadFilePath}`);
            } catch {
              // File might already be deleted, that's fine
            }
          }
          processedFiles.set(fileKey, Date.now());
          continue;
        }

        // Build the full path to the completed file
        let filePath: string;
        if (torrent.content_path === torrent.save_path) {
          // Single file torrent or root download
          filePath = path.join(contentPath, file.name);
        } else {
          // Multi-file torrent with folder
          const torrentFolder = path.basename(torrent.content_path);
          // The file.name already contains the relative path from the torrent folder
          filePath = path.join(this.mapDownloadPath(torrent.save_path), file.name);
        }

        // Validate the file
        const isValid = await this.isValidMediaFile(filePath);
        if (!isValid) {
          console.log(`[IncrementalProcess] File not valid yet: ${file.name}`);
          continue;
        }

        console.log(`[IncrementalProcess] Processing completed file: ${file.name} -> S${episodeInfo.season}E${episodeInfo.episode}`);

        try {
          // Copy file to library (not move, since we need to delete from torrent separately)
          const libraryPath = await this.copyToLibrary(filePath, matchingEpisode);
          console.log(`[IncrementalProcess] Copied to library: ${libraryPath}`);

          // Update the .strm file to point directly to the file
          const strmPath = await mediaService.updateStrmFileToDirectPath(matchingEpisode, libraryPath);
          if (strmPath) {
            console.log(`[IncrementalProcess] Updated .strm for: ${matchingEpisode.title} S${matchingEpisode.season}E${matchingEpisode.episode}`);
            
            // Refresh Jellyfin
            await jellyfinService.refreshItemByPath(strmPath);
            await jellyfinService.markItemUnwatchedByPath(strmPath);
          }

          // Mark file as "do not download" in QBittorrent (priority 0)
          // This prevents QBittorrent from re-downloading or keeping the file
          await qbittorrentService.setFilePriority(torrent.hash, [file.index], 0);
          console.log(`[IncrementalProcess] Set file priority to 0 (do not download): ${file.name}`);

          // Delete the file from downloads directory to free up space
          try {
            await unlink(filePath);
            console.log(`[IncrementalProcess] Deleted from downloads: ${filePath}`);
          } catch (deleteError) {
            console.warn(`[IncrementalProcess] Could not delete file: ${filePath} -`, deleteError);
          }

          // Mark this file as processed
          processedFiles.set(fileKey, Date.now());
          processedCount++;

        } catch (processError) {
          console.error(`[IncrementalProcess] Error processing ${file.name}:`, processError);
        }
      }

      if (processedCount > 0) {
        console.log(`[IncrementalProcess] Processed ${processedCount} completed files for ${mediaItem.title}`);
      }

    } catch (error) {
      console.error('[IncrementalProcess] Error:', error);
    }
  }

  /**
   * Copy a file to the library (instead of move).
   * Used for incremental processing where we need to delete the torrent file separately.
   */
  private async copyToLibrary(
    sourcePath: string,
    media: MediaItem
  ): Promise<string> {
    const disk = await mediaService.findBestDisk(media.type, media.title);
    let destDir: string;
    let destFileName: string;
    
    const sourceExt = path.extname(sourcePath);
    
    switch (media.type) {
      case 'movie':
        destDir = path.join(disk, 'movies', `${media.title} (${media.year})`);
        destFileName = `${media.title} (${media.year})${sourceExt}`;
        break;
      case 'tv':
        destDir = path.join(disk, 'tv', media.title, `Season ${media.season || 1}`);
        destFileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}${sourceExt}`;
        break;
      case 'web':
        destDir = path.join(disk, 'web', media.channel || 'Unknown');
        destFileName = `${media.title}${sourceExt}`;
        break;
      default:
        throw new Error(`Unknown media type: ${media.type}`);
    }
    
    const { mkdir: mkdirPromise } = require('fs').promises;
    await mkdirPromise(destDir, { recursive: true });
    
    const destPath = path.join(destDir, destFileName);
    
    // Find and copy subtitle files before copying the video
    const subtitleFiles = await mediaService.findSubtitleFiles(sourcePath);
    if (subtitleFiles.length > 0) {
      const destBaseName = path.basename(destFileName, sourceExt);
      const copiedCount = await mediaService.copySubtitles(subtitleFiles, destDir, destBaseName);
      console.log(`[IncrementalProcess] Copied ${copiedCount} subtitle file(s) for ${media.title}`);
    }
    
    // Copy the video file
    await copyFile(sourcePath, destPath);
    
    // Update media item
    await media.update({
      diskPath: disk,
      filePath: path.relative(disk, destPath),
    });
    
    return destPath;
  }

  /**
   * Boost the priority of a movie torrent.
   * Called when a user starts watching the progress video for a movie.
   * 
   * Sets the torrent to top of queue and force starts it.
   * 
   * @param media - The media item (movie) to prioritize
   * @returns true if priority was boosted, false otherwise
   */
  async boostMoviePriority(media: MediaItem): Promise<boolean> {
    if (media.type !== 'movie') {
      return false;
    }

    try {
      // Find the download for this movie
      const download = await Download.findOne({
        where: { 
          mediaItemId: media.id,
          status: ['downloading', 'pending', 'paused'],
        },
      });

      if (!download || !download.torrentHash) {
        console.log(`[BoostMoviePriority] No active download found for ${media.title}`);
        return false;
      }

      console.log(`[BoostMoviePriority] Boosting priority for ${media.title} (hash: ${download.torrentHash})`);

      // Set torrent to top of queue
      await qbittorrentService.setTopPriority(download.torrentHash);
      
      // Enable first/last piece priority for faster initial playback
      await qbittorrentService.setFirstLastPiecePriority(download.torrentHash);

      // Force resume if paused or pending
      if (download.status === 'paused' || download.status === 'pending') {
        await qbittorrentService.forceResume(download.torrentHash);
        await download.update({ status: 'downloading' });
      }

      console.log(`[BoostMoviePriority] Priority boosted for ${media.title}`);
      return true;

    } catch (error) {
      console.error('[BoostMoviePriority] Error:', error);
      return false;
    }
  }

  /**
   * Boost the priority of a specific episode in a torrent.
   * Called when a user starts watching the progress video.
   * 
   * Sets the file to maximum priority (7) so it downloads before other files.
   * 
   * @param media - The media item (episode) to prioritize
   * @returns true if priority was boosted, false otherwise
   */
  async boostEpisodePriority(media: MediaItem): Promise<boolean> {
    if (media.type !== 'tv') {
      return false;
    }

    try {
      const targetSeason = media.season || 1;
      const targetEpisode = media.episode || 1;

      // Find all active downloads for this TV show by title
      // Multiple downloads may exist (one per season), so we need to find the right one
      const downloads = await Download.findAll({
        where: {
          status: ['downloading', 'pending', 'paused'],
        },
        include: [{
          model: MediaItem,
          as: 'mediaItem',
          required: true,
        }],
      });

      // Filter to downloads for this TV show
      const matchingDownloads = downloads.filter(d => {
        const mediaItem = (d as any).mediaItem as MediaItem | undefined;
        return mediaItem && mediaItem.type === 'tv' && mediaItem.title === media.title;
      });

      if (matchingDownloads.length === 0) {
        console.log(`[BoostPriority] No active downloads found for ${media.title}`);
        return false;
      }

      console.log(`[BoostPriority] Found ${matchingDownloads.length} downloads for ${media.title}, searching for S${targetSeason}E${targetEpisode}`);

      // Search through all matching downloads to find one containing the requested episode
      let foundDownload: Download | null = null;
      let targetFile: QBittorrentFile | null = null;

      for (const download of matchingDownloads) {
        if (!download.torrentHash) {
          continue;
        }

        try {
          // Get files in this torrent
          const files = await qbittorrentService.getTorrentFiles(download.torrentHash);
          if (files.length === 0) {
            console.log(`[BoostPriority] No files in torrent ${download.torrentHash.substring(0, 12)} (may be stale)`);
            continue;
          }

          // Look for the episode we want
          for (const file of files) {
            if (!this.isMediaFile(file.name)) {
              continue;
            }
            
            const episodeInfo = this.extractEpisodeFromFilename(file.name);
            if (episodeInfo && 
                episodeInfo.season === targetSeason && 
                episodeInfo.episode === targetEpisode) {
              targetFile = file;
              foundDownload = download;
              console.log(`[BoostPriority] Found S${targetSeason}E${targetEpisode} in torrent ${download.torrentHash.substring(0, 12)}`);
              break;
            }
          }

          if (targetFile) {
            break; // Found the episode, stop searching
          }
        } catch (error) {
          // Torrent might not exist in QBittorrent anymore
          console.log(`[BoostPriority] Error checking torrent ${download.torrentHash.substring(0, 12)}: torrent may not exist`);
          continue;
        }
      }

      if (!foundDownload || !targetFile) {
        console.log(`[BoostPriority] Could not find S${targetSeason}E${targetEpisode} in any active torrent for ${media.title}`);
        return false;
      }

      // Check if file is already complete
      if (targetFile.progress >= 1) {
        console.log(`[BoostPriority] File already complete: S${targetSeason}E${targetEpisode}`);
        return true;
      }

      // Set file priority to maximum (7)
      if (targetFile.priority !== 7) {
        await qbittorrentService.setFilePriority(foundDownload.torrentHash!, [targetFile.index], 7);
        console.log(`[BoostPriority] Set maximum priority for: ${targetFile.name}`);
      }

      // Also ensure the file is set to download (priority > 0)
      if (targetFile.priority === 0) {
        await qbittorrentService.setFilePriority(foundDownload.torrentHash!, [targetFile.index], 7);
        console.log(`[BoostPriority] Enabled download for: ${targetFile.name}`);
      }

      // Set torrent to top of queue
      await qbittorrentService.setTopPriority(foundDownload.torrentHash!);
      
      // Enable first/last piece priority for this file (helps with playback)
      await qbittorrentService.setFirstLastPiecePriority(foundDownload.torrentHash!);

      // Apply sequential download strategy for this season
      // This sets the current season to high priority (6) while keeping
      // the specifically requested episode at maximum (7)
      await this.applySequentialDownloadStrategy(
        foundDownload.torrentHash!,
        targetSeason,
        { season: targetSeason, episode: targetEpisode }
      );

      // Force resume if paused
      if (foundDownload.status === 'paused') {
        await qbittorrentService.forceResume(foundDownload.torrentHash!);
        await foundDownload.update({ status: 'downloading' });
      }

      console.log(`[BoostPriority] Priority boosted for ${media.title} S${targetSeason}E${targetEpisode}`);
      return true;

    } catch (error) {
      console.error('[BoostPriority] Error:', error);
      return false;
    }
  }

  /**
   * Process downloads marked as completed but without file paths.
   * This handles edge cases where completion handling failed previously.
   * Also cleans up stale completed downloads that are stuck.
   */
  private async processCompletedDownloadsWithoutFiles(): Promise<void> {
    try {
      // Find completed downloads (regardless of completedAt value)
      const completedDownloads = await Download.findAll({
        where: {
          status: 'completed',
        },
        include: [{ model: MediaItem, as: 'mediaItem' }],
      });

      for (const download of completedDownloads) {
        const mediaItem = (download as any).mediaItem as MediaItem | undefined;
        
        // If media item has filePath, the download is properly completed
        // Just ensure completedAt is set
        if (mediaItem?.filePath) {
          if (!download.completedAt) {
            await download.update({ completedAt: new Date() });
            console.log(`Set completedAt for finished download: ${mediaItem.title}`);
          }
          continue;
        }
        
        // Media item doesn't have filePath - try to re-process
        if (mediaItem) {
          // Get torrent info from QBittorrent to re-process
          const torrent = await qbittorrentService.getTorrent(download.torrentHash || '');
          if (torrent && torrent.progress >= 1) {
            console.log(`Re-processing completed download for: ${mediaItem.title}`);
            await this.handleDownloadCompletion(download, torrent);
          } else if (!torrent && download.torrentHash) {
            // Torrent no longer exists in QBittorrent - this is a stale download
            // If it's been marked completed but has no file and no torrent, 
            // mark it as failed so it can be retried
            console.log(`Stale completed download found (no torrent): ${mediaItem.title}`);
            await download.update({
              status: 'failed',
              error: 'Torrent removed before file was processed',
            });
          }
        }
      }
    } catch (error) {
      console.error('Error processing completed downloads:', error);
    }
  }

  /**
   * Update a download record from QBittorrent torrent info.
   * Handles completion, file movement, and cleanup.
   */
  private async updateDownloadFromTorrent(
    download: Download,
    torrent: QBittorrentTorrent
  ): Promise<void> {
    const oldStatus = download.status;
    let newStatus = download.status;

    // Check if any files are selected for download
    const files = await qbittorrentService.getTorrentFiles(torrent.hash);
    const selectedFiles = files.filter(f => f.priority > 0);
    const hasSelectedFiles = selectedFiles.length > 0;
    
    // Calculate effective progress based on selected files
    // If no files selected, we need to wait for file selection
    let effectiveProgress = torrent.progress;
    if (!hasSelectedFiles && files.length > 0) {
      // No files selected - this torrent is waiting for configuration
      effectiveProgress = 0;
    }

    // Determine new status based on torrent state
    if (effectiveProgress >= 1 && hasSelectedFiles) {
      newStatus = 'completed';
    } else if (!hasSelectedFiles && files.length > 0) {
      // Files are available but none selected - waiting for configuration
      // This can happen when metadata is loaded but file priorities aren't set yet
      newStatus = 'pending';
      console.log(`[DownloadManager] Torrent ${torrent.hash} has no files selected, marking as pending`);
    } else if (torrent.state === 'pausedDL' || torrent.state === 'pausedUP' || torrent.state === 'stoppedDL' || torrent.state === 'stoppedUP') {
      newStatus = 'paused';
    } else if (torrent.state === 'error') {
      newStatus = 'failed';
    } else if (torrent.state === 'metaDL') {
      // Still downloading metadata
      newStatus = 'pending';
    } else {
      newStatus = 'downloading';
    }

    // Update download record (including torrent name for display)
    await download.update({
      progress: effectiveProgress * 100,
      downloadSpeed: torrent.dlspeed,
      eta: torrent.eta,
      totalSize: torrent.size,
      downloadedSize: torrent.downloaded,
      status: newStatus,
      torrentName: torrent.name, // Store the actual torrent name
    });

    // Handle completion (only if files were actually selected and downloaded)
    if (newStatus === 'completed' && oldStatus !== 'completed' && hasSelectedFiles) {
      console.log(`Download completed: ${torrent.name}`);
      await this.handleDownloadCompletion(download, torrent);
    }
  }

  /**
   * Handle a completed download:
   * 1. Find the downloaded file(s)
   * 2. Copy to the appropriate storage location(s)
   * 3. Remove the torrent from QBittorrent
   * 4. Update the database
   * 
   * For season packs, this matches each file to its corresponding episode.
   */
  private async handleDownloadCompletion(
    download: Download,
    torrent: QBittorrentTorrent
  ): Promise<void> {
    try {
      // Get the associated media item
      const mediaItem = await MediaItem.findByPk(download.mediaItemId);
      if (!mediaItem) {
        console.error(`Media item ${download.mediaItemId} not found for download`);
        return;
      }

      // Use content_path which is the actual path where files are downloaded
      // This handles the case where folder name differs from torrent name
      const contentPath = this.mapDownloadPath(torrent.content_path);
      console.log(`Looking for media files at: ${contentPath} (QBT reported: ${torrent.content_path})`);
      
      const files = await this.findMediaFilesAtPath(contentPath);

      if (files.length === 0) {
        console.error(`No media files found at ${contentPath}`);
        await download.update({
          error: 'Downloaded files not found',
          status: 'failed',
        });
        return;
      }

      // Check if this is a season pack download with multiple episodes
      const detectedEpisodes = download.detectedEpisodes;
      const isSeasonPack = detectedEpisodes && 
        (detectedEpisodes.type === 'season' || detectedEpisodes.type === 'complete' || 
         detectedEpisodes.type === 'range') && 
        files.length > 1;

      if (isSeasonPack && mediaItem.type === 'tv') {
        // Handle season pack: match each file to its episode
        await this.handleSeasonPackCompletion(download, mediaItem, files, torrent);
      } else {
        // Handle single file download (movie or single episode)
        await this.handleSingleFileCompletion(download, mediaItem, files, torrent);
      }
    } catch (error) {
      console.error('Error handling download completion:', error);
      await download.update({
        error: `Completion handling failed: ${error}`,
        status: 'failed',
      });
    }
  }

  /**
   * Handle completion of a single file download (movie or single episode).
   */
  private async handleSingleFileCompletion(
    download: Download,
    mediaItem: MediaItem,
    files: string[],
    torrent: QBittorrentTorrent
  ): Promise<void> {
    // Pick the best file (largest video file)
    const bestFile = await this.selectBestMediaFile(files);
    console.log(`Selected file for library: ${bestFile}`);

    // Validate that the file has actual media content
    const isValid = await this.isValidMediaFile(bestFile);
    if (!isValid) {
      console.error(`File validation failed for ${bestFile} - file may be incomplete or corrupt`);
      await download.update({
        status: 'downloading',
        error: 'File validation failed - waiting for data to be written',
      });
      return;
    }

    // Copy to library
    const libraryPath = await mediaService.moveToLibrary(bestFile, mediaItem);
    console.log(`Moved to library: ${libraryPath}`);

    // Update download as completed
    await download.update({
      completedAt: new Date(),
      status: 'completed',
    });

    // Update .yml metadata with torrent information for future re-downloads
    await mediaService.updateMediaMetadata(mediaItem, {
      magnetUri: download.magnetUri,
      torrentHash: download.torrentHash || undefined,
      torrentName: download.torrentName || torrent.name || undefined,
      downloadedAt: new Date().toISOString(),
    });

    // Remove torrent from QBittorrent
    if (download.torrentHash) {
      const deleted = await qbittorrentService.deleteTorrent(download.torrentHash, true);
      if (deleted) {
        console.log(`Removed torrent ${download.torrentHash} from QBittorrent`);
      }
    }

    // Update the .strm file to point directly to the file on disk
    const strmPath = await mediaService.updateStrmFileToDirectPath(mediaItem, libraryPath);
    if (strmPath) {
      console.log(`Updated .strm file for direct play: ${strmPath}`);
      
      // Trigger a full library scan so Jellyfin picks up the new file
      await jellyfinService.scanLibrary();
      
      // Also try per-item refresh for faster update
      const refreshed = await jellyfinService.refreshItemByPath(strmPath);
      if (refreshed) {
        console.log(`Triggered Jellyfin refresh for: ${mediaItem.title}`);
      }
      
      // Mark the item as unwatched in Jellyfin so it shows as "new"
      await jellyfinService.markItemUnwatchedByPath(strmPath);
    }

    console.log(`Download complete and processed: ${mediaItem.title}`);
  }

  /**
   * Handle completion of a season pack download.
   * Matches each file in the torrent to its corresponding episode.
   */
  private async handleSeasonPackCompletion(
    download: Download,
    primaryMediaItem: MediaItem,
    files: string[],
    torrent: QBittorrentTorrent
  ): Promise<void> {
    console.log(`Processing season pack with ${files.length} files for: ${primaryMediaItem.title}`);
    
    // Get all episodes for this TV show
    const allEpisodes = await MediaItem.findAll({
      where: {
        type: 'tv',
        title: primaryMediaItem.title,
      },
    });

    const detectedEpisodes = download.detectedEpisodes;
    let processedCount = 0;
    let failedCount = 0;

    // For each file, try to match it to an episode
    for (const file of files) {
      const filename = path.basename(file);
      
      // Validate the file first
      const isValid = await this.isValidMediaFile(file);
      if (!isValid) {
        console.log(`Skipping invalid/incomplete file: ${filename}`);
        failedCount++;
        continue;
      }

      // Try to detect episode info from the filename
      const episodeMatch = this.extractEpisodeFromFilename(filename);
      
      if (!episodeMatch) {
        console.log(`Could not extract episode info from: ${filename}`);
        failedCount++;
        continue;
      }

      const { season, episode } = episodeMatch;
      
      // Find the matching episode in our database
      const matchingEpisode = allEpisodes.find(
        ep => ep.season === season && ep.episode === episode
      );

      if (!matchingEpisode) {
        console.log(`No matching episode S${season}E${episode} in database for: ${filename}`);
        // Create the episode if it doesn't exist
        const newEpisode = await this.createMissingEpisode(primaryMediaItem, season, episode);
        if (newEpisode) {
          await this.processEpisodeFile(file, newEpisode);
          processedCount++;
        } else {
          failedCount++;
        }
        continue;
      }

      // Process this file for the matched episode
      await this.processEpisodeFile(file, matchingEpisode);
      processedCount++;
    }

    console.log(`Season pack processing complete: ${processedCount} files processed, ${failedCount} failed`);

    // Trigger Jellyfin library scan after processing all episodes
    if (processedCount > 0) {
      await jellyfinService.scanLibrary();
    }

    // Update download as completed
    await download.update({
      completedAt: new Date(),
      status: 'completed',
    });

    // Update .yml metadata with torrent information for the main media item
    await mediaService.updateMediaMetadata(primaryMediaItem, {
      magnetUri: download.magnetUri,
      torrentHash: download.torrentHash || undefined,
      torrentName: download.torrentName || torrent.name || undefined,
      downloadedAt: new Date().toISOString(),
    });

    // Remove torrent from QBittorrent
    if (download.torrentHash) {
      const deleted = await qbittorrentService.deleteTorrent(download.torrentHash, true);
      if (deleted) {
        console.log(`Removed torrent ${download.torrentHash} from QBittorrent`);
      }
    }
  }

  /**
   * Extract season and episode numbers from a filename.
   * Handles formats like S01E05, 1x05, etc.
   */
  private extractEpisodeFromFilename(filename: string): { season: number; episode: number } | null {
    // Try S01E05 format
    const sxxexxMatch = filename.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
    if (sxxexxMatch) {
      return {
        season: parseInt(sxxexxMatch[1], 10),
        episode: parseInt(sxxexxMatch[2], 10),
      };
    }

    // Try 1x05 format
    const altMatch = filename.match(/(\d{1,2})x(\d{1,2})/);
    if (altMatch) {
      return {
        season: parseInt(altMatch[1], 10),
        episode: parseInt(altMatch[2], 10),
      };
    }

    // Try Episode.05 or E05 format (assuming season 1)
    const episodeOnlyMatch = filename.match(/[Ee]pisode[.\s]?(\d{1,2})|[Ee](\d{1,2})(?!\d)/);
    if (episodeOnlyMatch) {
      return {
        season: 1,
        episode: parseInt(episodeOnlyMatch[1] || episodeOnlyMatch[2], 10),
      };
    }

    return null;
  }

  /**
   * Create a missing episode entry when downloading a season pack.
   */
  private async createMissingEpisode(
    template: MediaItem,
    season: number,
    episode: number
  ): Promise<MediaItem | null> {
    try {
      const { v4: uuidv4 } = require('uuid');
      const newEpisode = await MediaItem.create({
        id: uuidv4(),
        type: 'tv',
        title: template.title,
        year: template.year,
        imdbId: template.imdbId,
        posterUrl: template.posterUrl,
        plot: template.plot,
        season,
        episode,
      });

      // Create .strm and .yml files
      await mediaService.createMediaFiles(newEpisode);
      console.log(`Created missing episode: ${template.title} S${season}E${episode}`);
      return newEpisode;
    } catch (error) {
      console.error(`Failed to create missing episode S${season}E${episode}:`, error);
      return null;
    }
  }

  /**
   * Process a single episode file from a season pack.
   */
  private async processEpisodeFile(filePath: string, episode: MediaItem): Promise<void> {
    try {
      // Copy to library
      const libraryPath = await mediaService.moveToLibrary(filePath, episode);
      console.log(`Moved episode S${episode.season}E${episode.episode} to: ${libraryPath}`);

      // Update the .strm file to point directly to the file on disk
      const strmPath = await mediaService.updateStrmFileToDirectPath(episode, libraryPath);
      if (strmPath) {
        const refreshed = await jellyfinService.refreshItemByPath(strmPath);
        if (refreshed) {
          console.log(`Triggered Jellyfin refresh for: ${episode.title} S${episode.season}E${episode.episode}`);
        }
        
        // Mark the item as unwatched in Jellyfin so it shows as "new"
        await jellyfinService.markItemUnwatchedByPath(strmPath);
      }
    } catch (error) {
      console.error(`Failed to process episode file ${filePath}:`, error);
    }
  }

  /**
   * Find all media files at a specific content path from QBittorrent.
   * The content_path can be either a file or a directory.
   */
  private async findMediaFilesAtPath(contentPath: string): Promise<string[]> {
    try {
      const pathStat = await stat(contentPath);
      
      if (pathStat.isFile()) {
        // Single file torrent - check if it's a media file
        if (this.isMediaFile(contentPath)) {
          console.log(`Found single file torrent: ${contentPath}`);
          return [contentPath];
        }
        return [];
      }
      
      // Directory - search recursively for media files
      const files = await this.searchMediaFilesInDir(contentPath);
      console.log(`Found ${files.length} media files in: ${contentPath}`);
      return files;
    } catch (e) {
      console.error(`Error accessing content path ${contentPath}:`, e);
      return [];
    }
  }

  /**
   * Find all media files for a specific torrent.
   * Searches the torrent's subdirectory first, as torrents download to their own folder.
   * Only falls back to the root directory for single-file torrents.
   */
  private async findMediaFiles(dir: string, torrentName?: string): Promise<string[]> {
    // If torrentName provided, try looking in a subdirectory with that name FIRST
    // This is the common case - torrents download to their own folder
    if (torrentName) {
      const subDir = path.join(dir, torrentName);
      const foundInSubDir = await this.searchMediaFilesInDir(subDir);
      if (foundInSubDir.length > 0) {
        console.log(`Found ${foundInSubDir.length} media files in torrent folder: ${subDir}`);
        return foundInSubDir;
      }
      
      // Try looking for a direct file match (single file torrent)
      const directFile = path.join(dir, torrentName);
      try {
        const fileStat = await stat(directFile);
        if (fileStat.isFile() && this.isMediaFile(torrentName)) {
          console.log(`Found single file torrent: ${directFile}`);
          return [directFile];
        }
      } catch {
        // File doesn't exist, that's fine
      }
    }

    // Fallback: search ONLY the root directory's immediate files (not subdirectories)
    // This prevents picking up files from other torrents
    console.log(`Searching for media files directly in: ${dir}`);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && this.isMediaFile(entry.name)) {
          files.push(path.join(dir, entry.name));
        }
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Search for media files in a directory recursively.
   */
  private async searchMediaFilesInDir(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.searchMediaFilesInDir(fullPath);
          files.push(...subFiles);
        } else if (this.isMediaFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch (e) {
      // Directory doesn't exist or not accessible
    }

    return files;
  }

  /**
   * Check if a file is a media file by extension.
   */
  private isMediaFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'].includes(ext);
  }

  /**
   * Validate that a media file has valid content by checking its header.
   * This prevents moving pre-allocated sparse files that contain no actual data.
   * 
   * MKV files start with EBML header: 0x1A 0x45 0xDF 0xA3
   * MP4/MOV files have 'ftyp' signature at offset 4
   * AVI files start with 'RIFF' followed by 'AVI '
   * WebM files use the same EBML header as MKV
   * 
   * Returns true if the file appears to have valid media content.
   */
  private async isValidMediaFile(filePath: string): Promise<boolean> {
    try {
      const fd = await open(filePath, 'r');
      try {
        // Read first 12 bytes for header detection
        const buffer = Buffer.alloc(12);
        const { bytesRead } = await read(fd, buffer, 0, 12, 0);
        
        if (bytesRead < 12) {
          console.log(`File too small to validate: ${filePath} (${bytesRead} bytes read)`);
          return false;
        }

        // Check for all zeros (pre-allocated sparse file)
        const allZeros = buffer.every(byte => byte === 0);
        if (allZeros) {
          console.log(`File header is all zeros (sparse/pre-allocated): ${filePath}`);
          return false;
        }

        const ext = path.extname(filePath).toLowerCase();

        // MKV/WebM: EBML header starts with 0x1A 0x45 0xDF 0xA3
        if (ext === '.mkv' || ext === '.webm') {
          const isEBML = buffer[0] === 0x1A && buffer[1] === 0x45 && 
                         buffer[2] === 0xDF && buffer[3] === 0xA3;
          if (!isEBML) {
            console.log(`Invalid MKV/WebM header: ${filePath} (got: ${buffer.slice(0, 4).toString('hex')})`);
          }
          return isEBML;
        }

        // MP4/MOV: 'ftyp' at offset 4
        if (ext === '.mp4' || ext === '.mov') {
          const hasFtyp = buffer.slice(4, 8).toString('ascii') === 'ftyp';
          if (!hasFtyp) {
            console.log(`Invalid MP4/MOV header: ${filePath} (got: ${buffer.slice(4, 8).toString('hex')})`);
          }
          return hasFtyp;
        }

        // AVI: 'RIFF' followed by 'AVI ' at offset 8
        if (ext === '.avi') {
          const isRIFF = buffer.slice(0, 4).toString('ascii') === 'RIFF';
          const isAVI = buffer.slice(8, 12).toString('ascii') === 'AVI ';
          if (!isRIFF || !isAVI) {
            console.log(`Invalid AVI header: ${filePath}`);
          }
          return isRIFF && isAVI;
        }

        // WMV/FLV: Just check for non-zero content
        // These formats have variable headers, so we just ensure it's not empty
        console.log(`Assuming valid (non-zero header) for ${ext}: ${filePath}`);
        return true;
      } finally {
        await close(fd);
      }
    } catch (error) {
      console.error(`Error validating media file ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Select the best media file from a list (typically the largest).
   */
  private async selectBestMediaFile(files: string[]): Promise<string> {
    if (files.length === 1) {
      return files[0];
    }

    let bestFile = files[0];
    let bestSize = 0;

    for (const file of files) {
      try {
        const fileStat = await stat(file);
        if (fileStat.size > bestSize) {
          bestSize = fileStat.size;
          bestFile = file;
        }
      } catch (e) {
        // Ignore files we can't stat
      }
    }

    return bestFile;
  }

  /**
   * Get download history (completed downloads).
   */
  async getDownloadHistory(limit = 50): Promise<Download[]> {
    return Download.findAll({
      where: { status: { [Op.in]: ['completed', 'failed'] } },
      include: [{ model: MediaItem, as: 'mediaItem' }],
      order: [['updatedAt', 'DESC']],
      limit,
    });
  }

  /**
   * Trigger a manual sync (useful after changes).
   */
  async triggerSync(): Promise<void> {
    await this.syncDownloads();
  }

  /**
   * Configure which files to download from a torrent based on detected episodes.
   * This prevents downloading files we don't need.
   * 
   * @param torrentHash - The torrent hash
   * @param wantedEpisodes - Array of {season, episode} objects we want to download
   * @returns Number of files set to download
   */
  async configureFilePriorities(
    torrentHash: string,
    wantedEpisodes: Array<{ season: number; episode: number }>
  ): Promise<number> {
    try {
      console.log(`[configureFilePriorities] Called with ${wantedEpisodes.length} wanted episodes: ${wantedEpisodes.map(e => `S${e.season}E${e.episode}`).join(', ')}`);
      
      // Wait a bit for QBittorrent to fetch the torrent metadata
      await new Promise(resolve => setTimeout(resolve, 3000));

      const files = await qbittorrentService.getTorrentFiles(torrentHash);
      if (files.length === 0) {
        console.log(`[configureFilePriorities] No files found in torrent ${torrentHash} - metadata may not be loaded yet`);
        return 0;
      }

      console.log(`[configureFilePriorities] Processing ${files.length} files in torrent`);
      
      const wantedFileIds: number[] = [];
      const unwantedFileIds: number[] = [];

      for (const file of files) {
        // Check if this file is a media file
        if (!this.isMediaFile(file.name)) {
          unwantedFileIds.push(file.index);
          continue;
        }

        // Try to extract episode info from filename
        const episodeInfo = this.extractEpisodeFromFilename(file.name);
        
        if (!episodeInfo) {
          // Can't determine episode - include it to be safe
          console.log(`  [configureFilePriorities] Including (no episode detected): ${file.name}`);
          wantedFileIds.push(file.index);
          continue;
        }

        // Check if this episode is wanted
        const isWanted = wantedEpisodes.some(
          ep => ep.season === episodeInfo.season && ep.episode === episodeInfo.episode
        );

        if (isWanted) {
          wantedFileIds.push(file.index);
          console.log(`  [configureFilePriorities] Including: ${file.name} (S${episodeInfo.season}E${episodeInfo.episode})`);
        } else {
          unwantedFileIds.push(file.index);
          console.log(`  [configureFilePriorities] Excluding: ${file.name} (S${episodeInfo.season}E${episodeInfo.episode})`);
        }
      }

      // Set unwanted files to priority 0 (don't download)
      if (unwantedFileIds.length > 0) {
        await qbittorrentService.setFilePriority(torrentHash, unwantedFileIds, 0);
        console.log(`[configureFilePriorities] Set ${unwantedFileIds.length} files to skip`);
      }

      // Set wanted files with sequential priority: first episode gets max (7),
      // second gets high (6), rest get normal (1). This ensures episodes
      // download roughly in order.
      if (wantedFileIds.length > 0) {
        // Sort wanted episodes by season then episode
        const sortedWanted = [...wantedEpisodes].sort((a, b) => 
          a.season !== b.season ? a.season - b.season : a.episode - b.episode
        );
        
        // Build a map from episode key to priority (7=max, 6=high, 1=normal)
        const episodePriority = new Map<string, number>();
        sortedWanted.forEach((ep, idx) => {
          const key = `${ep.season}:${ep.episode}`;
          if (idx === 0) episodePriority.set(key, 7);      // maximum
          else if (idx === 1) episodePriority.set(key, 6);  // high
          else episodePriority.set(key, 1);                 // normal
        });
        
        // Group file IDs by priority
        const byPriority = new Map<number, number[]>();
        for (const file of files) {
          if (!wantedFileIds.includes(file.index)) continue;
          const epInfo = this.extractEpisodeFromFilename(file.name);
          const key = epInfo ? `${epInfo.season}:${epInfo.episode}` : null;
          const prio = key ? (episodePriority.get(key) || 1) : 1;
          if (!byPriority.has(prio)) byPriority.set(prio, []);
          byPriority.get(prio)!.push(file.index);
        }
        
        for (const [prio, ids] of byPriority) {
          await qbittorrentService.setFilePriority(torrentHash, ids, prio);
          console.log(`[configureFilePriorities] Set ${ids.length} files to priority ${prio}`);
        }
      }

      return wantedFileIds.length;
    } catch (error) {
      console.error('[configureFilePriorities] Error configuring file priorities:', error);
      return 0;
    }
  }

  /**
   * Configure additional files to download from an existing torrent.
   * Unlike configureFilePriorities, this doesn't disable any files - it only enables additional ones.
   * This is used when reusing an existing torrent for a new episode.
   * 
   * @param torrentHash - The torrent hash
   * @param additionalEpisodes - Array of {season, episode} objects to add to download
   * @returns Number of additional files enabled for download
   */
  async configureFilePrioritiesAdditive(
    torrentHash: string,
    additionalEpisodes: Array<{ season: number; episode: number }>
  ): Promise<number> {
    try {
      console.log(`[configureFilePrioritiesAdditive] Adding ${additionalEpisodes.length} episodes: ${additionalEpisodes.map(e => `S${e.season}E${e.episode}`).join(', ')}`);

      const files = await qbittorrentService.getTorrentFiles(torrentHash);
      if (files.length === 0) {
        console.log(`[configureFilePrioritiesAdditive] No files found in torrent ${torrentHash}`);
        return 0;
      }

      const filesToEnable: number[] = [];

      for (const file of files) {
        // Skip if already being downloaded
        if (file.priority > 0) {
          continue;
        }

        // Check if this file is a media file
        if (!this.isMediaFile(file.name)) {
          continue;
        }

        // Try to extract episode info from filename
        const episodeInfo = this.extractEpisodeFromFilename(file.name);
        
        if (!episodeInfo) {
          continue;
        }

        // Check if this episode is one we want to add
        const isWanted = additionalEpisodes.some(
          ep => ep.season === episodeInfo.season && ep.episode === episodeInfo.episode
        );

        if (isWanted) {
          filesToEnable.push(file.index);
          console.log(`  [configureFilePrioritiesAdditive] Enabling: ${file.name} (S${episodeInfo.season}E${episodeInfo.episode})`);
        }
      }

      // Enable the additional files
      if (filesToEnable.length > 0) {
        await qbittorrentService.setFilePriority(torrentHash, filesToEnable, 1);
        console.log(`[configureFilePrioritiesAdditive] Enabled ${filesToEnable.length} additional files`);
      }

      return filesToEnable.length;
    } catch (error) {
      console.error('[configureFilePrioritiesAdditive] Error:', error);
      return 0;
    }
  }

  /**
   * Apply sequential download strategy for TV series torrents.
   * 
   * Strategy:
   * - Episodes in the "current" season get high priority (6)
   * - Specifically requested episodes get maximum priority (7)
   * - Episodes are downloaded in sequential order within each season
   * - Future seasons get normal priority (1)
   * - Completed/processed files get priority 0
   * 
   * This ensures users can watch episodes in order while still allowing cherry-picking.
   * 
   * @param torrentHash - The torrent hash
   * @param currentSeason - The season the user is currently watching
   * @param priorityEpisode - Optional specific episode to give maximum priority
   * @returns Number of files configured
   */
  async applySequentialDownloadStrategy(
    torrentHash: string,
    currentSeason: number,
    priorityEpisode?: { season: number; episode: number }
  ): Promise<number> {
    try {
      console.log(`[SequentialStrategy] Applying for season ${currentSeason}${priorityEpisode ? `, priority: S${priorityEpisode.season}E${priorityEpisode.episode}` : ''}`);

      const files = await qbittorrentService.getTorrentFiles(torrentHash);
      if (files.length === 0) {
        console.log(`[SequentialStrategy] No files found in torrent ${torrentHash}`);
        return 0;
      }

      // Group files by season and episode
      const episodeFiles: Array<{
        file: QBittorrentFile;
        season: number;
        episode: number;
      }> = [];

      for (const file of files) {
        if (!this.isMediaFile(file.name)) {
          continue;
        }

        const episodeInfo = this.extractEpisodeFromFilename(file.name);
        if (episodeInfo) {
          episodeFiles.push({
            file,
            season: episodeInfo.season,
            episode: episodeInfo.episode,
          });
        }
      }

      if (episodeFiles.length === 0) {
        console.log(`[SequentialStrategy] No episode files found in torrent`);
        return 0;
      }

      // Sort by season and episode for sequential processing
      episodeFiles.sort((a, b) => {
        if (a.season !== b.season) return a.season - b.season;
        return a.episode - b.episode;
      });

      // Categorize files by priority level
      const maxPriorityFiles: number[] = [];  // 7 - user requested
      const highPriorityFiles: number[] = [];  // 6 - current season
      const normalPriorityFiles: number[] = []; // 1 - future seasons
      const skipFiles: number[] = [];          // 0 - already processed

      for (const { file, season, episode } of episodeFiles) {
        // Skip already completed files
        if (file.progress >= 1 && file.priority === 0) {
          skipFiles.push(file.index);
          continue;
        }

        // Check if this is the priority episode (user requested)
        if (priorityEpisode && 
            season === priorityEpisode.season && 
            episode === priorityEpisode.episode) {
          maxPriorityFiles.push(file.index);
          console.log(`  [SequentialStrategy] Maximum priority (7): S${season}E${episode}`);
        }
        // Current season gets high priority
        else if (season === currentSeason) {
          highPriorityFiles.push(file.index);
          console.log(`  [SequentialStrategy] High priority (6): S${season}E${episode}`);
        }
        // Future/other seasons get normal priority
        else if (season > currentSeason) {
          normalPriorityFiles.push(file.index);
          console.log(`  [SequentialStrategy] Normal priority (1): S${season}E${episode}`);
        }
        // Past seasons that aren't done yet - also high priority
        else {
          highPriorityFiles.push(file.index);
          console.log(`  [SequentialStrategy] High priority (6) - past season: S${season}E${episode}`);
        }
      }

      // Apply priorities
      if (maxPriorityFiles.length > 0) {
        await qbittorrentService.setFilePriority(torrentHash, maxPriorityFiles, 7);
        console.log(`[SequentialStrategy] Set ${maxPriorityFiles.length} files to maximum priority (7)`);
      }

      if (highPriorityFiles.length > 0) {
        await qbittorrentService.setFilePriority(torrentHash, highPriorityFiles, 6);
        console.log(`[SequentialStrategy] Set ${highPriorityFiles.length} files to high priority (6)`);
      }

      if (normalPriorityFiles.length > 0) {
        await qbittorrentService.setFilePriority(torrentHash, normalPriorityFiles, 1);
        console.log(`[SequentialStrategy] Set ${normalPriorityFiles.length} files to normal priority (1)`);
      }

      // Enable sequential download in QBittorrent
      await qbittorrentService.setSequentialDownload(torrentHash, true);
      console.log(`[SequentialStrategy] Enabled sequential download mode`);

      return episodeFiles.length;
    } catch (error) {
      console.error('[SequentialStrategy] Error:', error);
      return 0;
    }
  }

  /**
   * Reset a corrupt or incomplete download.
   * This removes the corrupt file from storage and resets the download state
   * so the file can be re-downloaded.
   */
  async resetCorruptDownload(downloadId: string): Promise<{ success: boolean; message: string }> {
    try {
      const download = await Download.findByPk(downloadId, {
        include: [{ model: MediaItem, as: 'mediaItem' }],
      });

      if (!download) {
        return { success: false, message: 'Download not found' };
      }

      const mediaItem = (download as any).mediaItem as MediaItem | undefined;
      if (!mediaItem) {
        return { success: false, message: 'Media item not found' };
      }

      // Check if the file exists and is corrupt
      if (mediaItem.filePath && mediaItem.diskPath) {
        const fullPath = path.join(mediaItem.diskPath, mediaItem.filePath);
        
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.isFile()) {
            // Validate the file
            const isValid = await this.isValidMediaFile(fullPath);
            
            if (!isValid) {
              // File is corrupt - delete it
              console.log(`Removing corrupt file: ${fullPath}`);
              await unlink(fullPath);
              
              // Try to remove empty parent directories
              try {
                const parentDir = path.dirname(fullPath);
                const entries = await readdir(parentDir);
                if (entries.length === 0) {
                  await rmdir(parentDir);
                  console.log(`Removed empty directory: ${parentDir}`);
                }
              } catch (e) {
                // Ignore directory cleanup errors
              }
            } else {
              return { success: false, message: 'File appears to be valid, not resetting' };
            }
          }
        } catch (e) {
          // File doesn't exist, that's fine
          console.log(`File not found at ${fullPath}, continuing with reset`);
        }
      }

      // Reset media item paths
      await mediaItem.update({
        filePath: undefined,
        diskPath: undefined,
      });

      // Update the .strm file back to progress video URL
      await mediaService.updateStrmFileToProgressUrl(mediaItem);

      // Reset download status so it can be re-triggered
      await download.update({
        status: 'pending',
        progress: 0,
        completedAt: undefined,
        error: undefined,
        downloadSpeed: 0,
        downloadedSize: 0,
        torrentHash: undefined,
      });

      console.log(`Reset corrupt download for: ${mediaItem.title}`);
      return { success: true, message: `Reset download for ${mediaItem.title}. You can now re-download it.` };
    } catch (error) {
      console.error('Error resetting corrupt download:', error);
      return { success: false, message: `Error: ${error}` };
    }
  }

  /**
   * Check a file in storage and return whether it's valid.
   * Public method for API use.
   */
  async validateStorageFile(mediaItemId: string): Promise<{ valid: boolean; reason: string }> {
    try {
      const mediaItem = await MediaItem.findByPk(mediaItemId);
      if (!mediaItem) {
        return { valid: false, reason: 'Media item not found' };
      }

      if (!mediaItem.filePath || !mediaItem.diskPath) {
        return { valid: false, reason: 'No file path set' };
      }

      const fullPath = path.join(mediaItem.diskPath, mediaItem.filePath);
      
      try {
        await stat(fullPath);
      } catch (e) {
        return { valid: false, reason: 'File does not exist' };
      }

      const isValid = await this.isValidMediaFile(fullPath);
      if (isValid) {
        return { valid: true, reason: 'File has valid media header' };
      } else {
        return { valid: false, reason: 'File header is invalid or file is empty/sparse' };
      }
    } catch (error) {
      return { valid: false, reason: `Error: ${error}` };
    }
  }

  /**
   * Clean up orphaned downloads - downloads that reference torrents no longer in QBittorrent.
   * This handles cases where:
   * 1. Torrents were manually removed from QBittorrent
   * 2. QBittorrent data was lost/reset
   * 3. Downloads got stuck in a downloading state but torrent is gone
   * 
   * For each orphaned download:
   * - If the associated media item has a file (completed), just remove the download record
   * - If no file exists, mark as failed so user can retry or delete
   */
  async cleanupOrphanedDownloads(): Promise<{
    removed: number;
    markedFailed: number;
    details: string[];
  }> {
    const details: string[] = [];
    let removed = 0;
    let markedFailed = 0;

    try {
      // Check if QBittorrent is available
      const available = await qbittorrentService.isAvailable();
      if (!available) {
        return { removed: 0, markedFailed: 0, details: ['QBittorrent not available'] };
      }

      // Get all torrents from QBittorrent
      const torrents = await qbittorrentService.getTorrents();
      const torrentHashes = new Set(torrents.map(t => t.hash.toLowerCase()));
      console.log(`[DownloadManager] Found ${torrentHashes.size} active torrents in QBittorrent`);

      // Get all active downloads (not completed or failed)
      const activeDownloads = await Download.findAll({
        where: {
          status: ['pending', 'downloading', 'paused'],
        },
        include: [{ model: MediaItem, as: 'mediaItem' }],
      });

      console.log(`[DownloadManager] Found ${activeDownloads.length} active downloads to check`);

      // Check each download
      for (const download of activeDownloads) {
        const hash = download.torrentHash?.toLowerCase();
        
        // Skip downloads without a hash (shouldn't happen but be safe)
        if (!hash) {
          continue;
        }

        // Check if torrent exists in QBittorrent
        if (!torrentHashes.has(hash)) {
          const mediaItem = (download as any).mediaItem as MediaItem | undefined;
          const title = mediaItem?.title || 'Unknown';
          
          // Check if the media item already has a file (download was completed but record not updated)
          if (mediaItem?.filePath && mediaItem?.diskPath) {
            const fullPath = path.join(mediaItem.diskPath, mediaItem.filePath);
            try {
              await stat(fullPath);
              // File exists - this download is actually complete, remove the duplicate download record
              console.log(`[DownloadManager] Orphaned download for "${title}" - file exists, removing download record`);
              await download.destroy();
              removed++;
              details.push(`Removed completed: ${title}`);
              continue;
            } catch (e) {
              // File doesn't exist
            }
          }

          // No file exists - mark as failed
          console.log(`[DownloadManager] Orphaned download for "${title}" - no file, marking as failed`);
          await download.update({
            status: 'failed',
            error: 'Torrent no longer exists in QBittorrent. You may need to re-download.',
          });
          markedFailed++;
          details.push(`Marked failed: ${title}`);
        }
      }

      // Also clean up duplicate download records for the same media item
      const allDownloads = await Download.findAll({
        include: [{ model: MediaItem, as: 'mediaItem' }],
        order: [['createdAt', 'DESC']],
      });

      // Group by media item
      const downloadsByMediaItem = new Map<string, Download[]>();
      for (const download of allDownloads) {
        if (download.mediaItemId) {
          const existing = downloadsByMediaItem.get(download.mediaItemId) || [];
          existing.push(download);
          downloadsByMediaItem.set(download.mediaItemId, existing);
        }
      }

      // Remove duplicates, keeping the most recent/relevant
      for (const [mediaItemId, downloads] of downloadsByMediaItem) {
        if (downloads.length > 1) {
          // Sort: completed first, then downloading, then by date
          downloads.sort((a, b) => {
            const statusOrder: Record<string, number> = {
              completed: 0,
              downloading: 1,
              pending: 2,
              paused: 3,
              failed: 4,
            };
            const statusDiff = (statusOrder[a.status] || 5) - (statusOrder[b.status] || 5);
            if (statusDiff !== 0) return statusDiff;
            return new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime();
          });

          // Keep first, remove rest
          const toKeep = downloads[0];
          const mediaItem = (toKeep as any).mediaItem as MediaItem | undefined;
          const title = mediaItem?.title || 'Unknown';
          
          for (let i = 1; i < downloads.length; i++) {
            await downloads[i].destroy();
            removed++;
          }
          
          if (downloads.length > 1) {
            details.push(`Removed ${downloads.length - 1} duplicates for: ${title}`);
          }
        }
      }

      console.log(`[DownloadManager] Cleanup complete: ${removed} removed, ${markedFailed} marked failed`);
      return { removed, markedFailed, details };
    } catch (error) {
      console.error('[DownloadManager] Error cleaning up orphaned downloads:', error);
      return { removed, markedFailed, details: [`Error: ${error}`] };
    }
  }
}

export const downloadManager = new DownloadManager();
