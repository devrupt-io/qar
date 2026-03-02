'use client';

import { useState, useEffect } from 'react';
import { Search, Download, Loader2, AlertTriangle, Settings2, Wifi, WifiOff, Monitor, Film, Zap } from 'lucide-react';
import { api } from '@/lib/api';

// Common video codec options
const VIDEO_CODECS = ['', 'any', 'x264', 'x265', 'HEVC', 'AV1', 'VP9'];
// Common video resolution options  
const VIDEO_RESOLUTIONS = ['', 'any', '480p', '720p', '1080p', '2160p', '4K'];
// Common torrent release groups for movies
const MOVIE_GROUPS = ['', 'yify', 'yts', 'sparks', 'rarbg', 'ganool', 'ettv'];

interface QualityInfo {
  resolution?: string;
  codec?: string;
  source?: string;
  audio?: string;
  releaseGroup?: string;
  hdr?: boolean;
  isCam?: boolean;
}

interface TorrentResult {
  name: string;
  magnetUri: string | null;
  detailsUrl: string;
  seeders: number;
  leechers: number;
  size: string;
  uploadDate: string;
  uploader: string;
  quality?: QualityInfo;
}

interface DetectedEpisodes {
  type: string;
  isComplete: boolean;
  seasons: number[];
  episodes: Array<{ season: number; episode: number }>;
  description: string;
  missingEpisodes?: number;
  missingSeasons?: number[];
  validationMessage?: string;
}

interface Props {
  title: string;
  year: string;
  type: string;
  season?: number;
  episode?: number;
  // Default search mode - when opening from TV show page vs episode page
  defaultSearchMode?: 'complete' | 'season' | 'episode';
  // Total seasons info for validation
  totalSeasons?: number;
  // Episodes per season for validation
  episodesPerSeason?: Record<number, number>;
  onSelect: (magnetUri: string, detected?: DetectedEpisodes) => void;
}

