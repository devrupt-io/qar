/**
 * Episode Detector Service
 * 
 * Parses torrent names to detect which episodes they contain.
 * Handles various naming conventions:
 * - Complete series: "Show Name Complete" or "Show Name All Seasons"
 * - Season packs: "Show Name S01" or "Show Name Season 1"
 * - Episode ranges: "Show Name S01E01-E10" or "Show Name S01E01-S01E10"
 * - Individual episodes: "Show Name S01E01"
 */

export interface DetectedEpisodes {
  // The type of content detected
  type: 'complete' | 'season' | 'range' | 'episode' | 'unknown';
  
  // For 'complete' type - indicates all seasons/episodes
  isComplete: boolean;
  
  // For 'season' type - the season number(s)
  seasons: number[];
  
  // For 'range' or 'episode' type - specific episodes
  episodes: Array<{ season: number; episode: number }>;
  
  // Human-readable description
  description: string;
  
  // The cleaned show title (without season/episode info)
  cleanTitle: string;
}

// Common patterns for detecting episode information
const PATTERNS = {
  // S01E01 format
  singleEpisode: /S(\d{1,2})E(\d{1,2})/i,
  
  // S01E01-E10 or S01E01-S01E10 format
  episodeRange: /S(\d{1,2})E(\d{1,2})[-–](?:S\d{1,2})?E?(\d{1,2})/i,
  
  // S01 or Season 1 format
  seasonPack: /(?:S(\d{1,2})(?![E\d])|Season[\s.]?(\d{1,2}))/i,
  
  // Multiple seasons: S01-S03 or Seasons 1-3
  seasonRange: /(?:S(\d{1,2})[-–]S(\d{1,2})|Seasons?[\s.]?(\d{1,2})[-–](\d{1,2}))/i,
  
  // Complete series indicators
  complete: /\b(complete|all\s*seasons?|full\s*series|series\s*complete|collection)\b/i,
  
  // 1x01 format
  altEpisodeFormat: /(\d{1,2})x(\d{1,2})/i,
};

export class EpisodeDetector {
  /**
   * Parse a torrent name and detect which episodes it contains.
   */
  detect(torrentName: string): DetectedEpisodes {
    const cleanedName = this.cleanTorrentName(torrentName);
    
    // Check for complete series first
    if (PATTERNS.complete.test(torrentName)) {
      return {
        type: 'complete',
        isComplete: true,
        seasons: [],
        episodes: [],
        description: 'Complete series (all seasons)',
        cleanTitle: cleanedName,
      };
    }
    
    // Check for season range (S01-S03)
    const seasonRangeMatch = torrentName.match(PATTERNS.seasonRange);
    if (seasonRangeMatch) {
      const startSeason = parseInt(seasonRangeMatch[1] || seasonRangeMatch[3], 10);
      const endSeason = parseInt(seasonRangeMatch[2] || seasonRangeMatch[4], 10);
      const seasons = [];
      for (let s = startSeason; s <= endSeason; s++) {
        seasons.push(s);
      }
      return {
        type: 'season',
        isComplete: false,
        seasons,
        episodes: [],
        description: `Seasons ${startSeason}-${endSeason}`,
        cleanTitle: cleanedName,
      };
    }
    
    // Check for episode range (S01E01-E10)
    const episodeRangeMatch = torrentName.match(PATTERNS.episodeRange);
    if (episodeRangeMatch) {
      const season = parseInt(episodeRangeMatch[1], 10);
      const startEp = parseInt(episodeRangeMatch[2], 10);
      const endEp = parseInt(episodeRangeMatch[3], 10);
      const episodes = [];
      for (let e = startEp; e <= endEp; e++) {
        episodes.push({ season, episode: e });
      }
      return {
        type: 'range',
        isComplete: false,
        seasons: [season],
        episodes,
        description: `Season ${season}, Episodes ${startEp}-${endEp}`,
        cleanTitle: cleanedName,
      };
    }
    
    // Check for single episode (S01E01)
    const singleEpMatch = torrentName.match(PATTERNS.singleEpisode);
    if (singleEpMatch) {
      const season = parseInt(singleEpMatch[1], 10);
      const episode = parseInt(singleEpMatch[2], 10);
      return {
        type: 'episode',
        isComplete: false,
        seasons: [season],
        episodes: [{ season, episode }],
        description: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
        cleanTitle: cleanedName,
      };
    }
    
    // Check for alternative format (1x01)
    const altEpMatch = torrentName.match(PATTERNS.altEpisodeFormat);
    if (altEpMatch) {
      const season = parseInt(altEpMatch[1], 10);
      const episode = parseInt(altEpMatch[2], 10);
      return {
        type: 'episode',
        isComplete: false,
        seasons: [season],
        episodes: [{ season, episode }],
        description: `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
        cleanTitle: cleanedName,
      };
    }
    
    // Check for season pack (S01 without episode)
    const seasonMatch = torrentName.match(PATTERNS.seasonPack);
    if (seasonMatch) {
      const season = parseInt(seasonMatch[1] || seasonMatch[2], 10);
      return {
        type: 'season',
        isComplete: false,
        seasons: [season],
        episodes: [],
        description: `Season ${season} (complete)`,
        cleanTitle: cleanedName,
      };
    }
    
    // Unknown format
    return {
      type: 'unknown',
      isComplete: false,
      seasons: [],
      episodes: [],
      description: 'Unknown episode format',
      cleanTitle: cleanedName,
    };
  }
  
  /**
   * Clean the torrent name to extract just the show title.
   */
  private cleanTorrentName(name: string): string {
    // Remove common suffixes and episode info
    let cleaned = name
      // Remove quality indicators
      .replace(/\b(720p|1080p|2160p|4k|hdr|bluray|webrip|webdl|web-dl|hdtv|x264|x265|hevc|aac|ac3|dts)\b/gi, '')
      // Remove season/episode patterns
      .replace(/S\d{1,2}(E\d{1,2})?[-–]?(S\d{1,2})?(E\d{1,2})?/gi, '')
      .replace(/Season[\s.]?\d{1,2}/gi, '')
      .replace(/\d{1,2}x\d{1,2}/gi, '')
      // Remove complete indicators
      .replace(/\b(complete|all\s*seasons?|full\s*series|series\s*complete|collection)\b/gi, '')
      // Remove group names in brackets
      .replace(/\[.*?\]/g, '')
      // Remove file extensions
      .replace(/\.(mkv|mp4|avi|mov)$/i, '')
      // Clean up dots and underscores
      .replace(/[._]/g, ' ')
      // Remove extra whitespace
      .replace(/\s+/g, ' ')
      .trim();
    
    // Remove year if present at the end
    cleaned = cleaned.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    cleaned = cleaned.replace(/\s+\d{4}\s*$/, '').trim();
    
    return cleaned;
  }
  
  /**
   * Check if a torrent name likely matches a show title.
   */
  matchesShow(torrentName: string, showTitle: string): boolean {
    const detected = this.detect(torrentName);
    const normalizedTitle = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTorrent = detected.cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    return normalizedTorrent.includes(normalizedTitle) || 
           normalizedTitle.includes(normalizedTorrent);
  }
}

export const episodeDetector = new EpisodeDetector();
