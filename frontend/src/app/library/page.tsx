'use client';

import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import MediaGrid from '@/components/MediaGrid';
import Recommendations from '@/components/Recommendations';
import { Film, Tv, Globe, Search, ArrowUpDown } from 'lucide-react';

type MediaType = 'all' | 'movie' | 'tv' | 'web';
type SortOption = 'recent' | 'alpha-asc' | 'alpha-desc' | 'year-desc' | 'year-asc' | 'rating-desc';

const sortOptions: { id: SortOption; label: string }[] = [
  { id: 'recent', label: 'Recently Updated' },
  { id: 'alpha-asc', label: 'A → Z' },
  { id: 'alpha-desc', label: 'Z → A' },
  { id: 'year-desc', label: 'Year (Newest)' },
  { id: 'year-asc', label: 'Year (Oldest)' },
  { id: 'rating-desc', label: 'Rating (Highest)' },
];

export default function LibraryPage() {
  const [mediaItems, setMediaItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MediaType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('recent');

  useEffect(() => {
    loadMedia();
  }, [filter]);

  const loadMedia = async () => {
    setLoading(true);
    try {
      const type = filter === 'all' ? undefined : filter;
      const data = await api.getMedia(type);
      setMediaItems(data.items);
    } catch (error) {
      console.error('Failed to load media:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredAndSortedItems = useMemo(() => {
    let items = mediaItems as any[];

    // Text filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter((item: any) =>
        item.title?.toLowerCase().includes(q)
      );
    }

    // Sort
    items = [...items].sort((a: any, b: any) => {
      switch (sortBy) {
        case 'recent': {
          const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
          const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
          return dateB - dateA;
        }
        case 'alpha-asc':
          return (a.title || '').localeCompare(b.title || '');
        case 'alpha-desc':
          return (b.title || '').localeCompare(a.title || '');
        case 'year-desc':
          return (b.year || 0) - (a.year || 0);
        case 'year-asc':
          return (a.year || 0) - (b.year || 0);
        case 'rating-desc':
          return (b.imdbRating || 0) - (a.imdbRating || 0);
        default:
          return 0;
      }
    });

    return items;
  }, [mediaItems, searchQuery, sortBy]);

  const tabs = [
    { id: 'all', label: 'All', icon: null },
    { id: 'movie', label: 'Movies', icon: Film },
    { id: 'tv', label: 'TV', icon: Tv },
    { id: 'web', label: 'Web', icon: Globe },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Library</h1>

      {/* Filter Tabs + Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex gap-2">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  filter === tab.id
                    ? 'bg-primary-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
                onClick={() => setFilter(tab.id as MediaType)}
              >
                {Icon && <Icon className="w-4 h-4" />}
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            className="input pl-10 w-full"
            placeholder="Filter by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="relative">
          <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          <select
            className="input pl-10 pr-4 appearance-none bg-slate-700 text-slate-200 cursor-pointer"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
          >
            {sortOptions.map(opt => (
              <option key={opt.id} value={opt.id}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Media Grid */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
        </div>
      ) : (
        <MediaGrid items={filteredAndSortedItems} />
      )}

      {/* AI Recommendations */}
      <Recommendations onLibraryUpdate={loadMedia} />
    </div>
  );
}
