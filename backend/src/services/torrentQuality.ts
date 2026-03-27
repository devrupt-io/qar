/**
 * Torrent Quality Parsing Service
 * 
 * Parses torrent names to extract quality metadata including:
 * - Resolution (480p, 720p, 1080p, 2160p/4K)
 * - Codec (x264, x265/HEVC, AV1, VP9)
 * - Release group
 * - Source (BluRay, WEB-DL, HDTV, etc.)
 * - Audio format
 */

export interface QualityInfo {
  resolution?: string;       // '480p', '720p', '1080p', '2160p', '4k'
  codec?: string;            // 'x264', 'x265', 'hevc', 'av1', 'vp9'
  source?: string;           // 'bluray', 'web-dl', 'webrip', 'hdtv', 'dvdrip', 'cam'
  audio?: string;            // 'aac', 'dts', 'atmos', 'truehd', 'ac3', 'flac'
  releaseGroup?: string;     // 'yify', 'rarbg', 'sparks', etc.
  hdr?: boolean;             // HDR content
  proper?: boolean;          // PROPER release
  repack?: boolean;          // REPACK release
  remux?: boolean;           // REMUX (full quality)
  isCam?: boolean;           // CAM/Screener (low quality)
}

// Resolution patterns
const RESOLUTION_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(2160p|4k|uhd)\b/i, value: '2160p' },
  { pattern: /\b1080p\b/i, value: '1080p' },
  { pattern: /\b720p\b/i, value: '720p' },
  { pattern: /\b480p\b/i, value: '480p' },
  { pattern: /\b576p\b/i, value: '576p' },
  { pattern: /\b360p\b/i, value: '360p' },
];

// Codec patterns
const CODEC_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\b(x265|h\.?265|hevc)\b/i, value: 'x265' },
  { pattern: /\b(x264|h\.?264|avc)\b/i, value: 'x264' },
  { pattern: /\bav1\b/i, value: 'av1' },
  { pattern: /\bvp9\b/i, value: 'vp9' },
  { pattern: /\bxvid\b/i, value: 'xvid' },
  { pattern: /\bdivx\b/i, value: 'divx' },
];

// Source patterns (ordered by quality)
const SOURCE_PATTERNS: Array<{ pattern: RegExp; value: string; quality: number }> = [
  { pattern: /\bremux\b/i, value: 'remux', quality: 10 },
  { pattern: /\b(blu-?ray|bdrip|brrip)\b/i, value: 'bluray', quality: 9 },
  { pattern: /\bweb-?dl\b/i, value: 'web-dl', quality: 8 },
  { pattern: /\bwebrip\b/i, value: 'webrip', quality: 7 },
  { pattern: /\b(hdtv|pdtv)\b/i, value: 'hdtv', quality: 6 },
  { pattern: /\bdvdrip\b/i, value: 'dvdrip', quality: 5 },
  { pattern: /\bdvdscr\b/i, value: 'dvdscr', quality: 3 },
  { pattern: /\bscreener\b/i, value: 'screener', quality: 2 },
  { pattern: /\b(ts|telesync|hdts)\b/i, value: 'telesync', quality: 1 },
  { pattern: /\b(cam|camrip|hdcam)\b/i, value: 'cam', quality: 0 },
];

// Audio patterns
const AUDIO_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\batmos\b/i, value: 'atmos' },
  { pattern: /\btruehd\b/i, value: 'truehd' },
  { pattern: /\bdts-?(hd|ma|x)?\b/i, value: 'dts' },
  { pattern: /\b(dd|dolby)[\s+]?5\.?1\b/i, value: 'dd5.1' },
  { pattern: /\bac3\b/i, value: 'ac3' },
  { pattern: /\baac\b/i, value: 'aac' },
  { pattern: /\bflac\b/i, value: 'flac' },
  { pattern: /\bmp3\b/i, value: 'mp3' },
];

// Known release groups
const RELEASE_GROUPS = [
  'yify', 'yts', 'rarbg', 'ettv', 'eztv', 'sparks', 'geckos',
  'ntb', 'fleet', 'megusta', 'mixed', 'tigole', 'qxr', 'ion10',
  'amzn', 'amiable', 'ntg', 'cmrg', 'epsilon', 'stuttershit',
  'mkvking', 'galaxyrg', 'hone', 'bae', 'monkee', 'rocketfromsky',
  'sva', 'ntvg', 'memento', 'playnow', 'gossip', 'lol', 'dimension',
  'killers', 'fov', 'mtb', 'deflate', 'bamboozle', 'alt', 'tommy',
  'nogrp', 'cakes', 'welp', 'tepes', 'ggez', 'ggwp', 'flux',
];

/**
 * Parse a torrent name to extract quality metadata
 */
export function parseQuality(name: string): QualityInfo {
  const result: QualityInfo = {};
  const nameLower = name.toLowerCase();

  // Extract resolution
  for (const { pattern, value } of RESOLUTION_PATTERNS) {
    if (pattern.test(name)) {
      result.resolution = value;
      break;
    }
  }

  // Extract codec
  for (const { pattern, value } of CODEC_PATTERNS) {
    if (pattern.test(name)) {
      result.codec = value;
      break;
    }
  }

  // Extract source
  for (const { pattern, value } of SOURCE_PATTERNS) {
    if (pattern.test(name)) {
      result.source = value;
      result.isCam = value === 'cam' || value === 'telesync' || value === 'screener' || value === 'dvdscr';
      break;
    }
  }

  // Extract audio
  for (const { pattern, value } of AUDIO_PATTERNS) {
    if (pattern.test(name)) {
      result.audio = value;
      break;
    }
  }

  // Check for HDR
  result.hdr = /\b(hdr10?\+?|dolby\s*vision|dv)\b/i.test(name);

  // Check for PROPER/REPACK
  result.proper = /\bproper\b/i.test(name);
  result.repack = /\brepack\b/i.test(name);

  // Check for REMUX
  result.remux = /\bremux\b/i.test(name);

  // Extract release group
  // Usually at the end after a dash, or in brackets
  const groupMatch = name.match(/[-\[]([a-z0-9]+)\]?$/i);
  if (groupMatch) {
    const possibleGroup = groupMatch[1].toLowerCase();
    if (RELEASE_GROUPS.includes(possibleGroup)) {
      result.releaseGroup = possibleGroup;
    }
  }
  
  // If no group found at end, search anywhere in the name
  if (!result.releaseGroup) {
    for (const group of RELEASE_GROUPS) {
      if (nameLower.includes(group)) {
        result.releaseGroup = group;
        break;
      }
    }
  }

  return result;
}

