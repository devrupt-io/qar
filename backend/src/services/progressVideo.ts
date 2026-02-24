/**
 * Progress Video Service
 * 
 * Generates a finite MP4 video showing download progress for media items.
 * This is displayed in Jellyfin while content is being downloaded, providing
 * visual feedback to users instead of an error or buffering state.
 * 
 * Key design decisions:
 * 1. Generates a complete, finite MP4 file that Jellyfin can analyze
 * 2. Uses a fixed duration (30 seconds) so Jellyfin knows the video length
 * 3. Writes to a temp file first, then streams (allows faststart for proper moov)
 * 4. When the download completes, redirects to the actual video stream
 * 
 * Once the download completes, the .strm file is updated to point directly
 * to the downloaded file, and Jellyfin is refreshed to enable direct play.
 */
import { spawn } from 'child_process';
import { Response } from 'express';
import { Download, MediaItem } from '../models';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ProgressInfo {
  title: string;
  status: string;
  progress: number;
  downloadSpeed?: number;
  eta?: number;
  error?: string;
}

// Fixed duration for progress videos - long enough to not be marked as "watched"
// but short enough that users will re-request for updated progress
const VIDEO_DURATION = 30;

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format seconds to human readable time
 */
function formatEta(seconds: number): string {
  if (!seconds || seconds <= 0) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Get status display text
 */
function getStatusText(info: ProgressInfo): string {
  switch (info.status) {
    case 'pending':
      return 'Waiting to start...';
    case 'downloading':
      return 'Downloading...';
    case 'paused':
      return 'Download paused';
    case 'failed':
      return `Error: ${info.error || 'Download failed'}`;
    case 'not_started':
      return 'Starting download...';
    case 'metadata':
      return 'Fetching torrent info...';
    default:
      return info.status;
  }
}

/**
 * Escape text for FFmpeg drawtext filter
 * FFmpeg drawtext requires special escaping for certain characters
 */
function escapeForDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')       // Escape backslashes first
    .replace(/'/g, "''")          // Escape single quotes by doubling
    .replace(/:/g, '\\:')         // Escape colons
    .replace(/\[/g, '\\[')        // Escape brackets
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;')         // Escape semicolons
    .replace(/,/g, '\\,');        // Escape commas
}

/**
 * Generate FFmpeg drawtext filter for progress display
 */
function generateTextFilter(info: ProgressInfo): string {
  const title = escapeForDrawtext(info.title);
  const status = escapeForDrawtext(getStatusText(info));
  const progressPercent = Math.round(info.progress);
  
  const filters: string[] = [];
  
  // Title at top
  filters.push(`drawtext=text='${title}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=100:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
  
  // Status below title
  filters.push(`drawtext=text='${status}':fontsize=32:fontcolor=white:x=(w-text_w)/2:y=180:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
  
  // Progress bar background (gray bar)
  filters.push(`drawbox=x=100:y=280:w=1080:h=40:color=gray@0.5:t=fill`);
  
  // Progress bar foreground (blue bar based on progress)
  const progressWidth = Math.max(1, Math.round(1080 * (info.progress / 100)));
  filters.push(`drawbox=x=100:y=280:w=${progressWidth}:h=40:color=0x3498db:t=fill`);
  
  // Progress percentage text
  filters.push(`drawtext=text='${progressPercent}%%':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=350:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
  
  // Speed and ETA (only show if actively downloading)
  if (info.downloadSpeed && info.downloadSpeed > 0 && info.status === 'downloading') {
    const speedText = escapeForDrawtext(formatBytes(info.downloadSpeed) + '/s');
    const etaText = info.eta ? escapeForDrawtext('ETA: ' + formatEta(info.eta)) : '';
    
    filters.push(`drawtext=text='${speedText}':fontsize=24:fontcolor=white@0.8:x=100:y=420:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
    
    if (etaText) {
      filters.push(`drawtext=text='${etaText}':fontsize=24:fontcolor=white@0.8:x=w-text_w-100:y=420:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
    }
  }
  
  // Instruction text
  const instructionText = escapeForDrawtext('Video will start when download completes');
  filters.push(`drawtext=text='${instructionText}':fontsize=18:fontcolor=white@0.5:x=(w-text_w)/2:y=480:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
  
  // "Qar" branding at bottom
  filters.push(`drawtext=text='Qar':fontsize=18:fontcolor=white@0.5:x=(w-text_w)/2:y=520:fontfile=/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf`);
  
  return filters.join(',');
}

class ProgressVideoService {
  /**
   * Get current progress info for a media item
   */
  private async getProgressInfo(media: MediaItem): Promise<ProgressInfo> {
    const download = await Download.findOne({
      where: { mediaItemId: media.id },
      order: [['createdAt', 'DESC']],
    });
    
    return {
      title: this.formatTitle(media),
      status: download?.status || 'not_started',
      progress: download?.progress || 0,
      downloadSpeed: download?.downloadSpeed || undefined,
      eta: download?.eta || undefined,
      error: download?.error || undefined,
    };
  }
  
  /**
   * Generate and stream a complete progress video for a media item.
   * 
   * The video is a fixed duration (30 seconds) with current progress info.
   * Jellyfin can analyze this properly since it has a defined duration.
   * When the video ends, if the user tries to replay, they'll get updated progress.
   * 
   * Returns false if the request was redirected (caller should not send more data).
   */
  async streamProgress(media: MediaItem, res: Response): Promise<boolean> {
    // Check initial status - if already completed, redirect to stream endpoint
    const info = await this.getProgressInfo(media);
    if (info.status === 'completed') {
      console.log(`[ProgressVideo] Download already completed for ${media.id}, redirecting to stream`);
      const streamUrl = this.buildStreamUrl(media);
      res.redirect(302, streamUrl);
      return false;
    }
    
    console.log(`[ProgressVideo] Generating ${VIDEO_DURATION}s progress video for ${media.id} (${info.progress}%)`);
    
    const textFilter = generateTextFilter(info);
    
    // Generate video to a temp file first, then stream it
    // This allows us to use +faststart which puts moov atom at beginning
    // making the video properly analyzable by Jellyfin
    const tempFile = path.join(os.tmpdir(), `qar-progress-${media.id}-${Date.now()}.mp4`);
    
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',  // Overwrite output file
        '-f', 'lavfi',
        '-i', `color=c=0x1a1a2e:s=1280x720:r=1:d=${VIDEO_DURATION}`,
        '-vf', textFilter,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'baseline',  // Most compatible H.264 profile
        '-level', '3.0',
        // Use faststart to put moov atom at beginning for streaming
        '-movflags', '+faststart',
        '-f', 'mp4',
        '-t', String(VIDEO_DURATION),
        tempFile
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      ffmpeg.stderr.on('data', (data: Buffer) => {
        const message = data.toString();
        // Only log actual errors, not progress info
        if (message.includes('Error') || message.includes('error')) {
          console.error(`[ProgressVideo] FFmpeg error for ${media.id}:`, message);
        }
      });
      
      ffmpeg.on('close', async (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[ProgressVideo] FFmpeg exited with code ${code} for ${media.id}`);
          // Clean up temp file
          try { fs.unlinkSync(tempFile); } catch {}
          if (!res.headersSent) {
            res.status(500).send('Failed to generate progress video');
          }
          resolve(false);
          return;
        }
        
        try {
          // Read the generated file
          const videoBuffer = fs.readFileSync(tempFile);
          
          // Clean up temp file
          fs.unlinkSync(tempFile);
          
          console.log(`[ProgressVideo] Generated ${videoBuffer.length} bytes for ${media.id}`);
          
          // Send complete video with proper headers
          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Length', videoBuffer.length);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          
          res.send(videoBuffer);
          resolve(true);
        } catch (err) {
          console.error(`[ProgressVideo] Error reading temp file for ${media.id}:`, err);
          // Clean up temp file
          try { fs.unlinkSync(tempFile); } catch {}
          if (!res.headersSent) {
            res.status(500).send('Failed to read progress video');
          }
          resolve(false);
        }
      });
      
      ffmpeg.on('error', (err) => {
        console.error(`[ProgressVideo] FFmpeg spawn error for ${media.id}:`, err);
        // Clean up temp file
        try { fs.unlinkSync(tempFile); } catch {}
        if (!res.headersSent) {
          res.status(500).send('Failed to generate progress video');
        }
        resolve(false);
      });
    });
  }
  
  /**
   * Format media title for display
   */
  private formatTitle(media: MediaItem): string {
    if (media.type === 'movie') {
      return `${media.title} (${media.year || 'Unknown'})`;
    } else if (media.type === 'tv') {
      const season = String(media.season || 1).padStart(2, '0');
      const episode = String(media.episode || 1).padStart(2, '0');
      return `${media.title} - S${season}E${episode}`;
    } else {
      return media.title;
    }
  }
  
  /**
   * Build stream URL for a media item (used for redirect when download is complete)
   */
  private buildStreamUrl(media: MediaItem): string {
    const slug = media.title.toLowerCase().replace(/[^a-z0-9]+/g, '+');
    
    if (media.type === 'movie') {
      return `/stream/movies/${slug}/${media.year || 0}`;
    } else if (media.type === 'tv') {
      const season = String(media.season || 1).padStart(2, '0');
      const episode = String(media.episode || 1).padStart(2, '0');
      return `/stream/tv/${slug}/s${season}e${episode}`;
    } else {
      return `/stream/web/${slug}`;
    }
  }
  
  /**
   * Stop all active streams (for cleanup) - kept for API compatibility
   */
  stopAllStreams(): void {
    // No-op since we now generate complete videos instead of streaming
  }
}

export const progressVideoService = new ProgressVideoService();
