import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import YAML from 'yaml';
import { config } from '../config';
import { MediaItem, MediaType } from '../models';

const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const rmdir = promisify(fs.rmdir);
const access = promisify(fs.access);
const copyFile = promisify(fs.copyFile);

// Subtitle file extensions to look for and copy
const SUBTITLE_EXTENSIONS = ['.srt', '.sub', '.ass', '.ssa', '.vtt', '.idx'];

export interface DiskStats {
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface MediaMetadata {
  title: string;
  year?: number;
  imdbId?: string;
  magnetUri?: string;
  torrentHash?: string;
  torrentName?: string;
  season?: number;
  episode?: number;
  addedAt: string;
  downloadedAt?: string;
}

// Helper function to create a URL-safe slug from a title
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '+')
    .replace(/^\+|\+$/g, '');
}

// Generate a consistent progress video path for a media item
// This URL shows a download progress video until the file is available
export function generateProgressPath(type: string, title: string, year?: number, season?: number, episode?: number): string {
  const slug = slugify(title);
  
  switch (type) {
    case 'movie':
      return `/progress/movies/${slug}/${year || 0}`;
    case 'tv':
      const s = String(season || 1).padStart(2, '0');
      const e = String(episode || 1).padStart(2, '0');
      return `/progress/tv/${slug}/s${s}e${e}`;
    case 'web':
      return `/progress/web/${slug}`;
    default:
      return `/progress/${type}/${slug}`;
  }
}

// Legacy: Generate stream path (deprecated, use generateProgressPath instead)
export function generateStreamPath(type: string, title: string, year?: number, season?: number, episode?: number): string {
  // Now redirects to progress path
  return generateProgressPath(type, title, year, season, episode).replace('/progress/', '/stream/');
}

export class MediaService {
  // Ensure default storage directories exist (movies, tv, web)
  async ensureDefaultStorageExists(): Promise<void> {
    const defaultStoragePath = path.join(config.paths.disks, config.paths.defaultDisk);
    const typeDirs = ['movies', 'tv', 'web'];
    
    for (const dir of typeDirs) {
      const dirPath = path.join(defaultStoragePath, dir);
      try {
        await mkdir(dirPath, { recursive: true });
      } catch (e) {
        // Ignore if already exists
      }
    }
  }

  // Get all available disks and their stats (including default storage as fallback)
  async getDiskStats(): Promise<DiskStats[]> {
    const stats: DiskStats[] = [];
    
    // First, try to get configured external disks
    try {
      const disks = await readdir(config.paths.disks);
      
      for (const disk of disks) {
        const diskPath = path.join(config.paths.disks, disk);
        const diskStat = await stat(diskPath);
        
        if (diskStat.isDirectory()) {
          try {
            const fsStats = await this.getDiskSpace(diskPath);
            stats.push({
              name: disk,
              path: diskPath,
              ...fsStats,
            });
          } catch (e) {
            console.error(`Error getting stats for disk ${disk}:`, e);
          }
        }
      }
    } catch (e) {
      // Disks directory doesn't exist or is inaccessible - that's OK
      console.log('No external disks directory found, using default storage');
    }
    
    // If no external disks are available, use the default storage as fallback
    if (stats.length === 0) {
      try {
        // Ensure the default storage directory exists
        await this.ensureDefaultStorageExists();
        
        const defaultStoragePath = path.join(config.paths.disks, config.paths.defaultDisk);
        const fsStats = await this.getDiskSpace(defaultStoragePath);
        stats.push({
          name: config.paths.defaultDisk,
          path: defaultStoragePath,
          ...fsStats,
        });
        console.log('Using default storage disk as fallback');
      } catch (e) {
        console.error('Error getting stats for default storage:', e);
      }
    }
    
    return stats;
  }

  private async getDiskSpace(diskPath: string): Promise<{
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  }> {
    // Use statfs to get disk space info
    const { exec } = require('child_process');
    
    return new Promise((resolve, reject) => {
      exec(`df -B1 "${diskPath}" | tail -1`, (error: any, stdout: string) => {
        if (error) {
          reject(error);
          return;
        }
        
        const parts = stdout.trim().split(/\s+/);
        const totalBytes = parseInt(parts[1], 10);
        const usedBytes = parseInt(parts[2], 10);
        const freeBytes = parseInt(parts[3], 10);
        const usedPercent = (usedBytes / totalBytes) * 100;
        
        resolve({ totalBytes, freeBytes, usedBytes, usedPercent });
      });
    });
  }

