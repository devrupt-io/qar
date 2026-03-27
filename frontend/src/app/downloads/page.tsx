'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { Download, Pause, Play, Trash2, AlertCircle, History, CheckCircle, Clock, Film, Tv, Globe, ExternalLink, Zap } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';

interface DetectedEpisodes {
  type: string;
  isComplete: boolean;
  seasons: number[];
  episodes: Array<{ season: number; episode: number }>;
  description: string;
}

interface DownloadItem {
  id: string;
  status: string;
  progress: number;
  downloadSpeed: number;
  eta: number;
  error?: string;
  completedAt?: string;
  createdAt?: string;
  detectedEpisodes?: DetectedEpisodes;
  downloadReason?: string;
  torrentName?: string;
  isAutoDownload?: boolean;
  mediaItem: {
    id: string;
    type: string;
    title: string;
    year?: number;
    season?: number;
    episode?: number;
  };
}

export default function DownloadsPage() {
  const [activeDownloads, setActiveDownloads] = useState<DownloadItem[]>([]);
  const [historyDownloads, setHistoryDownloads] = useState<DownloadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [qbitUrl, setQbitUrl] = useState('http://localhost:8888');
  
  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => Promise<void>;
  }>({ isOpen: false, title: '', message: '', onConfirm: async () => {} });
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setQbitUrl(`${window.location.protocol}//${window.location.hostname}:8888`);
    loadDownloads();
    const interval = setInterval(loadDownloads, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDownloads = async () => {
    try {
      // Load active downloads
      const activeData = await api.getActiveDownloads();
      setActiveDownloads(activeData.downloads || []);
      
      // Load download history (completed downloads)
      const historyData = await api.getDownloadHistory(50);
      setHistoryDownloads(historyData.downloads || []);
    } catch (error) {
      console.error('Failed to load downloads:', error);
    } finally {
      setLoading(false);
    }
  };

  const pauseDownload = async (id: string) => {
    try {
      await api.pauseDownload(id);
      loadDownloads();
    } catch (error) {
      console.error('Failed to pause download:', error);
    }
  };

  const resumeDownload = async (id: string) => {
    try {
      await api.resumeDownload(id);
      loadDownloads();
    } catch (error) {
      console.error('Failed to resume download:', error);
    }
  };

  const deleteDownload = async (id: string, title: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Cancel Download',
      message: `Are you sure you want to cancel the download for "${title}"?\n\nThis will stop the download and remove the torrent from the queue.`,
      onConfirm: async () => {
        setIsDeleting(true);
        try {
          await api.deleteDownload(id);
          loadDownloads();
        } catch (error) {
          console.error('Failed to delete download:', error);
        } finally {
          setIsDeleting(false);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  const formatEta = (seconds: number): string => {
    if (seconds < 0 || seconds === 8640000) return '∞';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const formatDate = (dateStr?: string): string => {
    if (!dateStr) return 'Unknown';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getMediaTitle = (item: DownloadItem['mediaItem'], detectedEpisodes?: DetectedEpisodes): string => {
    // For TV shows, prefer the detected episodes description if available
    if (item.type === 'tv') {
      if (detectedEpisodes && detectedEpisodes.description) {
        return `${item.title} - ${detectedEpisodes.description}`;
      }
      if (item.season && item.episode) {
        return `${item.title} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`;
      }
      return item.title;
    }
    if (item.type === 'movie' && item.year) {
      return `${item.title} (${item.year})`;
    }
    return item.title;
  };

  // Get a short display string for the detected episodes
  const getDetectedEpisodesLabel = (detected?: DetectedEpisodes): string | null => {
    if (!detected) return null;
    
    switch (detected.type) {
      case 'complete':
        return 'Complete Series';
      case 'season':
        if (detected.seasons.length === 1) {
          return `Season ${detected.seasons[0]}`;
        }
        return `Seasons ${detected.seasons.join(', ')}`;
      case 'range':
        return detected.description;
      case 'episode':
        if (detected.episodes.length > 0) {
          const ep = detected.episodes[0];
          return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
        }
        return null;
      default:
        return null;
    }
  };

  const getMediaIcon = (type: string) => {
    switch (type) {
      case 'movie':
        return <Film className="w-4 h-4" />;
      case 'tv':
        return <Tv className="w-4 h-4" />;
      default:
        return <Globe className="w-4 h-4" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Failed Auto-Downloads Alert */}
      {(() => {
        const failedAutoDownloads = historyDownloads.filter(d => d.isAutoDownload && d.status === 'failed');
        if (failedAutoDownloads.length === 0) return null;
        return (
          <section className="bg-red-900/20 border border-red-600/30 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-5 h-5 text-amber-400" />
              <h2 className="font-semibold text-red-300">Failed Auto-Downloads</h2>
              <span className="px-2 py-0.5 bg-red-600/30 rounded text-xs text-red-300">
                {failedAutoDownloads.length}
              </span>
            </div>
            <div className="space-y-2">
              {failedAutoDownloads.map(download => (
                <div key={download.id} className="flex items-center justify-between bg-slate-800/50 rounded-lg p-3">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <div>
                      <Link
                        href={`/media/${download.mediaItem.id}`}
                        className="text-sm font-medium hover:text-primary-400 transition-colors"
                      >
                        {getMediaTitle(download.mediaItem, download.detectedEpisodes)}
                      </Link>
                      {download.error && (
                        <p className="text-xs text-red-400 mt-0.5">{download.error}</p>
                      )}
                    </div>
                  </div>
                  <Link
                    href={`/media/${download.mediaItem.id}`}
                    className="text-xs px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
                  >
                    Retry
                  </Link>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      {/* Active Downloads Section */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <Download className="w-8 h-8 text-primary-400" />
          <h1 className="text-3xl font-bold">Active Downloads</h1>
          <span className="px-2 py-1 bg-slate-700 rounded text-sm">
            {activeDownloads.length}
          </span>
          <a
            href={qbitUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition-colors text-slate-300"
          >
            <ExternalLink className="w-4 h-4" />
            QBittorrent
          </a>
        </div>

        {activeDownloads.length === 0 ? (
          <div className="card text-center py-12">
            <Download className="w-16 h-16 text-slate-500 mx-auto mb-4" />
            <p className="text-slate-400">No active downloads</p>
            <p className="text-sm text-slate-500 mt-2">
              Downloads will appear here when you start downloading media
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {activeDownloads.map(download => {
              const episodesLabel = getDetectedEpisodesLabel(download.detectedEpisodes);
              return (
              <div key={download.id} className="card">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0 flex-1">
                    <Link 
                      href={`/media/${download.mediaItem.id}`}
                      className="font-semibold hover:text-primary-400 transition-colors"
                    >
                      {getMediaTitle(download.mediaItem, download.detectedEpisodes)}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
                      <span className="capitalize flex items-center gap-1">
                        {getMediaIcon(download.mediaItem.type)}
                        {download.mediaItem.type}
                      </span>
                      {download.isAutoDownload && (
                        <span className="px-2 py-0.5 bg-amber-600/30 text-amber-300 rounded text-xs flex items-center gap-1">
                          <Zap className="w-3 h-3" />
                          Auto
                        </span>
                      )}
                      {episodesLabel && download.mediaItem.type === 'tv' && (
                        <span className="px-2 py-0.5 bg-primary-600/30 text-primary-300 rounded text-xs">
                          {episodesLabel}
                        </span>
                      )}
                      {download.downloadReason && (
                        <span className="text-xs text-slate-500" title="Download reason">
                          • {download.downloadReason}
                        </span>
                      )}
                    </div>
                    {download.torrentName && (
                      <div className="text-xs text-slate-500 mt-1 truncate" title={download.torrentName}>
                        📦 {download.torrentName}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {download.status === 'downloading' && (
                      <button
                        className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
                        onClick={() => pauseDownload(download.id)}
                        title="Pause"
                      >
                        <Pause className="w-4 h-4" />
                      </button>
                    )}
                    {download.status === 'paused' && (
                      <button
                        className="p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
                        onClick={() => resumeDownload(download.id)}
                        title="Resume"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      className="p-2 rounded-lg bg-red-900/50 hover:bg-red-900 transition-colors text-red-400"
                      onClick={() => deleteDownload(download.id, getMediaTitle(download.mediaItem, download.detectedEpisodes))}
                      title="Cancel"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="relative h-3 bg-slate-700 rounded-full overflow-hidden mb-2">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full transition-all ${
                      download.status === 'failed' ? 'bg-red-500' :
                      download.status === 'paused' ? 'bg-yellow-500' :
                      'bg-primary-500'
                    }`}
                    style={{ width: `${download.progress}%` }}
                  />
                </div>

                {/* Status */}
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-4">
                    <span className={`capitalize ${
                      download.status === 'failed' ? 'text-red-400' :
                      download.status === 'paused' ? 'text-yellow-400' :
                      'text-primary-400'
                    }`}>
                      {download.status}
                    </span>
                    <span className="text-slate-400">{download.progress.toFixed(1)}%</span>
                  </div>
                  {download.status === 'downloading' && (
                    <div className="flex items-center gap-4 text-slate-400">
                      <span>{formatSpeed(download.downloadSpeed || 0)}</span>
                      <span>ETA: {formatEta(download.eta || 0)}</span>
                    </div>
                  )}
                </div>

                {/* Error Message */}
                {download.error && (
                  <div className="flex items-center gap-2 mt-2 text-red-400 text-sm">
                    <AlertCircle className="w-4 h-4" />
                    {download.error}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Download History Section */}
      <section>
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="flex items-center gap-3 mb-4 hover:opacity-80 transition-opacity"
        >
          <History className="w-6 h-6 text-slate-400" />
          <h2 className="text-xl font-semibold text-slate-300">Download History</h2>
          <span className="px-2 py-1 bg-slate-700 rounded text-sm text-slate-400">
            {historyDownloads.length}
          </span>
          <span className="text-slate-500 text-sm">
            {showHistory ? '(click to hide)' : '(click to show)'}
          </span>
        </button>

        {showHistory && (
          <>
            {historyDownloads.length === 0 ? (
              <div className="card text-center py-8">
                <Clock className="w-12 h-12 text-slate-500 mx-auto mb-3" />
                <p className="text-slate-400">No download history yet</p>
                <p className="text-sm text-slate-500 mt-1">
                  Completed downloads will be shown here
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {historyDownloads.map(download => (
                  <div key={download.id} className={`card bg-slate-800/50 py-3 ${download.status === 'failed' ? 'border-l-2 border-red-500' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {download.status === 'failed' ? (
                          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                        ) : (
                          <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                        )}
                        <div className="min-w-0">
                          <Link 
                            href={`/media/${download.mediaItem.id}`}
                            className="font-medium hover:text-primary-400 transition-colors block truncate"
                          >
                            {getMediaTitle(download.mediaItem, download.detectedEpisodes)}
                          </Link>
                          <p className="text-xs text-slate-500 flex flex-wrap items-center gap-1">
                            {getMediaIcon(download.mediaItem.type)}
                            <span className="capitalize">{download.mediaItem.type}</span>
                            {download.isAutoDownload && (
                              <>
                                <span className="mx-1">•</span>
                                <span className="text-amber-400 flex items-center gap-0.5"><Zap className="w-3 h-3" />Auto</span>
                              </>
                            )}
                            {download.detectedEpisodes && download.mediaItem.type === 'tv' && (
                              <>
                                <span className="mx-1">•</span>
                                <span className="text-primary-400 truncate max-w-[200px]">{getDetectedEpisodesLabel(download.detectedEpisodes)}</span>
                              </>
                            )}
                            {download.downloadReason && (
                              <>
                                <span className="mx-1">•</span>
                                <span className="truncate max-w-[150px]" title={download.downloadReason}>{download.downloadReason}</span>
                              </>
                            )}
                            <span className="mx-1">•</span>
                            <span className="whitespace-nowrap">{download.status === 'failed' ? 'Failed' : 'Completed'} {formatDate(download.completedAt || download.createdAt)}</span>
                          </p>
                        </div>
                      </div>
                      <span className={`text-sm flex-shrink-0 ${download.status === 'failed' ? 'text-red-400' : 'text-green-400'}`}>
                        {download.status === 'failed' ? 'Failed' : 'Completed'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText="Cancel Download"
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  );
}
