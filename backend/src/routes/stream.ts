/**
 * Stream Routes
 * 
 * These streaming endpoints serve video content for external media players.
 * When media is downloaded, the actual file is streamed. When media is still
 * downloading, the request is redirected to the progress video endpoint.
 * 
 * These endpoints are designed for use with external players like VLC.
 * For Jellyfin, .strm files are updated to point directly to file paths
 * after download completes.
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { MediaItem } from '../models';
import { slugify, mediaService } from '../services/media';

const router = Router();

// Helper function to find media by slug-based path
async function findMediaByPath(
  type: string,
  titleSlug: string,
  yearOrEpisode?: string
): Promise<MediaItem | null> {
  const where: any = { type };
  const allMedia = await MediaItem.findAll({ where });
  
  for (const media of allMedia) {
    const mediaSlug = slugify(media.title);
    
    if (mediaSlug === titleSlug) {
      if (type === 'movie') {
        const year = parseInt(yearOrEpisode || '0', 10);
        if (!year || media.year === year) {
          return media;
        }
      } else if (type === 'tv') {
        if (yearOrEpisode) {
          const match = yearOrEpisode.toLowerCase().match(/s(\d+)e(\d+)/);
          if (match) {
            const season = parseInt(match[1], 10);
            const episode = parseInt(match[2], 10);
            if (media.season === season && media.episode === episode) {
              return media;
            }
          }
        }
      } else {
        return media;
      }
    }
  }
  
  return null;
}

/**
 * Stream a video file with support for range requests (seeking).
 * Returns true if the file was streamed, false if not found.
 */
async function streamFile(filePath: string, req: any, res: any): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Determine content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';
    
    if (range) {
      // Handle range request for video seeking
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      
      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      // Stream the entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
    
    return true;
  } catch (e) {
    return false;
  }
}

// Stream movie: /stream/movies/:title/:year
router.get('/movies/:title/:year', async (req, res) => {
  const { title, year } = req.params;
  
  const media = await findMediaByPath('movie', title, year);
  if (!media) {
    return res.status(404).json({ error: 'Movie not found' });
  }
  
  // Check if file is available on disk
  const filePath = await mediaService.getMediaFilePath(media);
  if (filePath) {
    const streamed = await streamFile(filePath, req, res);
    if (streamed) return;
  }
  
  // File not available - redirect to progress video
  res.redirect(307, `/progress/movies/${title}/${year}`);
});

// Stream TV episode: /stream/tv/:title/:episode
router.get('/tv/:title/:episode', async (req, res) => {
  const { title, episode } = req.params;
  
  const media = await findMediaByPath('tv', title, episode);
  if (!media) {
    return res.status(404).json({ error: 'Episode not found' });
  }
  
  // Check if file is available on disk
  const filePath = await mediaService.getMediaFilePath(media);
  if (filePath) {
    const streamed = await streamFile(filePath, req, res);
    if (streamed) return;
  }
  
  // File not available - redirect to progress video
  res.redirect(307, `/progress/tv/${title}/${episode}`);
});

// Stream web content: /stream/web/:title
router.get('/web/:title', async (req, res) => {
  const { title } = req.params;
  
  const media = await findMediaByPath('web', title);
  if (!media) {
    return res.status(404).json({ error: 'Content not found' });
  }
  
  // Check if file is available on disk
  const filePath = await mediaService.getMediaFilePath(media);
  if (filePath) {
    const streamed = await streamFile(filePath, req, res);
    if (streamed) return;
  }
  
  // File not available - redirect to progress video
  res.redirect(307, `/progress/web/${title}`);
});

// Download file by ID: /stream/download/:id
router.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  
  const media = await MediaItem.findByPk(id);
  if (!media) {
    return res.status(404).json({ error: 'Media not found' });
  }
  
  const filePath = await mediaService.getMediaFilePath(media);
  if (!filePath) {
    return res.status(404).json({ error: 'File not available for download' });
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.mkv' ? 'video/x-matroska' : 'video/mp4';

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch {
    return res.status(404).json({ error: 'File not found on disk' });
  }
});

// Stream by ID: /stream/:id
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  
  const media = await MediaItem.findByPk(id);
  if (!media) {
    return res.status(404).json({ error: 'Media not found' });
  }
  
  // Check if file is available on disk
  const filePath = await mediaService.getMediaFilePath(media);
  if (filePath) {
    const streamed = await streamFile(filePath, req, res);
    if (streamed) return;
  }
  
  // File not available - redirect to progress video
  res.redirect(307, `/progress/${id}`);
});

export default router;