  // Find the best disk for a new media item
  async findBestDisk(type: MediaType, title: string): Promise<string> {
    const disks = await this.getDiskStats();
    
    // First, check if this title already exists on a disk
    for (const disk of disks) {
      const typePath = path.join(disk.path, type);
      try {
        const items = await readdir(typePath);
        const existingItem = items.find(item => 
          item.toLowerCase().startsWith(title.toLowerCase().split(' ')[0])
        );
        if (existingItem) {
          return disk.path;
        }
      } catch (e) {
        // Directory doesn't exist yet
      }
    }
    
    // Otherwise, find disk with most free space
    disks.sort((a, b) => b.freeBytes - a.freeBytes);
    
    // Fallback to default storage if no disks available
    return disks[0]?.path || path.join(config.paths.disks, config.paths.defaultDisk);
  }

  // Generate .strm file content with progress video URL
  // When media is first added, .strm points to a progress video endpoint
  // After download completes, .strm is updated to the direct file path
  generateStrmContent(media: { type: string; title: string; year?: number; season?: number; episode?: number }): string {
    // This URL points to our backend progress video endpoint
    // The progress video shows download status until the file is ready
    const progressPath = generateProgressPath(media.type, media.title, media.year, media.season, media.episode);
    return `http://backend:3001${progressPath}`;
  }

  // Create .strm and .yml files for a media item
  async createMediaFiles(media: MediaItem): Promise<void> {
    let contentPath: string;
    let fileName: string;
    
    switch (media.type) {
      case 'movie':
        contentPath = path.join(config.paths.content, 'movies', `${media.title} (${media.year})`);
        fileName = `${media.title} (${media.year})`;
        break;
      case 'tv':
        contentPath = path.join(
          config.paths.content, 
          'tv', 
          media.title,
          `Season ${media.season || 1}`
        );
        fileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
        break;
      case 'web':
        contentPath = path.join(config.paths.content, 'web', media.channel || 'Unknown');
        fileName = media.title;
        break;
      default:
        throw new Error(`Unknown media type: ${media.type}`);
    }
    
    // Create directory if it doesn't exist
    await mkdir(contentPath, { recursive: true });
    
    // Create .strm file with consistent URL
    const strmPath = path.join(contentPath, `${fileName}.strm`);
    const strmContent = this.generateStrmContent(media);
    await writeFile(strmPath, strmContent);
    
    // Create .yml metadata file
    const ymlPath = path.join(contentPath, `${fileName}.yml`);
    const metadata: MediaMetadata = {
      title: media.title,
      year: media.year,
      imdbId: media.imdbId,
      magnetUri: media.magnetUri,
      season: media.season,
      episode: media.episode,
      addedAt: new Date().toISOString(),
    };
    await writeFile(ymlPath, YAML.stringify(metadata));
  }

  // Update .yml metadata file with torrent/download information
  async updateMediaMetadata(media: MediaItem, updates: Partial<MediaMetadata>): Promise<void> {
    let contentPath: string;
    let fileName: string;
    
    switch (media.type) {
      case 'movie':
        contentPath = path.join(config.paths.content, 'movies', `${media.title} (${media.year})`);
        fileName = `${media.title} (${media.year})`;
        break;
      case 'tv':
        contentPath = path.join(
          config.paths.content, 
          'tv', 
          media.title,
          `Season ${media.season || 1}`
        );
        fileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
        break;
      case 'web':
        contentPath = path.join(config.paths.content, 'web', media.channel || 'Unknown');
        fileName = media.title;
        break;
      default:
        return;
    }
    
    const ymlPath = path.join(contentPath, `${fileName}.yml`);
    
    try {
      // Read existing metadata
      let metadata: MediaMetadata;
      try {
        const existing = await readFile(ymlPath, 'utf-8');
        metadata = YAML.parse(existing) || {};
      } catch {
        // File doesn't exist yet, create base metadata
        metadata = {
          title: media.title,
          year: media.year,
          imdbId: media.imdbId,
          season: media.season,
          episode: media.episode,
          addedAt: new Date().toISOString(),
        };
      }
      
      // Merge updates
      Object.assign(metadata, updates);
      
      await mkdir(contentPath, { recursive: true });
      await writeFile(ymlPath, YAML.stringify(metadata));
      console.log(`Updated metadata for ${media.title}: ${Object.keys(updates).join(', ')}`);
    } catch (err: any) {
      console.error(`Failed to update metadata for ${media.title}:`, err.message);
    }
  }

