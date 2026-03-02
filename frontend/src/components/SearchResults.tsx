'use client';

import { useState } from 'react';
/* eslint-disable @next/next/no-img-element */
import { Plus, X, Film, Tv, Loader2, Check } from 'lucide-react';
import { api } from '@/lib/api';
import TorrentSearch from './TorrentSearch';

interface SearchResult {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

interface Props {
  results: SearchResult[];
  loading: boolean;
  onClear: () => void;
}

export default function SearchResults({ results, loading, onClear }: Props) {
  const [selectedItem, setSelectedItem] = useState<SearchResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [addResult, setAddResult] = useState<{ success: boolean; message: string } | null>(null);
  const [failedPosters, setFailedPosters] = useState<Set<string>>(new Set());

  const handleAdd = async (item: SearchResult, magnetUri?: string) => {
    setAdding(true);
    setAddResult(null);
    
    try {
      if (item.Type === 'movie') {
        await api.addMovie({
          imdbId: item.imdbID,
          title: item.Title,
          year: item.Year,
          magnetUri,
        });
        setAddResult({ success: true, message: 'Movie added to library!' });
      } else {
        // Add entire TV show (all seasons and episodes)
        const result = await api.addTvShowFull({
          imdbId: item.imdbID,
          title: item.Title,
          year: item.Year,
        });
        setAddResult({ 
          success: true, 
          message: `Added ${result.episodesAdded} episodes across ${result.totalSeasons} seasons!` 
        });
      }
      
      setAdded(prev => new Set(prev).add(item.imdbID));
    } catch (error) {
      console.error('Failed to add item:', error);
      setAddResult({ success: false, message: 'Failed to add to library' });
    } finally {
      setAdding(false);
    }
  };

  const handleClose = () => {
    setSelectedItem(null);
    setAddResult(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400">
        <p>No results found. Try a different search term.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-slate-400">{results.length} results found</p>
        <button onClick={onClear} className="text-slate-400 hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {results.map(item => (
          <div
            key={item.imdbID}
            className="bg-slate-800 rounded-lg overflow-hidden group cursor-pointer"
            onClick={() => setSelectedItem(item)}
          >
            {/* Poster */}
            <div className="relative aspect-[2/3] bg-slate-700">
              {item.Poster && item.Poster !== 'N/A' && !failedPosters.has(item.imdbID) ? (
                <img
                  src={item.Poster}
                  alt={item.Title}
                  className="absolute inset-0 w-full h-full object-cover"
                  onError={() => setFailedPosters(prev => new Set(prev).add(item.imdbID))}
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  {item.Type === 'movie' ? (
                    <Film className="w-12 h-12 text-slate-500" />
                  ) : (
                    <Tv className="w-12 h-12 text-slate-500" />
                  )}
                </div>
              )}
              
              {/* Overlay */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                {added.has(item.imdbID) ? (
                  <div className="flex items-center gap-2 text-green-400">
                    <Check className="w-6 h-6" />
                    <span>Added</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-white">
                    <Plus className="w-6 h-6" />
                    <span>Add</span>
                  </div>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="p-3">
              <h3 className="font-medium text-sm line-clamp-2">{item.Title}</h3>
              <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                <span>{item.Year}</span>
                <span className="capitalize">{item.Type}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Modal */}
      {selectedItem && (
        <div className="fixed inset-0 bg-black/80 flex items-start sm:items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-800 rounded-xl max-w-2xl w-full my-4 sm:my-0 max-h-none sm:max-h-[90vh] sm:overflow-y-auto">
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-xl font-bold">{selectedItem.Title}</h2>
                  <p className="text-slate-400">{selectedItem.Year} • {selectedItem.Type}</p>
                  {selectedItem.Type === 'series' && (
                    <p className="text-sm text-primary-400 mt-1">
                      All seasons and episodes will be added to your library
                    </p>
                  )}
                </div>
                <button
                  onClick={handleClose}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Result Message */}
              {addResult && (
                <div className={`mb-4 p-3 rounded-lg ${addResult.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {addResult.message}
                </div>
              )}

              {/* Quick Add */}
              <div className="flex gap-3 mb-6">
                <button
                  className="btn-primary flex items-center gap-2"
                  onClick={() => handleAdd(selectedItem)}
                  disabled={adding || added.has(selectedItem.imdbID)}
                >
                  {adding ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : added.has(selectedItem.imdbID) ? (
                    <Check className="w-5 h-5" />
                  ) : (
                    <Plus className="w-5 h-5" />
                  )}
                  {adding ? 'Adding...' : added.has(selectedItem.imdbID) ? 'Added' : selectedItem.Type === 'series' ? 'Add All Episodes' : 'Add to Library'}
                </button>
              </div>

              {/* Torrent Search - only show for movies, TV shows download on-demand */}
              {selectedItem.Type === 'movie' && (
                <TorrentSearch
                  title={selectedItem.Title}
                  year={selectedItem.Year}
                  type={selectedItem.Type}
                  onSelect={(magnetUri) => handleAdd(selectedItem, magnetUri)}
                />
              )}

              {selectedItem.Type === 'series' && (
                <div className="border border-slate-700 rounded-lg p-4 text-slate-400 text-sm">
                  <p className="mb-2">
                    <strong className="text-white">Note:</strong> TV episodes are downloaded on-demand when you play them in Jellyfin.
                  </p>
                  <p>
                    This ensures you only download what you actually watch, saving disk space.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
