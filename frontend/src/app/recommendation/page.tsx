'use client';

/* eslint-disable @next/next/no-img-element */
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { 
  Film, 
  Tv, 
  Plus, 
  Check, 
  Loader2, 
  X, 
  ArrowLeft,
  Sparkles
} from 'lucide-react';

type AddStatus = 'idle' | 'searching' | 'adding' | 'added' | 'error';

const POSTERS_KEY = 'qar_recommendations_posters';

function getCachedPosters(): Record<string, string> {
  try {
    const raw = localStorage.getItem(POSTERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function RecommendationDetail() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const title = searchParams.get('title') || '';
  const year = parseInt(searchParams.get('year') || '0');
  const type = (searchParams.get('type') || 'movie') as 'movie' | 'tv';
  const reason = searchParams.get('reason') || '';
  const key = `${title}-${year}`;

  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<AddStatus>('idle');
  const [addError, setAddError] = useState<string | null>(null);
  const busy = status === 'searching' || status === 'adding';

  useEffect(() => {
    const cached = getCachedPosters();
    if (cached[key]) {
      setPosterUrl(cached[key]);
    } else {
      // Try to fetch poster
      api.searchOmdb(title, type === 'movie' ? 'movie' : 'series')
        .then(data => {
          const results = data.results || [];
          const match = results.find((r: any) => r.Poster && r.Poster !== 'N/A');
          if (match?.Poster) {
            setPosterUrl(match.Poster);
          }
        })
        .catch(() => {});
    }
  }, [title, type, key]);

  const handleAdd = async () => {
    setStatus('searching');
    setAddError(null);

    try {
      const searchType = type === 'movie' ? 'movie' : 'series';
      const data = await api.searchOmdb(title, searchType);
      const results = data.results || [];

      const match = results.find((r: any) =>
        r.Title?.toLowerCase() === title.toLowerCase() && r.Year?.startsWith(String(year))
      ) || results.find((r: any) => r.Year?.startsWith(String(year))) || results[0];

      if (!match) {
        setStatus('error');
        setAddError('Not found on OMDB');
        return;
      }

      setStatus('adding');

      if (type === 'movie') {
        await api.addMovie({ imdbId: match.imdbID, title: match.Title, year: match.Year });
      } else {
        await api.addTvShowFull({ imdbId: match.imdbID, title: match.Title, year: match.Year });
      }

      setStatus('added');
    } catch (err: any) {
      setStatus('error');
      setAddError(err.message || 'Failed to add');
    }
  };

  const handleDismiss = async () => {
    try {
      await api.dismissRecommendation(title, year);
      router.back();
    } catch {}
  };

  if (!title) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-400">
        <p>No recommendation data provided.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-slate-900/90 backdrop-blur-sm border-b border-slate-800">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="p-2 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span className="text-sm text-slate-400">AI Recommendation</span>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto">
        {/* Poster - large, full width */}
        <div className="relative bg-slate-800 flex items-center justify-center">
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={title}
              className="w-full max-h-[70vh] object-contain"
            />
          ) : (
            <div className="flex items-center justify-center py-32">
              {type === 'movie' ? (
                <Film className="w-20 h-20 text-slate-600" />
              ) : (
                <Tv className="w-20 h-20 text-slate-600" />
              )}
            </div>
          )}
          <div className={`absolute top-4 left-4 px-3 py-1 rounded-lg text-sm font-medium ${
            type === 'movie' ? 'bg-blue-600' : 'bg-purple-600'
          }`}>
            {type === 'movie' ? 'Movie' : 'TV Show'}
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-6 space-y-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">{title}</h1>
            <p className="text-lg text-slate-400 mt-1">{year}</p>
          </div>

          <div className="bg-slate-800/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-amber-400">Why we recommend this</span>
            </div>
            <p className="text-slate-300 leading-relaxed">{reason}</p>
          </div>

          {addError && (
            <div className="bg-red-900/30 border border-red-600/50 rounded-lg p-3 text-sm text-red-400">
              {addError}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-3 pt-2">
            <button
              onClick={handleAdd}
              disabled={busy || status === 'added'}
              className={`w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-semibold text-lg transition-colors ${
                status === 'added'
                  ? 'bg-green-600 text-white'
                  : status === 'error'
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-primary-600 hover:bg-primary-700 text-white'
              }`}
            >
              {busy ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : status === 'added' ? (
                <Check className="w-6 h-6" />
              ) : (
                <Plus className="w-6 h-6" />
              )}
              {status === 'added' ? 'Added to Library' : status === 'searching' ? 'Searching...' : status === 'adding' ? 'Adding...' : status === 'error' ? 'Retry' : 'Add to Library'}
            </button>
            <button
              onClick={handleDismiss}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 bg-slate-700 hover:bg-red-600 rounded-xl font-semibold text-lg transition-colors"
            >
              <X className="w-6 h-6" />
              Not Interested
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RecommendationPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-400"></div>
      </div>
    }>
      <RecommendationDetail />
    </Suspense>
  );
}
