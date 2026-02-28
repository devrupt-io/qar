'use client';

import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import MediaGrid from '@/components/MediaGrid';
import Recommendations from '@/components/Recommendations';
import { Film, Tv, Globe, Search } from 'lucide-react';

type MediaType = 'all' | 'movie' | 'tv' | 'web';

export default function LibraryPage() {
  const [mediaItems, setMediaItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<MediaType>('all');
  const [searchQuery, setSearchQuery] = useState('');

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

  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return mediaItems;
    const q = searchQuery.toLowerCase();
    return mediaItems.filter((item: any) =>
      item.title?.toLowerCase().includes(q)
    );
  }, [mediaItems, searchQuery]);

  const tabs = [
    { id: 'all', label: 'All', icon: null },
    { id: 'movie', label: 'Movies', icon: Film },
    { id: 'tv', label: 'TV', icon: Tv },
    { id: 'web', label: 'Web', icon: Globe },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Library</h1>

      {/* Filter Tabs + Search */}
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
      </div>

      {/* Media Grid */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[50vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
        </div>
      ) : (
        <MediaGrid items={filteredItems} />
      )}

      {/* AI Recommendations */}
      <Recommendations onLibraryUpdate={loadMedia} />
    </div>
  );
}
