'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
/* eslint-disable @next/next/no-img-element */
import { Sparkles, RefreshCw, Film, Tv, AlertCircle, Plus, Check, Loader2, X, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';

interface Recommendation {
  title: string;
  year: number;
  type: 'movie' | 'tv';
  reason: string;
}

type AddStatus = 'idle' | 'searching' | 'adding' | 'added' | 'error';
type GenStatus = 'loading' | 'ready' | 'generating' | 'empty' | 'error' | 'not_configured';

const POSTERS_KEY = 'qar_recommendations_posters';

function getCachedPosters(): Record<string, string> {
  try {
    const raw = localStorage.getItem(POSTERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveCachedPosters(posters: Record<string, string>) {
  try {
    localStorage.setItem(POSTERS_KEY, JSON.stringify(posters));
  } catch {}
}

interface Props {
  onLibraryUpdate?: () => void;
}

export default function Recommendations({ onLibraryUpdate }: Props) {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [genStatus, setGenStatus] = useState<GenStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [addStatuses, setAddStatuses] = useState<Record<string, AddStatus>>({});
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissedKeys, setDismissedKeys] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recKey = (rec: Recommendation) => `${rec.title}-${rec.year}`;

  useEffect(() => {
    setPosters(getCachedPosters());
    loadRecommendations();
    loadDismissed();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  const fetchPosters = useCallback(async (recs: Recommendation[]) => {
    const cached = getCachedPosters();
    const missing = recs.filter(r => !cached[recKey(r)]);
    if (missing.length === 0) {
      setPosters(cached);
      return;
    }

    const updated = { ...cached };
    const batches = [];
    for (let i = 0; i < missing.length; i += 5) {
      batches.push(missing.slice(i, i + 5));
    }

    for (const batch of batches) {
      await Promise.all(
        batch.map(async (rec) => {
          try {
            const searchType = rec.type === 'movie' ? 'movie' : 'series';
            const data = await api.searchOmdb(rec.title, searchType);
            const results = data.results || [];
            const match = results.find((r: any) =>
              r.Title?.toLowerCase() === rec.title.toLowerCase() &&
              r.Year?.startsWith(String(rec.year))
            ) || results[0];
            if (match?.Poster && match.Poster !== 'N/A') {
              updated[recKey(rec)] = match.Poster;
            }
          } catch {}
        })
      );
    }

    saveCachedPosters(updated);
    setPosters(updated);
  }, []);

  const loadRecommendations = async (refresh = false) => {
    try {
      setError(null);
      const data = await api.getRecommendations(refresh);

      if (data.status === 'generating') {
        setGenStatus('generating');
        // Poll for results
        pollRef.current = setTimeout(() => loadRecommendations(false), 3000);
        return;
      }

      const recs = data.recommendations || [];
      setRecommendations(recs);
      setGenStatus(recs.length > 0 ? 'ready' : (data.status || 'ready'));
      if (recs.length > 0) fetchPosters(recs);
    } catch (err: any) {
      if (err.message?.includes('not configured')) {
        setGenStatus('not_configured');
      } else {
        setGenStatus('error');
        setError(err.message || 'Failed to load');
      }
    }
  };

  const loadDismissed = async () => {
    try {
      const data = await api.getDismissedRecommendations();
      setDismissedKeys(data.dismissed || []);
    } catch {}
  };

  const handleRefresh = () => {
    setGenStatus('generating');
    loadRecommendations(true);
  };

  const handleAdd = async (rec: Recommendation) => {
    const key = recKey(rec);
    setAddStatuses(prev => ({ ...prev, [key]: 'searching' }));
    setAddErrors(prev => { const n = { ...prev }; delete n[key]; return n; });

    try {
      const searchType = rec.type === 'movie' ? 'movie' : 'series';
      const data = await api.searchOmdb(rec.title, searchType);
      const results = data.results || [];

      const match = results.find((r: any) =>
        r.Title?.toLowerCase() === rec.title.toLowerCase() && r.Year?.startsWith(String(rec.year))
      ) || results.find((r: any) => r.Year?.startsWith(String(rec.year))) || results[0];

      if (!match) {
        setAddStatuses(prev => ({ ...prev, [key]: 'error' }));
        setAddErrors(prev => ({ ...prev, [key]: 'Not found on OMDB' }));
        return;
      }

      setAddStatuses(prev => ({ ...prev, [key]: 'adding' }));

      if (rec.type === 'movie') {
        await api.addMovie({ imdbId: match.imdbID, title: match.Title, year: match.Year });
      } else {
        await api.addTvShowFull({ imdbId: match.imdbID, title: match.Title, year: match.Year });
      }

      setAddStatuses(prev => ({ ...prev, [key]: 'added' }));
      onLibraryUpdate?.();
    } catch (err: any) {
      setAddStatuses(prev => ({ ...prev, [key]: 'error' }));
      setAddErrors(prev => ({ ...prev, [key]: err.message || 'Failed to add' }));
    }
  };

  const handleDismiss = async (rec: Recommendation) => {
    try {
      await api.dismissRecommendation(rec.title, rec.year);
      setRecommendations(prev => prev.filter(r => recKey(r) !== recKey(rec)));
    } catch {}
  };

  const handleRestore = async (key: string) => {
    const parts = key.match(/^(.+)-(\d+)$/);
    if (!parts) return;
    try {
      await api.restoreRecommendation(parts[1], parseInt(parts[2]));
      setDismissedKeys(prev => prev.filter(k => k !== key));
    } catch {}
  };

  const handleRestoreAll = async () => {
    try {
      await api.restoreAllRecommendations();
      setDismissedKeys([]);
      setShowDismissed(false);
      loadRecommendations();
    } catch {}
  };

  if (genStatus === 'loading') {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold">AI Recommendations</h3>
        </div>
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-amber-400"></div>
        </div>
      </div>
    );
  }

  if (genStatus === 'not_configured') return null;

  if (genStatus === 'error') {
    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold">AI Recommendations</h3>
          </div>
          <button onClick={handleRefresh} className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4" />
          {error || 'Failed to load recommendations'}
        </div>
      </div>
    );
  }

  if (genStatus === 'generating') {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold">AI Recommendations</h3>
        </div>
        <div className="flex items-center justify-center gap-3 py-8 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
          <span className="text-sm">Generating recommendations...</span>
        </div>
      </div>
    );
  }

  if (recommendations.length === 0 && genStatus === 'empty') {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold">AI Recommendations</h3>
        </div>
        <p className="text-slate-400 text-sm">
          Add some movies or TV shows to your library to get personalized recommendations.
        </p>
      </div>
    );
  }

  // "ready" with no recommendations and no cache — prompt user to generate
  if (recommendations.length === 0) {
    return (
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold">AI Recommendations</h3>
          </div>
        </div>
        <div className="text-center py-6">
          <p className="text-slate-400 text-sm mb-4">
            Click below to get AI-powered recommendations based on your library.
          </p>
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg font-medium text-sm transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Get Recommendations
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold">AI Recommendations</h3>
          <span className="text-xs text-slate-500">
            ({recommendations.length} suggestions)
          </span>
        </div>
        <div className="flex items-center gap-2">
          {dismissedKeys.length > 0 || showDismissed ? (
            <button
              onClick={() => {
                if (!showDismissed) loadDismissed();
                setShowDismissed(!showDismissed);
              }}
              className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              {showDismissed ? 'Hide dismissed' : 'Manage dismissed'}
            </button>
          ) : null}
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-lg hover:bg-slate-700 transition-colors text-slate-400 hover:text-white"
            title="Get fresh recommendations"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Dismissed management */}
      {showDismissed && (
        <div className="mb-4 p-3 bg-slate-700/30 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-400">Dismissed Recommendations</span>
            {dismissedKeys.length > 0 && (
              <button onClick={handleRestoreAll} className="text-xs text-primary-400 hover:text-primary-300">
                Restore All
              </button>
            )}
          </div>
          {dismissedKeys.length === 0 ? (
            <p className="text-xs text-slate-500">No dismissed recommendations</p>
          ) : (
            <div className="space-y-1">
              {dismissedKeys.map(key => (
                <div key={key} className="flex items-center justify-between text-sm py-1">
                  <span className="text-slate-300">{key.replace(/-(\d+)$/, ' ($1)')}</span>
                  <button
                    onClick={() => handleRestore(key)}
                    className="text-xs text-slate-400 hover:text-white flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recommendation cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {recommendations.map((rec) => {
          const key = recKey(rec);
          const status = addStatuses[key] || 'idle';
          const addError = addErrors[key];
          const busy = status === 'searching' || status === 'adding';
          const posterUrl = posters[key];

          return (
            <div
              key={key}
              className="bg-slate-800 rounded-lg overflow-hidden relative hover:ring-2 hover:ring-amber-500/50 transition-all group"
            >
              {/* Poster */}
              <div className="relative aspect-[2/3] bg-slate-700">
                {posterUrl ? (
                  <img
                    src={posterUrl}
                    alt={rec.title}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    {rec.type === 'movie' ? (
                      <Film className="w-8 h-8 text-slate-500" />
                    ) : (
                      <Tv className="w-8 h-8 text-slate-500" />
                    )}
                  </div>
                )}

                {/* Type badge */}
                <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-medium ${
                  rec.type === 'movie' ? 'bg-blue-600' : 'bg-purple-600'
                }`}>
                  {rec.type === 'movie' ? 'Movie' : 'TV Show'}
                </div>

                {/* Action overlay */}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <button
                    onClick={() => handleAdd(rec)}
                    disabled={busy || status === 'added'}
                    className={`p-2 rounded-full transition-colors ${
                      status === 'added'
                        ? 'bg-green-600 text-white'
                        : status === 'error'
                        ? 'bg-red-600 text-white hover:bg-red-500'
                        : 'bg-primary-600 text-white hover:bg-primary-500'
                    }`}
                    title={status === 'added' ? 'Added' : status === 'error' ? 'Retry' : 'Add to library'}
                  >
                    {busy ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : status === 'added' ? (
                      <Check className="w-5 h-5" />
                    ) : (
                      <Plus className="w-5 h-5" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDismiss(rec)}
                    className="p-2 rounded-full bg-slate-600 text-white hover:bg-red-600 transition-colors"
                    title="Not interested"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Info */}
              <div className="p-3">
                <h3 className="font-medium text-sm">{rec.title} ({rec.year})</h3>
                <p className="text-xs text-slate-400 mt-1">{rec.reason}</p>
                {addError && <p className="text-xs text-red-400 mt-1">{addError}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
