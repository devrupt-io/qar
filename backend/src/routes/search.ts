import { Router } from 'express';
import { omdbService } from '../services/omdb';
import { torrentSearchService } from '../services/torrentSearch';
import { episodeDetector } from '../services/episodeDetector';
import { Setting } from '../models';
import { config } from '../config';

const router = Router();

// Helper function to get search preferences from settings
// Supports both legacy single-value and new multi-value array formats
async function getSearchPreferences(): Promise<{
  preferredCodecs: string[];
  preferredResolutions: string[];
  preferredMovieGroups: string[];
}> {
  // Try new array-based settings first, fall back to legacy single-value settings
  const codecsSetting = await Setting.findOne({ where: { key: 'preferredCodecs' } });
  const resolutionsSetting = await Setting.findOne({ where: { key: 'preferredResolutions' } });
  const groupsSetting = await Setting.findOne({ where: { key: 'preferredMovieGroups' } });

  // Legacy single-value settings as fallback
  const codecSetting = await Setting.findOne({ where: { key: 'preferredCodec' } });
  const resolutionSetting = await Setting.findOne({ where: { key: 'preferredResolution' } });
  const groupSetting = await Setting.findOne({ where: { key: 'preferredMovieGroup' } });

  // Parse JSON arrays or use legacy values
  const parseArraySetting = (arraySetting: any, legacySetting: any, defaults: string[]): string[] => {
    if (arraySetting?.value) {
      try {
        const parsed = JSON.parse(arraySetting.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Invalid JSON, try as comma-separated string
        if (arraySetting.value.includes(',')) {
          return arraySetting.value.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      }
    }
    // Fall back to legacy single value
    if (legacySetting?.value) {
      return [legacySetting.value];
    }
    return defaults;
  };

  return {
    preferredCodecs: parseArraySetting(codecsSetting, codecSetting, config.defaults.preferredCodecs),
    preferredResolutions: parseArraySetting(resolutionsSetting, resolutionSetting, config.defaults.preferredResolutions),
    preferredMovieGroups: parseArraySetting(groupsSetting, groupSetting, config.defaults.preferredMovieGroups),
  };
}

// Search for movies and TV shows via OMDB
router.get('/omdb', async (req, res) => {
  try {
    const { q, type } = req.query;
    
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const searchType = type === 'movie' || type === 'series' ? type : undefined;
    const results = await omdbService.search(q.trim(), searchType);
    
    res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get detailed info for a specific title
router.get('/omdb/:imdbId', async (req, res) => {
  try {
    const { imdbId } = req.params;
    const details = await omdbService.getDetails(imdbId);
    
    if (!details) {
      return res.status(404).json({ error: 'Title not found' });
    }
    
    res.json(details);
  } catch (error) {
    console.error('Details error:', error);
    res.status(500).json({ error: 'Failed to get details' });
  }
});

// Get season details for a TV show
router.get('/omdb/:imdbId/season/:season', async (req, res) => {
  try {
    const { imdbId, season } = req.params;
    const details = await omdbService.getSeasonDetails(imdbId, parseInt(season, 10));
    
    if (!details) {
      return res.status(404).json({ error: 'Season not found' });
    }
    
    res.json(details);
  } catch (error) {
    console.error('Season details error:', error);
    res.status(500).json({ error: 'Failed to get season details' });
  }
});

// Search for torrents
router.get('/torrents', async (req, res) => {
  try {
    const { q, category, applyPreferences, overrideCodec, overrideResolution, overrideGroup } = req.query;
    
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    let searchQuery = q;
    
    // Apply search preferences if requested
    if (applyPreferences === 'true') {
      const prefs = await getSearchPreferences();
      
      // Use override values if provided, otherwise use the first saved preference
      // Empty string overrides mean "don't use any preference"
      // "none" or "any" are special values meaning explicitly disable the preference
      // For arrays, we use the first (preferred) value for the search query
      const useCodec = overrideCodec !== undefined 
        ? (overrideCodec === 'none' || overrideCodec === 'any' ? '' : overrideCodec as string) 
        : (prefs.preferredCodecs.length > 0 ? prefs.preferredCodecs[0] : '');
      const useResolution = overrideResolution !== undefined 
        ? (overrideResolution === 'none' || overrideResolution === 'any' ? '' : overrideResolution as string) 
        : (prefs.preferredResolutions.length > 0 ? prefs.preferredResolutions[0] : '');
      const useGroup = overrideGroup !== undefined 
        ? (overrideGroup === 'none' || overrideGroup === 'any' ? '' : overrideGroup as string) 
        : (prefs.preferredMovieGroups.length > 0 ? prefs.preferredMovieGroups[0] : '');
      
      // Add resolution and codec to the search (if not empty)
      if (useResolution && !q.includes(useResolution)) {
        searchQuery += ` ${useResolution}`;
      }
      if (useCodec && !q.toLowerCase().includes(useCodec.toLowerCase())) {
        searchQuery += ` ${useCodec}`;
      }
      
      // For movies, add the preferred group (if not empty)
      if (category === 'Movies' && useGroup && 
          !q.toLowerCase().includes(useGroup.toLowerCase())) {
        searchQuery += ` ${useGroup}`;
      }
    }

    console.log(`[API] Torrent search request: q="${searchQuery}", category="${category || 'all'}"`);
    const searchCategory = category === 'Movies' || category === 'TV' ? category : undefined;
    let searchResponse = await torrentSearchService.search(searchQuery, searchCategory);
    
    // Progressive fallback: if no results, try removing filters one by one
    if (searchResponse.results.length === 0 && applyPreferences === 'true') {
      const prefs = await getSearchPreferences();
      const usedGroup = overrideGroup !== undefined 
        ? (overrideGroup === 'none' || overrideGroup === 'any' ? '' : overrideGroup as string) 
        : (prefs.preferredMovieGroups.length > 0 ? prefs.preferredMovieGroups[0] : '');
      const usedCodec = overrideCodec !== undefined
        ? (overrideCodec === 'none' || overrideCodec === 'any' ? '' : overrideCodec as string)
        : (prefs.preferredCodecs.length > 0 ? prefs.preferredCodecs[0] : '');
      const usedResolution = overrideResolution !== undefined
        ? (overrideResolution === 'none' || overrideResolution === 'any' ? '' : overrideResolution as string)
        : (prefs.preferredResolutions.length > 0 ? prefs.preferredResolutions[0] : '');

      const removedFilters: string[] = [];
      let fallbackQuery = searchQuery;

      // Step 1: Remove release group
      if (usedGroup && fallbackQuery.includes(usedGroup)) {
        fallbackQuery = fallbackQuery.replace(new RegExp(`\\s+${usedGroup}`, 'i'), '').trim();
        removedFilters.push(`group "${usedGroup}"`);
        console.log(`[API] Fallback: removed group, trying: "${fallbackQuery}"`);
        searchResponse = await torrentSearchService.search(fallbackQuery, searchCategory);
      }

      // Step 2: Remove codec
      if (searchResponse.results.length === 0 && usedCodec && fallbackQuery.toLowerCase().includes(usedCodec.toLowerCase())) {
        fallbackQuery = fallbackQuery.replace(new RegExp(`\\s+${usedCodec}`, 'i'), '').trim();
        removedFilters.push(`codec "${usedCodec}"`);
        console.log(`[API] Fallback: removed codec, trying: "${fallbackQuery}"`);
        searchResponse = await torrentSearchService.search(fallbackQuery, searchCategory);
      }

      // Step 3: Remove resolution
      if (searchResponse.results.length === 0 && usedResolution && fallbackQuery.toLowerCase().includes(usedResolution.toLowerCase())) {
        fallbackQuery = fallbackQuery.replace(new RegExp(`\\s+${usedResolution}`, 'i'), '').trim();
        removedFilters.push(`resolution "${usedResolution}"`);
        console.log(`[API] Fallback: removed resolution, trying: "${fallbackQuery}"`);
        searchResponse = await torrentSearchService.search(fallbackQuery, searchCategory);
      }

      if (removedFilters.length > 0 && searchResponse.results.length > 0) {
        // Only warn about filters that the results genuinely lack
        const resultNames = searchResponse.results.map(r => r.name.toLowerCase());
        const actuallyMissing = removedFilters.filter(f => {
          const match = f.match(/"(.+)"/);
          if (!match) return false;
          const filterVal = match[1].toLowerCase();
          return !resultNames.some(name => name.includes(filterVal));
        });
        if (actuallyMissing.length > 0) {
          searchResponse.warnings = searchResponse.warnings || [];
          searchResponse.warnings.push(`Broadened search (no exact matches for ${actuallyMissing.join(', ')}).`);
        }
      }
    }
    
    console.log(`[API] Torrent search completed: ${searchResponse.results.length} results returned`);
    
    // Return structured response with search metadata
    res.json({
      results: searchResponse.results,
      searchQuery: searchResponse.searchQuery,
      warnings: searchResponse.warnings,
      error: searchResponse.error,
      source: searchResponse.source,
      torHealthy: searchResponse.torHealthy,
    });
  } catch (error) {
    console.error('[API] Torrent search error:', error);
    res.status(500).json({ 
      error: 'Torrent search failed',
      results: [],
      searchQuery: req.query.q as string || '',
    });
  }
});

// Fetch magnet URI for a specific torrent (on-demand)
router.post('/torrents/magnet', async (req, res) => {
  try {
    const { detailsUrl } = req.body;
    
    if (!detailsUrl || typeof detailsUrl !== 'string') {
      return res.status(400).json({ error: 'detailsUrl is required' });
    }
    
    console.log(`[API] Fetching magnet URI from: ${detailsUrl}`);
    const result = await torrentSearchService.getMagnetUri(detailsUrl);
    
    if (result.magnetUri) {
      res.json({ magnetUri: result.magnetUri });
    } else {
      res.status(404).json({ error: result.error || 'Failed to fetch magnet link' });
    }
  } catch (error) {
    console.error('[API] Magnet fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch magnet link' });
  }
});

// Check Tor health status
router.get('/tor/health', async (req, res) => {
  try {
    const health = await torrentSearchService.checkTorHealth();
    res.json(health);
  } catch (error) {
    console.error('[API] Tor health check error:', error);
    res.status(500).json({ healthy: false, error: 'Health check failed' });
  }
});

// Reinitialize Tor connection (after restart)
router.post('/tor/reinitialize', async (req, res) => {
  try {
    torrentSearchService.reinitializeTorAgent();
    const health = await torrentSearchService.checkTorHealth();
    res.json({ 
      success: true, 
      message: 'Tor agent reinitialized',
      healthy: health.healthy,
    });
  } catch (error) {
    console.error('[API] Tor reinitialize error:', error);
    res.status(500).json({ success: false, error: 'Failed to reinitialize Tor' });
  }
});

// Search for TV show torrents with improved query patterns
// Tries multiple search strategies for better results
router.get('/torrents/tv', async (req, res) => {
  try {
    const { title, season, episode, searchType } = req.query;
    
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Query parameter "title" is required' });
    }

    const prefs = await getSearchPreferences();
    const cleanTitle = title.trim();
    
    // Handle array-based preferences - use the first value as the primary preference
    const resolution = prefs.preferredResolutions.length > 0 ? prefs.preferredResolutions[0] : '';
    const codec = prefs.preferredCodecs.length > 0 ? prefs.preferredCodecs[0] : '';
    
    // Build search queries based on searchType
    let searchQueries: string[] = [];
    
    switch (searchType) {
      case 'complete':
        // Search for complete series
        searchQueries = [
          `${cleanTitle} complete ${resolution} ${codec}`.trim(),
          `${cleanTitle} complete series ${resolution}`.trim(),
          `${cleanTitle} all seasons ${resolution}`.trim(),
          `${cleanTitle} complete`,
        ];
        break;
        
      case 'season':
        // Search for a specific season with multiple format variations
        if (season) {
          const seasonNum = String(season).padStart(2, '0');
          const seasonNumShort = String(season);
          searchQueries = [
            // Primary: S01 format with quality preferences
            `${cleanTitle} S${seasonNum} ${resolution} ${codec}`.trim(),
            `${cleanTitle} S${seasonNum} complete ${resolution}`.trim(),
            `${cleanTitle} S${seasonNum} ${resolution}`.trim(),
            // Fallback: "Season 1" format
            `${cleanTitle} Season ${seasonNumShort} ${resolution}`.trim(),
            `${cleanTitle} Season ${seasonNumShort} complete`,
            // Last resort: just S01
            `${cleanTitle} S${seasonNum}`,
          ];
        }
        break;
        
      case 'episode':
        // Search for a specific episode with S01E01 format
        if (season && episode) {
          const seasonNum = String(season).padStart(2, '0');
          const episodeNum = String(episode).padStart(2, '0');
          searchQueries = [
            // Primary: S01E01 format with quality
            `${cleanTitle} S${seasonNum}E${episodeNum} ${resolution}`.trim(),
            `${cleanTitle} S${seasonNum}E${episodeNum} ${resolution} ${codec}`.trim(),
            // Alternative: without quality preferences
            `${cleanTitle} S${seasonNum}E${episodeNum}`,
            // Alternative format: 1x01
            `${cleanTitle} ${season}x${episodeNum} ${resolution}`.trim(),
          ];
        }
        break;
        
      default:
        // Default: try complete series first, then individual searches
        searchQueries = [
          `${cleanTitle} complete ${resolution} ${codec}`.trim(),
          `${cleanTitle} season ${resolution}`.trim(),
        ];
    }
    
    // Remove duplicate spaces from queries
    searchQueries = searchQueries.map(q => q.replace(/\s+/g, ' ').trim());
    
    // Try each search query until we get results
    let results: any[] = [];
    let usedQuery = '';
    let warnings: string[] = [];
    let torHealthy = true;
    let source: string | undefined;
    
    for (const query of searchQueries) {
      console.log(`[API] Trying TV search: "${query}"`);
      const searchResponse = await torrentSearchService.search(query, 'TV');
      
      // Track warnings and health from first response
      if (searchResponse.warnings) {
        warnings = [...new Set([...warnings, ...searchResponse.warnings])];
      }
      torHealthy = searchResponse.torHealthy ?? true;
      source = searchResponse.source;
      
      if (searchResponse.results.length > 0) {
        results = searchResponse.results;
        usedQuery = query;
        break;
      }
    }
    
    // If no results with preferences, try without
    if (results.length === 0 && searchQueries.length > 0) {
      const fallbackQuery = `${cleanTitle} complete`;
      console.log(`[API] Fallback TV search: "${fallbackQuery}"`);
      const fallbackResponse = await torrentSearchService.search(fallbackQuery, 'TV');
      results = fallbackResponse.results;
      usedQuery = fallbackQuery;
      if (fallbackResponse.warnings) {
        warnings = [...new Set([...warnings, ...fallbackResponse.warnings])];
      }
    }
    
    console.log(`[API] TV torrent search completed: ${results.length} results found with query "${usedQuery}"`);
    res.json({ 
      results, 
      searchQuery: usedQuery,
      searchType: searchType || 'default',
      preferences: prefs,
      warnings: warnings.length > 0 ? warnings : undefined,
      torHealthy,
      source,
    });
  } catch (error) {
    console.error('[API] TV torrent search error:', error);
    res.status(500).json({ 
      error: 'TV torrent search failed',
      results: [],
    });
  }
});

// Detect episodes from a torrent name
// Used to understand what episodes will be downloaded from a torrent
// Also validates against expected content based on search type
router.post('/detect-episodes', async (req, res) => {
  try {
    const { 
      torrentName, 
      showTitle,
      expectedType,
      expectedSeason,
      expectedEpisode,
      totalSeasons,
      episodesPerSeason
    } = req.body;
    
    if (!torrentName) {
      return res.status(400).json({ error: 'torrentName is required' });
    }
    
    const detected = episodeDetector.detect(torrentName);
    
    // Check if it matches the show title if provided
    const matchesShow = showTitle ? episodeDetector.matchesShow(torrentName, showTitle) : null;
    
    // Validate torrent contents against expectations
    let missingEpisodes = 0;
    let missingSeasons: number[] = [];
    let validationMessage: string | undefined;
    
    if (expectedType) {
      switch (expectedType) {
        case 'complete':
          // For complete series, check if all seasons are included
          if (detected.type === 'complete' || detected.isComplete) {
            // Complete series detected - good
          } else if (detected.type === 'season' && totalSeasons) {
            // Check if all seasons are included
            const detectedSeasons = new Set(detected.seasons);
            for (let s = 1; s <= totalSeasons; s++) {
              if (!detectedSeasons.has(s)) {
                missingSeasons.push(s);
              }
            }
            if (missingSeasons.length > 0) {
              validationMessage = `Missing seasons: ${missingSeasons.join(', ')}`;
            }
          } else if (detected.type === 'episode') {
            validationMessage = 'This is a single episode, not a complete series';
          } else if (detected.type === 'unknown') {
            validationMessage = 'Unable to detect episode information';
          }
          break;
          
        case 'season':
          // For season pack, check if it's the right season
          if (detected.type === 'season') {
            if (expectedSeason && !detected.seasons.includes(expectedSeason)) {
              validationMessage = `This is Season ${detected.seasons.join(', ')}, not Season ${expectedSeason}`;
            } else if (episodesPerSeason && expectedSeason) {
              // Could check episode count if we have that info
              const expectedCount = episodesPerSeason[expectedSeason];
              if (expectedCount && detected.episodes.length > 0 && detected.episodes.length < expectedCount) {
                missingEpisodes = expectedCount - detected.episodes.length;
                validationMessage = `May be missing ${missingEpisodes} episodes`;
              }
            }
          } else if (detected.type === 'episode') {
            validationMessage = 'This is a single episode, not a season pack';
          } else if (detected.type === 'complete') {
            // Complete series also works for a season request
          }
          break;
          
        case 'episode':
          // For single episode, check if it's the right one
          if (detected.type === 'episode' && expectedSeason && expectedEpisode) {
            const hasCorrectEpisode = detected.episodes.some(
              ep => ep.season === expectedSeason && ep.episode === expectedEpisode
            );
            if (!hasCorrectEpisode) {
              validationMessage = `This is ${detected.description}, not S${String(expectedSeason).padStart(2, '0')}E${String(expectedEpisode).padStart(2, '0')}`;
            }
          } else if (detected.type === 'season') {
            // Season pack also works for an episode request (will have the episode)
          } else if (detected.type === 'complete') {
            // Complete series also works
          }
          break;
      }
    }
    
    res.json({
      ...detected,
      matchesShow,
      originalName: torrentName,
      missingEpisodes,
      missingSeasons,
      validationMessage,
    });
  } catch (error) {
    console.error('Detect episodes error:', error);
    res.status(500).json({ error: 'Failed to detect episodes' });
  }
});

// Get current search preferences
router.get('/preferences', async (req, res) => {
  try {
    const prefs = await getSearchPreferences();
    res.json(prefs);
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get search preferences' });
  }
});

export default router;
