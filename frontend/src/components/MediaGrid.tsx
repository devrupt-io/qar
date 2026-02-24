'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Film, Tv, Globe, Pin } from 'lucide-react';

interface MediaItem {
  id: string;
  type: 'movie' | 'tv' | 'web';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  channel?: string;
  posterUrl?: string;
  plot?: string;
  magnetUri?: string;
  filePath?: string;
  diskPath?: string;
  pinned?: boolean;
  downloads?: Array<{ status: string; progress: number; completedAt?: string }>;
  // TV show specific fields
  totalEpisodes?: number;
  downloadedEpisodes?: number;
  downloadingEpisodes?: number;
}

interface Props {
  items: MediaItem[];
}

// Poster image component with error fallback
function PosterImage({ src, alt, type }: { src: string; alt: string; type: string }) {
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  
  const getIcon = () => {
    switch (type) {
      case 'movie':
        return <Film className="w-8 h-8 text-slate-500" />;
      case 'tv':
        return <Tv className="w-8 h-8 text-slate-500" />;
      default:
        return <Globe className="w-8 h-8 text-slate-500" />;
    }
  };
  
  // Check for invalid URLs (OMDB returns "N/A" for missing posters)
  const isValidUrl = src && src !== 'N/A' && src.startsWith('http');
  
  if (!isValidUrl || hasError) {
    return (
      <div className="flex items-center justify-center h-full bg-slate-700">
        {getIcon()}
      </div>
    );
  }
  
  return (
    <>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-700">
          <div className="w-6 h-6 border-2 border-slate-500 border-t-primary-500 rounded-full animate-spin" />
        </div>
      )}
      <Image
        src={src}
        alt={alt}
        fill
        className={`object-cover transition-opacity ${isLoading ? 'opacity-0' : 'opacity-100'}`}
        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
        onLoad={() => setIsLoading(false)}
        onError={() => {
          setHasError(true);
          setIsLoading(false);
        }}
      />
    </>
  );
}

export default function MediaGrid({ items }: Props) {
  const getIcon = (type: string) => {
    switch (type) {
      case 'movie':
        return <Film className="w-8 h-8 text-slate-500" />;
      case 'tv':
        return <Tv className="w-8 h-8 text-slate-500" />;
      default:
        return <Globe className="w-8 h-8 text-slate-500" />;
    }
  };

  const getTitle = (item: MediaItem): string => {
    // TV shows (from TVShow entity) only show the title
    if (item.type === 'tv' && item.totalEpisodes !== undefined) {
      return item.year ? `${item.title} (${item.year})` : item.title;
    }
    // TV episodes (individual MediaItem records)
    if (item.type === 'tv' && item.season && item.episode) {
      return `${item.title} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
    }
    if (item.type === 'movie' && item.year) {
      return `${item.title} (${item.year})`;
    }
    return item.title;
  };

  const getStatus = (item: MediaItem): { label: string; color: string } => {
    // For TV shows, show episode download counts
    if (item.type === 'tv' && item.totalEpisodes !== undefined) {
      const downloaded = item.downloadedEpisodes || 0;
      const total = item.totalEpisodes;
      
      if (downloaded === total && total > 0) {
        return { label: `All ${total} Downloaded`, color: 'bg-green-500' };
      }
      if (downloaded > 0) {
        return { label: `${downloaded}/${total} Downloaded`, color: 'bg-green-500' };
      }
      if (item.downloadingEpisodes && item.downloadingEpisodes > 0) {
        return { label: `Downloading ${item.downloadingEpisodes}`, color: 'bg-primary-500' };
      }
      return { label: `${total} Episodes`, color: 'bg-slate-500' };
    }
    
    // Check if file is available on disk
    if (item.filePath && item.diskPath) {
      return { label: 'Available', color: 'bg-green-500' };
    }
    
    const download = item.downloads?.[0];
    if (download) {
      // Download completed (file may still be processing or already moved)
      if (download.status === 'completed') {
        // If download is completed but file path not set yet, show as "Downloaded"
        // The file may still be processing/moving
        return { label: 'Downloaded', color: 'bg-green-500' };
      }
      if (download.status === 'downloading') {
        return { label: `${download.progress.toFixed(0)}%`, color: 'bg-primary-500' };
      }
      if (download.status === 'pending') {
        return { label: 'Pending', color: 'bg-yellow-500' };
      }
      if (download.status === 'paused') {
        return { label: 'Paused', color: 'bg-yellow-500' };
      }
      if (download.status === 'failed') {
        return { label: 'Failed', color: 'bg-red-500' };
      }
    }
    
    return { label: 'Not Downloaded', color: 'bg-slate-500' };
  };

  // Get the correct URL for this item
  const getItemUrl = (item: MediaItem): string => {
    // TV shows (from TVShow entity) link to the TV show page
    if (item.type === 'tv' && item.totalEpisodes !== undefined) {
      return `/media/tv/${item.id}`;
    }
    return `/media/${item.id}`;
  };

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-slate-400">
        <Film className="w-16 h-16 mx-auto mb-4 opacity-50" />
        <p>No media items found</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {items.map(item => {
          const status = getStatus(item);
          
          return (
            <div
              key={item.id}
              className="bg-slate-800 rounded-lg overflow-hidden relative hover:ring-2 hover:ring-primary-500 transition-all"
            >
              {/* Poster */}
              <Link href={getItemUrl(item)} className="block">
                <div className="relative aspect-[2/3] bg-slate-700">
                  {item.posterUrl ? (
                    <PosterImage 
                      src={item.posterUrl} 
                      alt={item.title} 
                      type={item.type} 
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      {getIcon(item.type)}
                    </div>
                  )}
                  
                  {/* Pinned Badge */}
                  {item.pinned && (
                    <div className="absolute top-2 left-2 p-1 bg-yellow-600 rounded">
                      <Pin className="w-3 h-3" />
                    </div>
                  )}
                  
                  {/* Status Badge */}
                  <div className={`absolute top-2 right-2 px-2 py-1 rounded text-xs font-medium ${status.color}`}>
                    {status.label}
                  </div>

                </div>
              </Link>

              {/* Info */}
              <div className="p-3">
                <h3 className="font-medium text-sm line-clamp-2">{getTitle(item)}</h3>
                <p className="text-xs text-slate-400 mt-1 capitalize">{item.type}</p>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