  // Delete .strm and .yml files for a media item
  // Get the expected .strm file path for a media item
  getStrmPath(media: MediaItem): string | null {
    let contentPath: string;
    let fileName: string;
    
    switch (media.type) {
      case 'movie':
        contentPath = path.join(config.paths.content, 'movies', `${media.title} (${media.year})`);
        fileName = `${media.title} (${media.year})`;
        break;
      case 'tv':
        contentPath = path.join(config.paths.content, 'tv', media.title, `Season ${media.season || 1}`);
        fileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
        break;
      case 'web':
        contentPath = path.join(config.paths.content, 'web', media.channel || 'Unknown');
        fileName = media.title;
        break;
      default:
        return null;
    }
    
    return path.join(contentPath, `${fileName}.strm`);
  }

  // For movies, also removes the movie directory
  // For TV shows, removes the episode files and cleans up empty directories
  async deleteMediaFiles(media: MediaItem): Promise<void> {
    let contentPath: string;
    let fileName: string;
    
    switch (media.type) {
      case 'movie':
        contentPath = path.join(config.paths.content, 'movies', `${media.title} (${media.year})`);
        fileName = `${media.title} (${media.year})`;
        break;
      case 'tv':
        contentPath = path.join(
          config.paths.content, 
          'tv', 
          media.title,
          `Season ${media.season || 1}`
        );
        fileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
        break;
      case 'web':
        contentPath = path.join(config.paths.content, 'web', media.channel || 'Unknown');
        fileName = media.title;
        break;
      default:
        throw new Error(`Unknown media type: ${media.type}`);
    }
    
    // Delete .strm file
    const strmPath = path.join(contentPath, `${fileName}.strm`);
    try {
      await unlink(strmPath);
      console.log(`Deleted: ${strmPath}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.error(`Failed to delete ${strmPath}:`, e.message);
      }
    }
    
    // Delete .yml file
    const ymlPath = path.join(contentPath, `${fileName}.yml`);
    try {
      await unlink(ymlPath);
      console.log(`Deleted: ${ymlPath}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        console.error(`Failed to delete ${ymlPath}:`, e.message);
      }
    }
    
    // For movies, try to remove the entire directory if empty
    if (media.type === 'movie') {
      await this.removeEmptyDirectory(contentPath);
    }
    
    // For TV shows, try to clean up empty season and show directories
    if (media.type === 'tv') {
      // Try to remove the season directory if empty
      await this.removeEmptyDirectory(contentPath);
      
      // Try to remove the show directory if empty
      const showPath = path.join(config.paths.content, 'tv', media.title);
      await this.removeEmptyDirectory(showPath);
    }
    
    // For web content, try to remove the channel directory if empty
    if (media.type === 'web') {
      await this.removeEmptyDirectory(contentPath);
    }
  }

  // Helper to remove a directory only if it's empty
  private async removeEmptyDirectory(dirPath: string): Promise<void> {
    try {
      const files = await readdir(dirPath);
      if (files.length === 0) {
        await rmdir(dirPath);
        console.log(`Removed empty directory: ${dirPath}`);
      }
    } catch (e: any) {
      // Directory doesn't exist or other error - ignore
    }
  }

