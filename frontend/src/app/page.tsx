'use client';

import { useState, useEffect } from 'react';
import SearchBox from '@/components/SearchBox';
import ActiveDownloads from '@/components/ActiveDownloads';
import RecentMedia from '@/components/RecentMedia';
import { SystemStatus } from '@/components/SystemStatus';
import Recommendations from '@/components/Recommendations';
import { api } from '@/lib/api';

interface Stats {
  disks: Array<{
    name: string;
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
  }>;
  media: {
    movies: number;
    tv: number;
    web: number;
    total: number;
  };
  downloads: {
    active: number;
    completed: number;
    failed: number;
  };
  transfer: {
    dl_info_speed: number;
    up_info_speed: number;
  };
}

export default function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadStats = async () => {
    try {
      const data = await api.getStats();
      setStats(data);
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* System Status Banner */}
      <SystemStatus />

      {/* Search Section */}
      <section className="card">
        <h2 className="text-2xl font-bold mb-4">Add Media</h2>
        <SearchBox />
      </section>

      {/* AI Recommendations */}
      <Recommendations onLibraryUpdate={loadStats} />

      {/* Active Downloads Summary */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card text-center">
            <div className="text-4xl font-bold text-green-400">{stats.downloads.active}</div>
            <div className="text-slate-400">Active Downloads</div>
          </div>
          <div className="card text-center">
            <div className="text-4xl font-bold text-primary-400">{stats.media.total}</div>
            <div className="text-slate-400">Total Media Items</div>
          </div>
        </div>
      )}

      {/* Active Downloads */}
      <section className="card">
        <h2 className="text-xl font-bold mb-4">Active Downloads</h2>
        <ActiveDownloads />
      </section>

      {/* Recent Media */}
      <section className="card">
        <h2 className="text-xl font-bold mb-4">Recently Added</h2>
        <RecentMedia />
      </section>
    </div>
  );
}
