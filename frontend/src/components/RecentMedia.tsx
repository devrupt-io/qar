'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Film, Tv, Globe, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'web';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  posterUrl?: string;
  createdAt: string;
}

export default function RecentMedia() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRecent();
  }, []);

  const loadRecent = async () => {
    try {
      const data = await api.getLibraryStats();
      setItems(data.recent || []);
    } catch (error) {
      console.error('Failed to load recent media:', error);
    } finally {
      setLoading(false);
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'movie':
        return <Film className="w-4 h-4" />;
      case 'tv':
        return <Tv className="w-4 h-4" />;
      default:
        return <Globe className="w-4 h-4" />;
    }
  };

  const getTitle = (item: MediaItem): string => {
    if (item.type === 'tv' && item.season && item.episode) {
      return `${item.title} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    }
    if (item.type === 'movie' && item.year) {
      return `${item.title} (${item.year})`;
    }
    return item.title;
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
  };

  const getMediaUrl = (item: MediaItem): string => {
    // For TV episodes, link to the episode details
    if (item.type === 'tv') {
      return `/media/${item.id}`;
    }
    // For movies and web content
    return `/media/${item.id}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400">
        <Film className="w-12 h-12 mx-auto mb-2 opacity-50" />
        <p>No media added yet</p>
        <p className="text-sm mt-1">Search above to add movies and TV shows</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <Link
          key={item.id}
          href={getMediaUrl(item)}
          className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg hover:bg-slate-700 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-slate-600 rounded-lg">
              {getIcon(item.type)}
            </div>
            <div>
              <h3 className="font-medium">{getTitle(item)}</h3>
              <p className="text-sm text-slate-400 capitalize">{item.type}</p>
            </div>
          </div>
          <span className="text-sm text-slate-400">{formatDate(item.createdAt)}</span>
        </Link>
      ))}
      
      <Link href="/library" className="block text-center text-primary-400 hover:text-primary-300 pt-2">
        View full library
      </Link>
    </div>
  );
}
