'use client';

import { useState, useEffect } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import Link from 'next/link';

interface DownloadItem {
  id: string;
  status: string;
  progress: number;
  downloadReason?: string;
  detectedEpisodes?: {
    type: string;
    description: string;
  };
  mediaItem: {
    title: string;
    type: string;
    season?: number;
    episode?: number;
    year?: number;
  };
}

export default function ActiveDownloads() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDownloads();
    const interval = setInterval(loadDownloads, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDownloads = async () => {
    try {
      const data = await api.getActiveDownloads();
      setDownloads(data.downloads || []);
    } catch (error) {
      console.error('Failed to load downloads:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (downloads.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400">
        <Download className="w-12 h-12 mx-auto mb-2 opacity-50" />
        <p>No active downloads</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {downloads.slice(0, 5).map(download => (
        <div key={download.id} className="bg-slate-700/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-medium truncate">
              {download.downloadReason || (
                download.mediaItem.type === 'tv' && download.detectedEpisodes?.description
                  ? `${download.mediaItem.title} - ${download.detectedEpisodes.description}`
                  : download.mediaItem.type === 'tv' && download.mediaItem.season && download.mediaItem.episode
                    ? `${download.mediaItem.title} S${String(download.mediaItem.season).padStart(2, '0')}E${String(download.mediaItem.episode).padStart(2, '0')}`
                    : download.mediaItem.type === 'movie' && download.mediaItem.year
                      ? `${download.mediaItem.title} (${download.mediaItem.year})`
                      : download.mediaItem.title
              )}
            </span>
            <span className="text-sm text-slate-400 capitalize">{download.mediaItem.type}</span>
          </div>
          <div className="relative h-2 bg-slate-600 rounded-full overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-primary-500 rounded-full transition-all"
              style={{ width: `${download.progress}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-sm text-slate-400">
            <span className="capitalize">{download.status}</span>
            <span>{download.progress.toFixed(1)}%</span>
          </div>
        </div>
      ))}
      
      {downloads.length > 5 && (
        <Link href="/downloads" className="block text-center text-primary-400 hover:text-primary-300">
          View all {downloads.length} downloads
        </Link>
      )}
    </div>
  );
}
