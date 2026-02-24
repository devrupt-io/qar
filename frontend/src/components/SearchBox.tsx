'use client';

import { useState } from 'react';
import { Search, Film, Tv, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import SearchResults from './SearchResults';

interface SearchResult {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

export default function SearchBox() {
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<'all' | 'movie' | 'series'>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    
    try {
      const type = searchType === 'all' ? undefined : searchType;
      const data = await api.searchOmdb(query, type);
      setResults(data.results || []);
    } catch (error) {
      console.error('Search failed:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const clearResults = () => {
    setResults([]);
    setSearched(false);
    setQuery('');
  };

  return (
    <div>
      <form onSubmit={handleSearch} className="space-y-4">
        {/* Search Input */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              className="input pl-10"
              placeholder="Search for movies or TV shows..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              'Search'
            )}
          </button>
        </div>

        {/* Type Filter */}
        <div className="flex gap-2">
          <button
            type="button"
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm transition-colors ${
              searchType === 'all'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
            onClick={() => setSearchType('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm transition-colors ${
              searchType === 'movie'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
            onClick={() => setSearchType('movie')}
          >
            <Film className="w-4 h-4" />
            Movies
          </button>
          <button
            type="button"
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm transition-colors ${
              searchType === 'series'
                ? 'bg-primary-600 text-white'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
            onClick={() => setSearchType('series')}
          >
            <Tv className="w-4 h-4" />
            TV Shows
          </button>
        </div>
      </form>

      {/* Results */}
      {searched && (
        <div className="mt-6">
          <SearchResults results={results} loading={loading} onClear={clearResults} />
        </div>
      )}
    </div>
  );
}