  // Get the actual file path on disk for a media item
  async getMediaFilePath(media: MediaItem): Promise<string | null> {
    if (media.filePath && media.diskPath) {
      const fullPath = path.join(media.diskPath, media.filePath);
      try {
        await stat(fullPath);
        return fullPath;
      } catch (e) {
        // File doesn't exist
      }
    }
    
    // Search for the file on all disks
    const disks = await this.getDiskStats();
    
    for (const disk of disks) {
      let searchPath: string;
      let pattern: string;
      
      switch (media.type) {
        case 'movie':
          searchPath = path.join(disk.path, 'movies', `${media.title} (${media.year})`);
          pattern = '.(mp4|mkv)';
          break;
        case 'tv':
          searchPath = path.join(disk.path, 'tv', media.title, `Season ${media.season || 1}`);
          pattern = `S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
          break;
        case 'web':
          searchPath = path.join(disk.path, 'web', media.channel || 'Unknown');
          pattern = media.title;
          break;
        default:
          continue;
      }
      
      try {
        const files = await readdir(searchPath);
        const mediaFile = files.find(f => 
          (f.endsWith('.mp4') || f.endsWith('.mkv')) &&
          f.toLowerCase().includes(pattern.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
        
        if (mediaFile) {
          const fullPath = path.join(searchPath, mediaFile);
          
          // Update the media item with the found path
          await media.update({
            diskPath: disk.path,
            filePath: path.relative(disk.path, fullPath),
          });
          
          return fullPath;
        }
      } catch (e) {
        // Directory doesn't exist
      }
    }
    
    return null;
  }

  /**
   * Find subtitle files associated with a video file.
   * Looks for files in the same directory with matching base name or common subtitle names.
   * Also searches subdirectories named 'Subs', 'Subtitles', etc.
   * 
   * @param videoPath - Full path to the video file
   * @returns Array of subtitle file paths found
   */
  async findSubtitleFiles(videoPath: string): Promise<string[]> {
    const subtitles: string[] = [];
    const videoDir = path.dirname(videoPath);
    const videoBaseName = path.basename(videoPath, path.extname(videoPath));
    
    try {
      const entries = await readdir(videoDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(videoDir, entry.name);
        
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUBTITLE_EXTENSIONS.includes(ext)) {
            // Check if subtitle matches video name (with optional language code)
            // e.g., "Movie.srt", "Movie.en.srt", "Movie.English.srt"
            const subBaseName = path.basename(entry.name, ext);
            if (subBaseName === videoBaseName || 
                subBaseName.startsWith(videoBaseName + '.') ||
                subBaseName.toLowerCase().startsWith(videoBaseName.toLowerCase() + '.')) {
              subtitles.push(fullPath);
              console.log(`Found subtitle: ${entry.name}`);
            }
          }
        } else if (entry.isDirectory()) {
          // Check common subtitle folder names
          const dirNameLower = entry.name.toLowerCase();
          if (['subs', 'subtitles', 'subtitle', 'sub'].includes(dirNameLower)) {
            // Search this subdirectory for subtitle files
            try {
              const subEntries = await readdir(fullPath, { withFileTypes: true });
              for (const subEntry of subEntries) {
                if (subEntry.isFile()) {
                  const ext = path.extname(subEntry.name).toLowerCase();
                  if (SUBTITLE_EXTENSIONS.includes(ext)) {
                    subtitles.push(path.join(fullPath, subEntry.name));
                    console.log(`Found subtitle in ${entry.name}/: ${subEntry.name}`);
                  }
                }
              }
            } catch (e) {
              // Ignore errors reading subtitle folders
            }
          }
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read
      console.error(`Error finding subtitles for ${videoPath}:`, e);
    }
    
    return subtitles;
  }

  /**
   * Copy subtitle files to the destination directory.
   * Renames them to match the video file name.
   * 
   * @param subtitlePaths - Array of subtitle file paths to copy
   * @param destDir - Destination directory
   * @param destVideoBaseName - Base name of the destination video file (without extension)
   * @returns Number of subtitle files copied
   */
  async copySubtitles(
    subtitlePaths: string[],
    destDir: string,
    destVideoBaseName: string
  ): Promise<number> {
    let copiedCount = 0;
    
    for (const subtitlePath of subtitlePaths) {
      try {
        const ext = path.extname(subtitlePath);
        const subtitleBaseName = path.basename(subtitlePath, ext);
        const sourceVideoBaseName = path.basename(path.dirname(subtitlePath));
        
        // Determine the language code if present
        // e.g., "Movie.en.srt" -> ".en", "Movie.English.srt" -> ".English"
        let languageSuffix = '';
        
        // Check if there's a language code between the video name and extension
        // Handle cases like "Movie.en.srt" or just "Movie.srt"
        const possibleLangMatch = subtitleBaseName.match(/\.([a-zA-Z]{2,})$/);
        if (possibleLangMatch) {
          languageSuffix = '.' + possibleLangMatch[1];
        }
        
        // Build destination subtitle path
        const destSubtitleName = `${destVideoBaseName}${languageSuffix}${ext}`;
        const destSubtitlePath = path.join(destDir, destSubtitleName);
        
        await copyFile(subtitlePath, destSubtitlePath);
        console.log(`Copied subtitle: ${destSubtitleName}`);
        copiedCount++;
      } catch (e) {
        console.error(`Failed to copy subtitle ${subtitlePath}:`, e);
      }
    }
    
    return copiedCount;
  }

  // Move downloaded file to appropriate location
  async moveToLibrary(
    sourcePath: string,
    media: MediaItem
  ): Promise<string> {
    const disk = await this.findBestDisk(media.type, media.title);
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
    
    await mkdir(destDir, { recursive: true });
    
    const destPath = path.join(destDir, destFileName);
    
    // Find and copy subtitle files before moving the video
    const subtitleFiles = await this.findSubtitleFiles(sourcePath);
    if (subtitleFiles.length > 0) {
      const destBaseName = path.basename(destFileName, sourceExt);
      const copiedCount = await this.copySubtitles(subtitleFiles, destDir, destBaseName);
      console.log(`Copied ${copiedCount} subtitle file(s) for ${media.title}`);
    }
    
    // Move the video file
    const { exec } = require('child_process');
    await new Promise<void>((resolve, reject) => {
      exec(`mv "${sourcePath}" "${destPath}"`, (error: any) => {
        if (error) reject(error);
        else resolve();
      });
    });
    
    // Update media item
    await media.update({
      diskPath: disk,
      filePath: path.relative(disk, destPath),
    });
    
    return destPath;
  }

  /**
   * Get the path to the .strm file for a media item.
   */
  getStrmFilePath(media: MediaItem): string {
    let contentPath: string;
    let fileName: string;
    
    switch (media.type) {
      case 'movie':
        contentPath = path.join(config.paths.content, 'movies', `${media.title} (${media.year})`);
        fileName = `${media.title} (${media.year})`;
        break;
      case 'tv':
        contentPath = path.join(
          config.paths.content, 
          'tv', 
          media.title,
          `Season ${media.season || 1}`
        );
        fileName = `${media.title} S${String(media.season || 1).padStart(2, '0')}E${String(media.episode || 1).padStart(2, '0')}`;
        break;
      case 'web':
        contentPath = path.join(config.paths.content, 'web', media.channel || 'Unknown');
        fileName = media.title;
        break;
      default:
        throw new Error(`Unknown media type: ${media.type}`);
    }
    
    return path.join(contentPath, `${fileName}.strm`);
  }

  /**
   * Update a .strm file to point to a direct file path instead of the streaming endpoint.
   * 
   * This enables Jellyfin to use direct play instead of transcoding, which:
   * - Reduces CPU usage on the server
   * - Provides better playback quality
   * - Allows proper seeking and playback controls
   * 
   * Path mapping:
   * - Backend sees: /qar/storage/movies/Title (Year)/file.mp4
   * - Jellyfin sees: /storage/movies/Title (Year)/file.mp4 (via ./storage:/storage:ro mount)
   * 
   * @param media - The MediaItem to update
   * @param directPath - The full path to the video file on disk (as backend sees it)
   * @returns The .strm file path if updated successfully, null otherwise
   */
  async updateStrmFileToDirectPath(media: MediaItem, directPath: string): Promise<string | null> {
    try {
      const strmPath = this.getStrmFilePath(media);
      
      // Convert the disk path (as backend sees it) to a Jellyfin-accessible path
      // Backend sees: /qar/disks/<disk>/movies/... 
      // Jellyfin sees: /storage/<disk>/movies/... (via docker mount /qar/disks:/storage:ro)
      let jellyfinPath: string;
      
      // Check if the file is in the disks directory
      if (directPath.startsWith(config.paths.disks)) {
        // Map /qar/disks/<disk>/type/... to /storage/<disk>/type/...
        const relativePath = path.relative(config.paths.disks, directPath);
        jellyfinPath = `/storage/${relativePath}`;
      } else {
        // Unknown path format - try to use as-is
        jellyfinPath = directPath;
        console.warn(`Unknown path format for .strm update: ${directPath}`);
      }
      
      // Read the current .strm content
      let currentContent = '';
      try {
        currentContent = await readFile(strmPath, 'utf8');
      } catch (e) {
        // File doesn't exist - will create it
        console.log(`Creating new .strm file: ${strmPath}`);
      }
      
      // Only update if the content has changed
      if (currentContent.trim() !== jellyfinPath) {
        await writeFile(strmPath, jellyfinPath);
        console.log(`Updated .strm file: ${strmPath}`);
        console.log(`  Old content: ${currentContent.trim()}`);
        console.log(`  New content: ${jellyfinPath}`);
        return strmPath;
      } else {
        console.log(`.strm file already up to date: ${strmPath}`);
      }
      
      return strmPath;
    } catch (error) {
      console.error(`Failed to update .strm file for ${media.title}:`, error);
      return null;
    }
  }

  /**
   * Reset a .strm file back to the progress video URL.
   * Used when a download needs to be reset (e.g., corrupt file).
   * 
   * @param media - The MediaItem to update
   * @returns The .strm file path if updated successfully, null otherwise
   */
  async updateStrmFileToProgressUrl(media: MediaItem): Promise<string | null> {
    try {
      const strmPath = this.getStrmFilePath(media);
      const progressUrl = this.generateStrmContent(media);
      
      // Read the current .strm content
      let currentContent = '';
      try {
        currentContent = await readFile(strmPath, 'utf8');
      } catch (e) {
        // File doesn't exist - will create it
        console.log(`Creating new .strm file: ${strmPath}`);
      }
      
      // Update if the content has changed
      if (currentContent.trim() !== progressUrl) {
        await writeFile(strmPath, progressUrl);
        console.log(`Reset .strm file to progress URL: ${strmPath}`);
        console.log(`  Old content: ${currentContent.trim()}`);
        console.log(`  New content: ${progressUrl}`);
        return strmPath;
      } else {
        console.log(`.strm file already points to progress URL: ${strmPath}`);
      }
      
      return strmPath;
    } catch (error) {
      console.error(`Failed to reset .strm file for ${media.title}:`, error);
      return null;
    }
  }

  /**
   * Check if a .strm file points to a streaming/progress endpoint or has wrong path format.
   * Returns true if the .strm needs to be updated to the correct direct path.
   */
  async strmNeedsUpdate(media: MediaItem): Promise<boolean> {
    try {
      const strmPath = this.getStrmFilePath(media);
      const content = await readFile(strmPath, 'utf8');
      const trimmed = content.trim();
      
      // Needs update if it contains:
      // - Any HTTP URL (streaming/progress endpoints)
      // - Old /media/ paths (should be /storage/)
      // - /stream/ or /progress/ in the path
      if (trimmed.includes('http://') || 
          trimmed.includes('https://') ||
          trimmed.includes('/stream/') || 
          trimmed.includes('/progress/') ||
          trimmed.startsWith('/media/')) {
        return true;
      }
      
      // If it doesn't start with /storage/, it probably needs update
      if (!trimmed.startsWith('/storage/')) {
        return true;
      }
      
      // Check for legacy path format: /storage/movies/... or /storage/tv/... (missing disk name)
      // Valid format should be: /storage/<disk>/movies/... or /storage/<disk>/tv/...
      if (this.isLegacyStrmPath(trimmed)) {
        return true;
      }
      
      return false;
    } catch (e) {
      // File doesn't exist or can't be read
      return false;
    }
  }

  /**
   * Check if a .strm path is in the legacy format (missing disk name).
   * Legacy format: /storage/movies/... or /storage/tv/...
   * Valid format: /storage/<disk>/movies/... or /storage/<disk>/tv/...
   */
  isLegacyStrmPath(strmContent: string): boolean {
    // Legacy paths start with /storage/ followed directly by movies/ or tv/
    return /^\/storage\/(movies|tv|web)\//.test(strmContent);
  }

  /**
   * Fix a legacy .strm path by finding the actual file on disk and updating the path.
   * This handles migration from the old path format to the new disk-based format.
   * 
   * Old format: /storage/movies/Title (Year)/file.mp4
   * New format: /storage/<disk>/movies/Title (Year)/file.mp4
   * 
   * @param strmPath - The path to the .strm file
   * @returns true if the file was fixed, false otherwise
   */
  async fixLegacyStrmPath(strmPath: string): Promise<boolean> {
    try {
      const content = await readFile(strmPath, 'utf8');
      const trimmed = content.trim();
      
      // Only fix if it's a legacy path (not a progress URL)
      if (!this.isLegacyStrmPath(trimmed)) {
        return false;
      }
      
      // Parse the legacy path to extract type and relative path
      // Example: /storage/movies/Title (Year)/file.mp4 -> type=movies, relativePath=Title (Year)/file.mp4
      const match = trimmed.match(/^\/storage\/(movies|tv|web)\/(.+)$/);
      if (!match) {
        console.warn(`[MediaService] Could not parse legacy path: ${trimmed}`);
        return false;
      }
      
      const [, mediaType, relativePath] = match;
      
      // Search for the file on available disks
      const disks = await this.getDiskStats();
      
      for (const disk of disks) {
        const potentialPath = path.join(disk.path, mediaType, relativePath);
        try {
          await access(potentialPath);
          // File exists on this disk - update the .strm
          const newJellyfinPath = `/storage/${disk.name}/${mediaType}/${relativePath}`;
          await writeFile(strmPath, newJellyfinPath);
          console.log(`[MediaService] Fixed legacy .strm path:`);
          console.log(`  File: ${strmPath}`);
          console.log(`  Old: ${trimmed}`);
          console.log(`  New: ${newJellyfinPath}`);
          return true;
        } catch {
          // File not on this disk, try next
        }
      }
      
      console.warn(`[MediaService] Could not find file for legacy path: ${trimmed}`);
      return false;
    } catch (error) {
      console.error(`[MediaService] Error fixing legacy .strm path ${strmPath}:`, error);
      return false;
    }
  }

  /**
   * Scan all .strm files in the content directory and fix any with legacy paths.
   * This is a one-time migration for files created before the multi-disk update.
   * 
   * @returns Object with counts of fixed, skipped, and error files
   */
  async fixAllLegacyStrmPaths(): Promise<{ fixed: number; skipped: number; errors: number }> {
    const result = { fixed: 0, skipped: 0, errors: 0 };
    const contentPath = config.paths.content;
    
    console.log(`[MediaService] Scanning for legacy .strm paths in: ${contentPath}`);
    
    // Helper to recursively find all .strm files
    const findStrmFiles = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stats = await stat(fullPath);
          if (stats.isDirectory()) {
            files.push(...await findStrmFiles(fullPath));
          } else if (entry.endsWith('.strm')) {
            files.push(fullPath);
          }
        }
      } catch (e) {
        // Directory doesn't exist or can't be read
      }
      return files;
    };
    
    const strmFiles = await findStrmFiles(contentPath);
    console.log(`[MediaService] Found ${strmFiles.length} .strm files to check`);
    
    for (const strmFile of strmFiles) {
      try {
        const content = await readFile(strmFile, 'utf8');
        const trimmed = content.trim();
        
        // Skip progress URLs
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          result.skipped++;
          continue;
        }
        
        // Skip already-correct paths (has disk name)
        if (!this.isLegacyStrmPath(trimmed)) {
          result.skipped++;
          continue;
        }
        
        // Attempt to fix
        const fixed = await this.fixLegacyStrmPath(strmFile);
        if (fixed) {
          result.fixed++;
        } else {
          result.errors++;
        }
      } catch (error) {
        result.errors++;
      }
    }
    
    console.log(`[MediaService] Legacy path fix complete: ${result.fixed} fixed, ${result.skipped} skipped, ${result.errors} errors`);
    return result;
  }

  /**
   * Scan all .strm files in the content directory and update any that
   * still point to streaming endpoints to use direct file paths.
   * 
   * This is used for migrating existing .strm files after the approach change.
   * Also triggers Jellyfin refresh for each updated item.
   * 
   * @returns Object with counts of updated and skipped files
   */
  async migrateStrmFilesToDirectPaths(): Promise<{ updated: number; skipped: number; errors: number }> {
    const result = { updated: 0, skipped: 0, errors: 0 };
    
    // Import jellyfinService here to avoid circular dependency issues
    const { jellyfinService } = await import('./jellyfin');
    
    // Get all media items that have a file on disk
    const MediaItemModel = (await import('../models')).MediaItem;
    const mediaItems = await MediaItemModel.findAll({
      where: {
        filePath: { [require('sequelize').Op.ne]: null },
        diskPath: { [require('sequelize').Op.ne]: null },
      },
    });
    
    console.log(`Found ${mediaItems.length} media items with files on disk to check for migration`);
    
    for (const media of mediaItems) {
      try {
        // Check if the .strm file needs updating
        if (await this.strmNeedsUpdate(media)) {
          const fullPath = path.join(media.diskPath!, media.filePath!);
          const strmPath = await this.updateStrmFileToDirectPath(media, fullPath);
          if (strmPath) {
            result.updated++;
            
            // Trigger Jellyfin refresh for this item
            try {
              const refreshed = await jellyfinService.refreshItemByPath(strmPath);
              if (refreshed) {
                console.log(`Triggered Jellyfin refresh for: ${media.title}`);
              }
            } catch (e) {
              console.warn(`Could not refresh Jellyfin for ${media.title}:`, e);
            }
          } else {
            result.errors++;
          }
        } else {
          result.skipped++;
        }
      } catch (e) {
        console.error(`Error migrating .strm for ${media.title}:`, e);
        result.errors++;
      }
    }
    
    console.log(`STRM migration complete: ${result.updated} updated, ${result.skipped} skipped, ${result.errors} errors`);
    return result;
  }

  /**
   * Move a file to the trash directory instead of permanently deleting it.
   * Creates a timestamped subdirectory to allow recovery.
   * 
   * @param filePath - Full path to the file to move to trash
   * @returns The path in the trash directory, or null if move failed
   */
  async moveToTrash(filePath: string): Promise<string | null> {
    try {
      // Ensure trash directory exists
      await mkdir(config.paths.trash, { recursive: true });
      
      // Create timestamped subdirectory for this deletion
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const trashSubdir = path.join(config.paths.trash, timestamp);
      await mkdir(trashSubdir, { recursive: true });
      
      // Get the relative path from storage root to preserve structure
      const fileName = path.basename(filePath);
      const trashPath = path.join(trashSubdir, fileName);
      
      // Move the file to trash
      const { exec } = require('child_process');
      await new Promise<void>((resolve, reject) => {
        exec(`mv "${filePath}" "${trashPath}"`, (error: any) => {
          if (error) reject(error);
          else resolve();
        });
      });
      
      console.log(`Moved to trash: ${filePath} -> ${trashPath}`);
      return trashPath;
    } catch (e) {
      console.error(`Failed to move to trash: ${filePath}`, e);
      return null;
    }
  }

  /**
   * Delete only the downloaded file for a media item, keeping the metadata.
   * The file is moved to trash for potential recovery.
   * The .strm file is updated to point back to the progress video endpoint.
   * 
   * @param media - The MediaItem whose downloaded file should be deleted
   * @returns Object with success status and message
   */
  async deleteDownloadedFile(media: MediaItem): Promise<{ success: boolean; message: string }> {
    try {
      // Get the file path
      const filePath = await this.getMediaFilePath(media);
      
      if (!filePath) {
        return { success: false, message: 'No downloaded file found for this media item' };
      }
      
      // Move the file to trash
      const trashPath = await this.moveToTrash(filePath);
      if (!trashPath) {
        return { success: false, message: 'Failed to move file to trash' };
      }
      
      // Try to clean up empty directories
      const fileDir = path.dirname(filePath);
      await this.removeEmptyDirectory(fileDir);
      
      // Update the media item to clear file path
      media.filePath = undefined;
      media.diskPath = undefined;
      await media.save();
      
      // Update .strm file to point back to progress video
      const strmPath = await this.updateStrmFileToProgressUrl(media);
      if (strmPath) {
        console.log(`Updated .strm file to progress URL: ${strmPath}`);
        
        // Trigger Jellyfin refresh
        try {
          const { jellyfinService } = await import('./jellyfin');
          await jellyfinService.refreshItemByPath(strmPath);
        } catch (e) {
          console.warn('Could not refresh Jellyfin:', e);
        }
      }
      
      return { success: true, message: `File moved to trash: ${trashPath}` };
    } catch (e: any) {
      console.error('Error deleting downloaded file:', e);
      return { success: false, message: e.message || 'Failed to delete downloaded file' };
    }
  }

  /**
   * Delete an entire TV show and all its associated files.
   * All files are moved to trash for potential recovery.
   * 
   * @param title - The TV show title
   * @param deleteFiles - Whether to also delete downloaded files
   * @returns Object with counts of deleted items
   */
  async deleteTvShow(title: string, deleteFiles: boolean): Promise<{ 
    deletedEpisodes: number; 
    trashedFiles: number;
    message: string;
  }> {
    let trashedFiles = 0;
    
    // Get all episodes for this show
    const episodes = await MediaItem.findAll({
      where: { type: 'tv', title },
    });
    
    // Move downloaded files to trash if requested
    if (deleteFiles) {
      for (const episode of episodes) {
        const filePath = await this.getMediaFilePath(episode);
        if (filePath) {
          const trashPath = await this.moveToTrash(filePath);
          if (trashPath) {
            trashedFiles++;
          }
        }
      }
    }
    
    // Delete the content files (.strm and .yml)
    for (const episode of episodes) {
      try {
        await this.deleteMediaFiles(episode);
      } catch (e) {
        console.warn(`Failed to delete media files for episode:`, e);
      }
    }
    
    // Clean up empty directories
    const showPath = path.join(config.paths.content, 'tv', title);
    try {
      const { exec } = require('child_process');
      await new Promise<void>((resolve) => {
        // Remove empty directories recursively
        exec(`find "${showPath}" -type d -empty -delete 2>/dev/null; rm -rf "${showPath}" 2>/dev/null`, () => resolve());
      });
    } catch (e) {
      // Ignore cleanup errors
    }
    
    return {
      deletedEpisodes: episodes.length,
      trashedFiles,
      message: `Deleted ${episodes.length} episodes, ${trashedFiles} files moved to trash`,
    };
  }
}

export const mediaService = new MediaService();