export default function TorrentSearch({ 
  title, 
  year, 
  type, 
  season, 
  episode, 
  defaultSearchMode,
  totalSeasons,
  episodesPerSeason,
  onSelect 
}: Props) {
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [customQuery, setCustomQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'complete' | 'season' | 'episode'>(
    defaultSearchMode || (type === 'series' && season && episode ? 'episode' : 'complete')
  );
  const [selectedSeason, setSelectedSeason] = useState<number>(season || 1);
  const [detectedEpisodes, setDetectedEpisodes] = useState<Record<string, DetectedEpisodes>>({});
  
  // Search preference overrides
  const [showOverrides, setShowOverrides] = useState(false);
  const [overrideCodec, setOverrideCodec] = useState<string>('');
  const [overrideResolution, setOverrideResolution] = useState<string>('');
  const [overrideGroup, setOverrideGroup] = useState<string>('');
  
  // Search metadata
  const [actualSearchQuery, setActualSearchQuery] = useState<string>('');
  const [searchWarnings, setSearchWarnings] = useState<string[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [torHealthy, setTorHealthy] = useState<boolean>(true);
  
  // Magnet fetching state
  const [fetchingMagnet, setFetchingMagnet] = useState<string | null>(null);

  // Manual magnet/hash input
  const [manualMagnet, setManualMagnet] = useState('');

  // Update search mode when defaultSearchMode changes
  useEffect(() => {
    if (defaultSearchMode) {
      setSearchMode(defaultSearchMode);
    }
  }, [defaultSearchMode]);

  // Update selected season when prop changes
  useEffect(() => {
    if (season) {
      setSelectedSeason(season);
    }
  }, [season]);

  // Auto-search for movies on mount
  useEffect(() => {
    if (type === 'movie' && !searched) {
      handleSearch();
    }
  }, []);

  const getDefaultQuery = () => {
    if (type === 'movie') {
      return `${title} ${year}`;
    }
    
    switch (searchMode) {
      case 'episode':
        if (season && episode) {
          return `${title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        }
        return title;
      case 'season':
        return `${title} S${String(selectedSeason).padStart(2, '0')}`;
      case 'complete':
      default:
        return `${title} complete`;
    }
  };

  const handleSearch = async (query?: string) => {
    const searchQuery = query || customQuery || getDefaultQuery();
    setLoading(true);
    setSearched(true);
    setSearchError(null);
    setSearchWarnings([]);
    
    try {
      // For TV shows, use the improved TV torrent search
      if (type === 'series' && !query && !customQuery) {
        const data = await api.searchTvTorrents(
          title, 
          searchMode,
          searchMode === 'season' ? selectedSeason : season,
          episode
        );
        setResults(data.results || []);
        setActualSearchQuery(data.searchQuery || searchQuery);
        setSearchWarnings(data.warnings || []);
        setTorHealthy(data.torHealthy !== false);
        if (data.error) setSearchError(data.error);
        
        // Detect episodes for each result
        const detections: Record<string, DetectedEpisodes> = {};
        for (const result of (data.results || []).slice(0, 10)) {
          try {
            const detected = await api.detectEpisodes(result.name, title, {
              expectedType: searchMode,
              expectedSeason: searchMode === 'season' ? selectedSeason : season,
              expectedEpisode: episode,
              totalSeasons,
              episodesPerSeason,
            });
            detections[result.name] = detected;
          } catch (e) {
            // Ignore detection errors
          }
        }
        setDetectedEpisodes(detections);
      } else {
        // For movies or custom queries, use the regular search with preferences and overrides
        const overrides = showOverrides ? {
          codec: overrideCodec || undefined,
          resolution: overrideResolution || undefined,
          group: overrideGroup || undefined,
        } : undefined;
        
        const data = await api.searchTorrents(searchQuery, type === 'movie' ? 'Movies' : 'TV', true, overrides);
        setResults(data.results || []);
        setActualSearchQuery(data.searchQuery || searchQuery);
        setSearchWarnings(data.warnings || []);
        setTorHealthy(data.torHealthy !== false);
        if (data.error) setSearchError(data.error);
      }
    } catch (error) {
      console.error('Torrent search failed:', error);
      setResults([]);
      setSearchError('Search request failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async (torrent: TorrentResult) => {
    // If magnet is already available, use it directly
    if (torrent.magnetUri) {
      const detected = detectedEpisodes[torrent.name];
      onSelect(torrent.magnetUri, detected);
      return;
    }
    
    // Fetch magnet URI on demand
    setFetchingMagnet(torrent.detailsUrl);
    try {
      const data = await api.fetchMagnetUri(torrent.detailsUrl);
      if (data.magnetUri) {
        const detected = detectedEpisodes[torrent.name];
        onSelect(data.magnetUri, detected);
      } else {
        setSearchError('Failed to fetch magnet link');
      }
    } catch (error) {
      console.error('Failed to fetch magnet:', error);
      setSearchError('Failed to fetch magnet link - try again');
    } finally {
      setFetchingMagnet(null);
    }
  };

  // Get quality badge color based on resolution
  const getResolutionColor = (resolution?: string) => {
    switch (resolution) {
      case '2160p': return 'bg-purple-600';
      case '1080p': return 'bg-blue-600';
      case '720p': return 'bg-green-600';
      case '480p': return 'bg-yellow-600';
      default: return 'bg-slate-600';
    }
  };

  // Get source badge color
  const getSourceColor = (source?: string) => {
    switch (source) {
      case 'bluray':
      case 'remux': return 'bg-purple-500';
      case 'web-dl': return 'bg-blue-500';
      case 'webrip': return 'bg-cyan-500';
      case 'hdtv': return 'bg-green-500';
      case 'cam':
      case 'telesync':
      case 'screener': return 'bg-red-500';
      default: return 'bg-slate-500';
    }
  };

  // Generate season options
  const seasonOptions = [];
  const maxSeasons = totalSeasons || 10;
  for (let i = 1; i <= maxSeasons; i++) {
    seasonOptions.push(i);
  }

  return (
    <div className="space-y-4">
      {/* Search Mode for TV Shows */}
      {type === 'series' && (
        <div>
          <label className="block text-sm font-medium mb-2 text-slate-400">Search Type</label>
          <div className="flex gap-2 flex-wrap">
            <button
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                searchMode === 'complete' 
                  ? 'bg-primary-600 text-white' 
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
              }`}
              onClick={() => setSearchMode('complete')}
            >
              Complete Series
            </button>
            <button
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                searchMode === 'season' 
                  ? 'bg-primary-600 text-white' 
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
              }`}
              onClick={() => setSearchMode('season')}
            >
              Season Pack
            </button>
            <button
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                searchMode === 'episode' 
                  ? 'bg-primary-600 text-white' 
                  : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
              }`}
              onClick={() => setSearchMode('episode')}
            >
              Single Episode
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {searchMode === 'complete' && 'Search for the entire series in one download'}
            {searchMode === 'season' && 'Search for a complete season pack'}
            {searchMode === 'episode' && 'Search for a specific episode'}
          </p>
        </div>
      )}

      {/* Season Selector for Season Pack mode */}
      {type === 'series' && searchMode === 'season' && (
        <div>
          <label className="block text-sm font-medium mb-2 text-slate-400">Season</label>
          <select
            value={selectedSeason}
            onChange={(e) => setSelectedSeason(parseInt(e.target.value, 10))}
            className="input w-32"
          >
            {seasonOptions.map((s) => (
              <option key={s} value={s}>
                Season {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Season/Episode Display for Single Episode mode */}
      {type === 'series' && searchMode === 'episode' && season && episode && (
        <div className="bg-slate-700/50 rounded-lg p-3">
          <div className="flex items-center gap-2 text-slate-300">
            <span className="text-slate-400">Searching for:</span>
            <span className="font-semibold text-primary-400">
              S{String(season).padStart(2, '0')}E{String(episode).padStart(2, '0')}
            </span>
          </div>
        </div>
      )}

      {/* Search Preference Overrides */}
      <div className="border border-slate-600 rounded-lg overflow-hidden">
        <button
          className="w-full flex items-center justify-between p-3 bg-slate-700/50 hover:bg-slate-700 transition-colors"
          onClick={() => setShowOverrides(!showOverrides)}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Settings2 className="w-4 h-4" />
            Search Options
          </span>
          <span className="text-xs text-slate-400">
            {showOverrides ? '▲ Hide' : '▼ Show'}
          </span>
        </button>
        
        {showOverrides && (
          <div className="p-3 bg-slate-800/50 space-y-3 border-t border-slate-600">
            <p className="text-xs text-slate-400">
              Override your default search preferences for this search. Leave blank to use defaults.
            </p>
            
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1 text-slate-400">Resolution</label>
                <select
                  className="input text-sm py-1.5"
                  value={overrideResolution}
                  onChange={(e) => setOverrideResolution(e.target.value)}
                >
                  <option value="">Default</option>
                  {VIDEO_RESOLUTIONS.filter(r => r).map(res => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>
              </div>
              
              <div>
                <label className="block text-xs font-medium mb-1 text-slate-400">Codec</label>
                <select
                  className="input text-sm py-1.5"
                  value={overrideCodec}
                  onChange={(e) => setOverrideCodec(e.target.value)}
                >
                  <option value="">Default</option>
                  {VIDEO_CODECS.filter(c => c).map(codec => (
                    <option key={codec} value={codec}>{codec}</option>
                  ))}
                </select>
              </div>
              
              {type === 'movie' && (
                <div>
                  <label className="block text-xs font-medium mb-1 text-slate-400">Release Group</label>
                  <select
                    className="input text-sm py-1.5"
                    value={overrideGroup}
                    onChange={(e) => setOverrideGroup(e.target.value)}
                  >
                    <option value="">Default</option>
                    <option value="none">None (disable)</option>
                    {MOVIE_GROUPS.filter(g => g).map(group => (
                      <option key={group} value={group}>{group.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Search Form */}
      <div className="flex gap-2">
        <input
          type="text"
          className="input flex-1"
          placeholder={getDefaultQuery()}
          value={customQuery}
          onChange={(e) => setCustomQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button
          className="btn-primary flex items-center gap-2"
          onClick={() => handleSearch()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Search className="w-5 h-5" />
          )}
          Search
        </button>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
        </div>
      ) : searched ? (
        <>
          {/* Search Info Bar */}
          <div className="flex items-center justify-between text-xs text-slate-400 px-1">
            <div className="flex items-center gap-2">
              {torHealthy ? (
                <span title="Tor connected"><Wifi className="w-3 h-3 text-green-400" /></span>
              ) : (
                <span title="Tor unavailable"><WifiOff className="w-3 h-3 text-red-400" /></span>
              )}
              <span>Searched: <span className="text-slate-300 font-mono">{actualSearchQuery}</span></span>
            </div>
            <span>{results.length} results</span>
          </div>
          
          {/* Warnings */}
          {searchWarnings.length > 0 && (
            <div className="bg-yellow-900/30 border border-yellow-600/50 rounded-lg p-2">
              {searchWarnings.map((warning, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-yellow-400">
                  <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}
          
          {/* Error */}
          {searchError && results.length === 0 && (
            <div className="bg-red-900/30 border border-red-600/50 rounded-lg p-3">
              <div className="flex items-center gap-2 text-sm text-red-400">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span>{searchError}</span>
              </div>
            </div>
          )}
          
          {results.length === 0 && !searchError ? (
            <p className="text-center text-slate-400 py-4">No torrents found</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {results.map((torrent, index) => {
                const detected = detectedEpisodes[torrent.name];
                const hasWarning = detected?.missingEpisodes && detected.missingEpisodes > 0;
                const quality = torrent.quality;
                const isFetching = fetchingMagnet === torrent.detailsUrl;
                
                return (
                  <div
                    key={index}
                    className={`p-3 bg-slate-700/50 rounded-lg hover:bg-slate-700 transition-colors ${
                      quality?.isCam ? 'border border-red-500/50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" title={torrent.name}>{torrent.name}</p>
                        
                        {/* Quality badges row */}
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {/* Resolution */}
                          {quality?.resolution && (
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${getResolutionColor(quality.resolution)}`}>
                              <Monitor className="w-3 h-3" />
                              {quality.resolution}
                            </span>
                          )}
                          
                          {/* Source */}
                          {quality?.source && (
                            <span className={`px-1.5 py-0.5 rounded text-xs ${getSourceColor(quality.source)}`}>
                              {quality.source.toUpperCase()}
                            </span>
                          )}
                          
                          {/* Codec */}
                          {quality?.codec && (
                            <span className="px-1.5 py-0.5 rounded text-xs bg-slate-600">
                              {quality.codec}
                            </span>
                          )}
                          
                          {/* HDR */}
                          {quality?.hdr && (
                            <span className="px-1.5 py-0.5 rounded text-xs bg-amber-600 font-medium">
                              HDR
                            </span>
                          )}
                          
                          {/* Release Group */}
                          {quality?.releaseGroup && (
                            <span className="px-1.5 py-0.5 rounded text-xs bg-indigo-600">
                              {quality.releaseGroup.toUpperCase()}
                            </span>
                          )}
                          
                          {/* CAM Warning */}
                          {quality?.isCam && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-red-600 font-medium">
                              <AlertTriangle className="w-3 h-3" />
                              LOW QUALITY
                            </span>
                          )}
                        </div>
                        
                        {/* Stats row */}
                        <div className="flex items-center gap-3 text-xs text-slate-400 mt-1.5">
                          <span>{torrent.size}</span>
                          <span className="text-green-400">↑{torrent.seeders}</span>
                          <span className="text-red-400">↓{torrent.leechers}</span>
                        </div>
                        
                        {/* Show detected episode info for TV shows */}
                        {detected && type === 'series' && (
                          <div className="mt-2 flex items-center gap-2 flex-wrap">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                              detected.type === 'complete' ? 'bg-purple-600' :
                              detected.type === 'season' ? 'bg-blue-600' :
                              detected.type === 'episode' ? 'bg-green-600' : 'bg-slate-600'
                            }`}>
                              {detected.description || detected.type}
                            </span>
                            {hasWarning && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-yellow-600">
                                <AlertTriangle className="w-3 h-3" />
                                {detected.validationMessage || `${detected.missingEpisodes} episodes may be missing`}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      
                      <button
                        className="btn-primary flex items-center gap-1 text-sm py-1.5 px-3 flex-shrink-0"
                        onClick={() => handleSelect(torrent)}
                        disabled={isFetching}
                      >
                        {isFetching ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4" />
                        )}
                        {isFetching ? 'Loading...' : 'Download'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <p className="text-center text-slate-400 py-4">
          Click search to find available torrents
        </p>
      )}

      {/* Manual Magnet/Hash Input */}
      <div className="mt-6 pt-4 border-t border-slate-700">
        <p className="text-sm text-slate-400 mb-2">Or add a magnet link or torrent hash manually:</p>
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1 text-sm"
            placeholder="magnet:?xt=urn:btih:... or info hash"
            value={manualMagnet}
            onChange={(e) => setManualMagnet(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manualMagnet.trim()) {
                const value = manualMagnet.trim();
                const magnetUri = value.startsWith('magnet:') ? value : `magnet:?xt=urn:btih:${value}`;
                onSelect(magnetUri);
                setManualMagnet('');
              }
            }}
          />
          <button
            className="btn-primary text-sm flex items-center gap-1.5 flex-shrink-0"
            disabled={!manualMagnet.trim()}
            onClick={() => {
              const value = manualMagnet.trim();
              if (!value) return;
              const magnetUri = value.startsWith('magnet:') ? value : `magnet:?xt=urn:btih:${value}`;
              onSelect(magnetUri);
              setManualMagnet('');
            }}
          >
            <Download className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
