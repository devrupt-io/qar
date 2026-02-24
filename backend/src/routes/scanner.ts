/**
 * Content Scanner API Routes
 * 
 * Provides endpoints for triggering and monitoring content scans
 */

import { Router } from 'express';
import { contentScannerService } from '../services/contentScanner';
import { mediaService } from '../services/media';

const router = Router();

/**
 * GET /api/scanner/status
 * Get the current scanner status and progress
 */
router.get('/status', async (req, res) => {
  try {
    const progress = contentScannerService.getProgress();
    const lastScan = await contentScannerService.getLastScanTimestamp();
    
    res.json({
      ...progress,
      lastScanTime: lastScan?.toISOString() || progress.lastScanTime,
    });
  } catch (error) {
    console.error('Get scanner status error:', error);
    res.status(500).json({ error: 'Failed to get scanner status' });
  }
});

/**
 * POST /api/scanner/scan
 * Trigger a full content scan
 */
router.post('/scan', async (req, res) => {
  try {
    const progress = contentScannerService.getProgress();
    
    if (progress.phase !== 'idle' && progress.phase !== 'complete') {
      return res.status(409).json({ 
        error: 'Scan already in progress',
        phase: progress.phase,
      });
    }
    
    // Start scan in background
    contentScannerService.runFullScan().catch(error => {
      console.error('Background scan error:', error);
    });
    
    res.json({ 
      message: 'Scan started',
      phase: 'scanning-content',
    });
  } catch (error) {
    console.error('Trigger scan error:', error);
    res.status(500).json({ error: 'Failed to start scan' });
  }
});

/**
 * POST /api/scanner/fix-legacy-paths
 * Fix .strm files with legacy path format (missing disk name)
 * This converts /storage/movies/... to /storage/<disk>/movies/...
 */
router.post('/fix-legacy-paths', async (req, res) => {
  try {
    console.log('[Scanner API] Starting legacy path fix...');
    const result = await mediaService.fixAllLegacyStrmPaths();
    
    res.json({
      message: 'Legacy path fix complete',
      ...result,
    });
  } catch (error) {
    console.error('Fix legacy paths error:', error);
    res.status(500).json({ error: 'Failed to fix legacy paths' });
  }
});

/**
 * POST /api/scanner/settings
 * Update scanner settings
 */