/**
 * Calculate a quality score for ranking torrents
 * Higher score = better match based on user preferences
 * Supports multiple preferred values (arrays) for resolution, codec, and group
 */
export function calculateQualityScore(
  quality: QualityInfo,
  preferences: {
    preferredResolution?: string;
    preferredResolutions?: string[];
    preferredCodec?: string;
    preferredCodecs?: string[];
    preferredGroup?: string;
    preferredGroups?: string[];
  }
): number {
  let score = 0;

  // Normalize preferences to arrays for consistent handling
  const prefResolutions = preferences.preferredResolutions || 
    (preferences.preferredResolution ? [preferences.preferredResolution] : []);
  const prefCodecs = preferences.preferredCodecs || 
    (preferences.preferredCodec ? [preferences.preferredCodec] : []);
  const prefGroups = preferences.preferredGroups || 
    (preferences.preferredGroup ? [preferences.preferredGroup] : []);

  // Resolution scoring
  const resolutionScores: Record<string, number> = {
    '2160p': 100,
    '1080p': 80,
    '720p': 60,
    '576p': 40,
    '480p': 30,
    '360p': 10,
  };

  if (quality.resolution) {
    // Base score for having a known resolution
    score += resolutionScores[quality.resolution] || 0;

    // Bonus for matching any preferred resolution
    const normalizedQualityRes = quality.resolution;
    const matchesResolution = prefResolutions.some(pref => 
      normalizedQualityRes === normalizeResolution(pref)
    );
    if (matchesResolution) {
      score += 50;
    }
  }

  // Codec scoring
  const codecScores: Record<string, number> = {
    'x265': 30, // More efficient compression
    'x264': 25, // Wide compatibility
    'av1': 28,  // Newer, efficient
    'vp9': 20,
    'xvid': 5,
    'divx': 5,
  };

  if (quality.codec) {
    score += codecScores[quality.codec] || 0;

    // Bonus for matching any preferred codec
    const normalizedQualityCodec = quality.codec;
    const matchesCodec = prefCodecs.some(pref => 
      normalizedQualityCodec === normalizeCodec(pref)
    );
    if (matchesCodec) {
      score += 40;
    }
  }

  // Source scoring
  const sourceScores: Record<string, number> = {
    'remux': 50,
    'bluray': 45,
    'web-dl': 40,
    'webrip': 35,
    'hdtv': 30,
    'dvdrip': 20,
    'dvdscr': 5,
    'screener': 2,
    'telesync': 1,
    'cam': 0,
  };

  if (quality.source) {
    score += sourceScores[quality.source] || 0;
  }

  // Penalty for CAM/screener quality
  if (quality.isCam) {
    score -= 100;
  }

  // Bonus for HDR
  if (quality.hdr) {
    score += 10;
  }

  // Bonus for PROPER/REPACK
  if (quality.proper || quality.repack) {
    score += 5;
  }

  // Bonus for matching release group - strongest preference signal since
  // users explicitly choose their preferred release group
  if (quality.releaseGroup && prefGroups.length > 0) {
    const matchesGroup = prefGroups.some(pref => 
      quality.releaseGroup === pref.toLowerCase()
    );
    if (matchesGroup) {
      score += 80;
    }
  }

  return score;
}

/**
 * Normalize resolution string to match our format
 */
function normalizeResolution(resolution: string): string {
  const normalized = resolution.toLowerCase().trim();
  if (normalized === '4k' || normalized === 'uhd' || normalized === '2160p') {
    return '2160p';
  }
  if (normalized.match(/^\d+p$/)) {
    return normalized;
  }
  return normalized + 'p';
}

/**
 * Normalize codec string to match our format
 */
function normalizeCodec(codec: string): string {
  const normalized = codec.toLowerCase().trim();
  if (normalized === 'hevc' || normalized === 'h265' || normalized === 'h.265') {
    return 'x265';
  }
  if (normalized === 'avc' || normalized === 'h264' || normalized === 'h.264') {
    return 'x264';
  }
  return normalized;
}

/**
 * Check if a torrent should be avoided (low quality sources)
 */
export function shouldAvoidTorrent(quality: QualityInfo): boolean {
  return quality.isCam === true;
}

/**
 * Get a human-readable quality summary
 */
export function getQualitySummary(quality: QualityInfo): string {
  const parts: string[] = [];
  
  if (quality.resolution) parts.push(quality.resolution.toUpperCase());
  if (quality.codec) parts.push(quality.codec.toUpperCase());
  if (quality.source) parts.push(quality.source.toUpperCase());
  if (quality.hdr) parts.push('HDR');
  if (quality.releaseGroup) parts.push(`[${quality.releaseGroup.toUpperCase()}]`);
  
  return parts.join(' ') || 'Unknown Quality';
}