router.post('/settings', async (req, res) => {
  try {
    const { maxItemsPerHour } = req.body;
    
    if (typeof maxItemsPerHour === 'number' && maxItemsPerHour > 0) {
      contentScannerService.setMaxItemsPerHour(maxItemsPerHour);
    }
    
    res.json({
      message: 'Settings updated',
      maxItemsPerHour: contentScannerService.getProgress().maxItemsPerHour,
    });
  } catch (error) {
    console.error('Update scanner settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * GET /api/scanner/preview
 * Preview what items would be scanned without processing them
 */
router.get('/preview', async (req, res) => {
  try {
    const progress = contentScannerService.getProgress();
    
    if (progress.phase !== 'idle' && progress.phase !== 'complete') {
      return res.status(409).json({ 
        error: 'Scan already in progress',
        phase: progress.phase,
      });
    }
    
    // Get items from content and storage
    const contentResults = await contentScannerService.scanContentDirectory();
    const storageResults = await contentScannerService.scanStorageDirectory();
    
    // Merge results
    const resultMap = new Map<string, any>();
    
    for (const result of contentResults) {
      const key = `${result.type}:${result.title}:${result.year || 0}:${result.season || 0}:${result.episode || 0}`;
      resultMap.set(key, {
        ...result,
        hasContentFiles: true,
        hasStorageFile: false,
      });
    }
    
    for (const result of storageResults) {
      const key = `${result.type}:${result.title}:${result.year || 0}:${result.season || 0}:${result.episode || 0}`;
      const existing = resultMap.get(key);
      
      if (existing) {
        existing.hasStorageFile = true;
        existing.filePath = result.filePath;
      } else {
        resultMap.set(key, {
          ...result,
          hasContentFiles: false,
          hasStorageFile: true,
        });
      }
    }
    
    const allResults = Array.from(resultMap.values());
    
    // Mark items already in database
    const markedResults = await contentScannerService.markExistingItems(allResults);
    
    // Count by status
    const summary = {
      total: markedResults.length,
      alreadyInDb: markedResults.filter(r => r.alreadyInDb).length,
      needsImport: markedResults.filter(r => !r.alreadyInDb).length,
      needsOmdbLookup: markedResults.filter(r => !r.alreadyInDb && r.needsOmdbLookup).length,
      movies: markedResults.filter(r => r.type === 'movie').length,
      tvEpisodes: markedResults.filter(r => r.type === 'tv').length,
      webContent: markedResults.filter(r => r.type === 'web').length,
    };
    
    res.json({
      summary,
      items: markedResults.map(r => ({
        type: r.type,
        title: r.title,
        year: r.year,
        season: r.season,
        episode: r.episode,
        source: r.source,
        alreadyInDb: r.alreadyInDb,
        needsOmdbLookup: r.needsOmdbLookup,
        hasImdbId: !!r.imdbId,
        hasContentFiles: r.strmPath ? true : false,
        hasStorageFile: r.filePath ? true : false,
      })),
    });
  } catch (error) {
    console.error('Preview scan error:', error);
    res.status(500).json({ error: 'Failed to preview scan' });
  }
});

/**
 * POST /api/scanner/fix-images
 * Fix items that are missing poster images by looking them up in OMDB
 */
router.post('/fix-images', async (req, res) => {
  try {
    const { limit = 100 } = req.body;
    
    // Import MediaItem and TVShow to query directly
    const { MediaItem, TVShow } = await import('../models');
    const { omdbService } = await import('../services/omdb');
    const { Op } = await import('sequelize');
    
    if (!omdbService.isConfigured()) {
      return res.status(400).json({ 
        error: 'OMDB API key not configured',
        message: 'Please configure the OMDB API key in Settings to fix missing images',
      });
    }
    
    // Find items missing poster URLs (null or empty string)
    // We get all items and filter in memory to avoid Sequelize typing issues
    const allItems = await MediaItem.findAll({
      where: {
        type: { [Op.in]: ['movie', 'tv'] },
      },
      order: [['createdAt', 'DESC']],
    });
    
    const itemsMissingPosters = allItems.filter(
      item => !item.posterUrl || item.posterUrl === ''
    ).slice(0, parseInt(limit, 10));
    
    // Find TV shows missing poster URLs
    const allShows = await TVShow.findAll({
      order: [['createdAt', 'DESC']],
    });
    
    const showsMissingPosters = allShows.filter(
      show => !show.posterUrl || show.posterUrl === ''
    ).slice(0, parseInt(limit, 10));
    
    let fixedItems = 0;
    let fixedShows = 0;
    const errors: string[] = [];
    
    // Fix TV shows first (they appear in the library view)
    for (const show of showsMissingPosters) {
      try {
        const searchResults = await omdbService.search(show.title, 'series');
        if (searchResults && searchResults.length > 0) {
          const details = await omdbService.getDetails(searchResults[0].imdbID);
          if (details && details.Poster !== 'N/A') {
            await show.update({
              posterUrl: details.Poster,
              imdbId: details.imdbID,
              plot: details.Plot || show.plot,
            });
            fixedShows++;
            console.log(`[Scanner] Fixed poster for TVShow: ${show.title}`);
          }
        }
      } catch (e: any) {
        errors.push(`TVShow ${show.title}: ${e.message}`);
      }
    }
    
    // Fix individual media items
    // Group by title to avoid duplicate OMDB lookups
    const titleGroups = new Map<string, typeof itemsMissingPosters>();
    for (const item of itemsMissingPosters) {
      const key = `${item.type}:${item.title}`;
      if (!titleGroups.has(key)) {
        titleGroups.set(key, []);
      }
      titleGroups.get(key)!.push(item);
    }
    
    for (const [key, items] of titleGroups) {
      const firstItem = items[0];
      try {
        const searchType = firstItem.type === 'tv' ? 'series' : 'movie';
        const searchResults = await omdbService.search(firstItem.title, searchType);
        
        if (searchResults && searchResults.length > 0) {
          // Find best match by year if available
          let bestMatch = searchResults[0];
          if (firstItem.year) {
            const yearMatch = searchResults.find(r => 
              r.Year === String(firstItem.year) || r.Year.startsWith(String(firstItem.year))
            );
            if (yearMatch) bestMatch = yearMatch;
          }
          
          const details = await omdbService.getDetails(bestMatch.imdbID);
          if (details && details.Poster !== 'N/A') {
            // Update all items with this title
            for (const item of items) {
              await item.update({
                posterUrl: details.Poster,
                imdbId: details.imdbID,
                plot: details.Plot || item.plot,
              });
              fixedItems++;
            }
            console.log(`[Scanner] Fixed poster for ${items.length} items: ${firstItem.title}`);
          }
        }
      } catch (e: any) {
        errors.push(`${firstItem.type} ${firstItem.title}: ${e.message}`);
      }
    }
    
    res.json({
      message: `Fixed ${fixedItems} media items and ${fixedShows} TV shows`,
      fixedItems,
      fixedShows,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Fix images error:', error);
    res.status(500).json({ error: 'Failed to fix images' });
  }
});

export default router;
