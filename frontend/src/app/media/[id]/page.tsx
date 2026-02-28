'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { api } from '@/lib/api';
import TorrentSearch from '@/components/TorrentSearch';
import ErrorBoundary from '@/components/ErrorBoundary';
import ConfirmModal from '@/components/ConfirmModal';
import { 
  Film, 
  Tv, 
  Globe, 
  Play, 
  Pin, 
  PinOff, 
  Trash2, 
  Download, 
  ArrowLeft,
  Calendar,
  Clock,
  HardDrive,
  CheckCircle,
  XCircle,
  Loader2,
  Copy,
  Check,
  Link as LinkIcon
} from 'lucide-react';

interface MediaDetails {
  id: string;
  type: 'movie' | 'tv' | 'web';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  channel?: string;
  posterUrl?: string;
  plot?: string;
  imdbId?: string;
  magnetUri?: string;
  filePath?: string;
  pinned?: boolean;
  hasFile: boolean;
  relatedEpisodes: number;
  parentShowId?: string; // For TV episodes, redirect to TV show page
  createdAt: string;
  downloads?: Array<{
    id: string;
    status: string;
    progress: number;
    downloadSpeed?: number;
    eta?: number;
    completedAt?: string;
  }>;
}

function MediaDetailsContent({ id }: { id: string }) {
  const router = useRouter();
  const [media, setMedia] = useState<MediaDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPinning, setIsPinning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showTorrentSearch, setShowTorrentSearch] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [jellyfinUrl, setJellyfinUrl] = useState<string | null>(null);
  
  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => Promise<void>;
  }>({ isOpen: false, title: '', message: '', confirmText: 'Confirm', onConfirm: async () => {} });

  useEffect(() => {
    console.log('[MediaDetailsContent] useEffect triggered with id:', id);
    loadMediaDetails();
  }, [id]);

  const loadMediaDetails = async () => {
    console.log('[MediaDetailsContent] loadMediaDetails called for id:', id);
    try {
      setLoading(true);
      setError(null);
      console.log('[MediaDetailsContent] Fetching from API...');
      const data = await api.getMediaDetails(id);
      console.log('[MediaDetailsContent] API response:', data);
      
      // If this is a TV episode and we have a parent show, redirect to the TV show page
      // Individual episodes should not have their own page - users view them on the TV show page
      if (data.type === 'tv' && data.parentShowId && data.season && data.episode) {
        console.log('[MediaDetailsContent] Redirecting TV episode to show page:', data.parentShowId);
        router.replace(`/media/tv/${data.parentShowId}`);
        return;
      }
      
      setMedia(data);
      
      // Always try to load Jellyfin watch URL (Jellyfin may have indexed .strm files even without a local media file)
      try {
        const watchUrl = await api.getJellyfinWatchUrl(
          data.title, 
          data.type,
          data.season,
          data.episode
        );
        if (watchUrl.found) {
          setJellyfinUrl(watchUrl.detailsUrl);
        }
      } catch (e) {
        console.warn('Could not get Jellyfin watch URL:', e);
      }
    } catch (err: any) {
      console.error('[MediaDetailsContent] API error:', err);
      setError(err.message || 'Failed to load media details');
    } finally {
      setLoading(false);
      console.log('[MediaDetailsContent] Loading complete');
    }
  };

  const handlePin = async () => {
    if (!media) return;
    
    setIsPinning(true);
    try {
      if (media.pinned) {
        await api.unpinMedia(media.id);
      } else {
        await api.pinMedia(media.id);
      }
      setMedia({ ...media, pinned: !media.pinned });
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    } finally {
      setIsPinning(false);
    }
  };

  const handleDelete = async () => {
    if (!media) return;
    
    // For TV episodes, we only delete the downloaded file, not the metadata
    // To delete the entire show, users must use the TV show page
    const isTvEpisode = media.type === 'tv';
    const episodeStr = isTvEpisode 
      ? `S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`
      : '';
    
    const title = isTvEpisode 
      ? 'Remove Downloaded File'
      : 'Delete Media';
    
    const message = isTvEpisode 
      ? `Remove downloaded file for "${media.title}" ${episodeStr}?\n\nThe episode will remain in your library. To delete the entire show, go to the TV show page and use the Delete button there.`
      : `Delete "${media.title}"?\n\nThis will also delete any downloaded files (moved to trash for recovery).`;
    
    const confirmText = isTvEpisode ? 'Remove File' : 'Delete';
    
    setConfirmModal({
      isOpen: true,
      title,
      message,
      confirmText,
      onConfirm: async () => {
        setIsDeleting(true);
        try {
          await api.deleteMedia(media.id, true);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          // For TV episodes, stay on the page since we just deleted the file
          if (isTvEpisode) {
            loadMediaDetails(); // Reload to show updated status
            setIsDeleting(false);
          } else {
            router.push('/library');
          }
        } catch (err) {
          console.error('Failed to delete:', err);
          setIsDeleting(false);
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      },
    });
  };

  interface DetectedEpisodes {
    type: string;
    isComplete: boolean;
    seasons: number[];
    episodes: Array<{ season: number; episode: number }>;
    description: string;
  }

  const handleDownload = async (magnetUri: string, detected?: DetectedEpisodes) => {
    if (!media) return;
    
    try {
      // Build detected episodes info for single episodes
      const detectedEpisodes = detected || (media.type === 'tv' && media.season && media.episode ? {
        type: 'episode',
        isComplete: false,
        seasons: [media.season],
        episodes: [{ season: media.season, episode: media.episode }],
        description: `S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`,
      } : undefined);
      
      await api.startDownload(media.id, magnetUri, detectedEpisodes);
      setShowTorrentSearch(false);
      loadMediaDetails();
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const getJellyfinUrl = (): string => {
    // If we have a direct Jellyfin URL for this item, use it
    if (jellyfinUrl) {
      return jellyfinUrl;
    }
    // Otherwise redirect to Jellyfin via our redirect page which handles authentication
    return '/jellyfin-redirect';
  };

  const getStreamUrl = (): string => {
    if (!media) return '';
    
    // Helper to create URL-safe slug
    const slugify = (text: string): string => 
      text.toLowerCase().replace(/[^a-z0-9]+/g, '+').replace(/^\+|\+$/g, '');
    
    const backendUrl = typeof window !== 'undefined' 
      ? `${window.location.protocol}//${window.location.hostname}:3001`
      : 'http://localhost:3001';
    
    if (media.type === 'movie') {
      return `${backendUrl}/stream/movies/${slugify(media.title)}/${media.year}`;
    } else if (media.type === 'tv' && media.season && media.episode) {
      const episodeCode = `s${String(media.season).padStart(2, '0')}e${String(media.episode).padStart(2, '0')}`;
      return `${backendUrl}/stream/tv/${slugify(media.title)}/${episodeCode}`;
    } else if (media.type === 'web') {
      return `${backendUrl}/stream/web/${slugify(media.title)}`;
    }
    
    return `${backendUrl}/stream/${media.id}`;
  };

  const copyStreamUrl = async () => {
    const url = getStreamUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  };

  const getTitle = (): string => {
    if (!media) return '';
    if (media.type === 'tv' && media.season && media.episode) {
      return `${media.title} S${String(media.season).padStart(2, '0')}E${String(media.episode).padStart(2, '0')}`;
    }
    if (media.type === 'movie' && media.year) {
      return `${media.title} (${media.year})`;
    }
    return media.title;
  };

  const getTypeIcon = () => {
    if (!media) return null;
    switch (media.type) {
      case 'movie':
        return <Film className="w-6 h-6" />;
      case 'tv':
        return <Tv className="w-6 h-6" />;
      default:
        return <Globe className="w-6 h-6" />;
    }
  };

  const getStatusBadge = () => {
    if (!media) return null;
    
    if (media.hasFile) {
      return (
        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-green-600 text-white text-sm">
          <CheckCircle className="w-4 h-4" />
          Available
        </span>
      );
    }
    
    const download = media.downloads?.[0];
    if (download) {
      if (download.status === 'downloading') {
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-primary-600 text-white text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Downloading {download.progress?.toFixed(0) ?? 0}%
          </span>
        );
      }
      if (download.status === 'pending') {
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-yellow-600 text-white text-sm">
            <Clock className="w-4 h-4" />
            Pending
          </span>
        );
      }
      if (download.status === 'paused') {
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-yellow-600 text-white text-sm">
            <Clock className="w-4 h-4" />
            Paused
          </span>
        );
      }
      if (download.status === 'failed') {
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-600 text-white text-sm">
            <XCircle className="w-4 h-4" />
            Failed
          </span>
        );
      }
      if (download.status === 'completed') {
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-green-600 text-white text-sm">
            <CheckCircle className="w-4 h-4" />
            Downloaded
          </span>
        );
      }
    }
    
    return (
      <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-600 text-white text-sm">
        <HardDrive className="w-4 h-4" />
        Not Downloaded
      </span>
    );
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec >= 1024 * 1024) {
      return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  };

  const formatEta = (seconds: number) => {
    if (seconds <= 0 || seconds === 8640000) return 'Unknown';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (error || !media) {
    return (
      <div className="text-center py-12">
        <XCircle className="w-16 h-16 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Failed to Load</h2>
        <p className="text-slate-400 mb-4">{error || 'Media not found'}</p>
        <Link href="/library" className="text-primary-500 hover:underline">
          Back to Library
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Back Button */}
      <Link
        href="/library"
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Library
      </Link>

      <div className="bg-slate-800 rounded-xl overflow-hidden">
        <div className="md:flex">
          {/* Poster */}
          <div className="md:w-1/3 relative">
            <div className="aspect-[2/3] bg-slate-700">
              {media.posterUrl ? (
                <Image
                  src={media.posterUrl}
                  alt={media.title}
                  fill
                  className="object-cover"
                  priority
                />
              ) : (
                <div className="flex items-center justify-center h-full">
                  {getTypeIcon()}
                </div>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="md:w-2/3 p-6">
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold mb-2">{getTitle()}</h1>
                <div className="flex items-center gap-3 text-slate-400">
                  <span className="inline-flex items-center gap-1 capitalize">
                    {getTypeIcon()}
                    {media.type}
                  </span>
                  {media.year && (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="w-4 h-4" />
                      {media.year}
                    </span>
                  )}
                </div>
              </div>
              {getStatusBadge()}
            </div>

            {/* Plot */}
            {media.plot && (
              <p className="text-slate-300 mb-6 leading-relaxed">{media.plot}</p>
            )}

            {/* TV Show Info */}
            {media.type === 'tv' && media.relatedEpisodes > 1 && (
              <p className="text-sm text-slate-400 mb-4">
                Part of a series with {media.relatedEpisodes} episodes in your library
              </p>
            )}

            {/* Added Date */}
            <p className="text-sm text-slate-400 mb-6">
              Added on {formatDate(media.createdAt)}
            </p>

            {/* Download Progress */}
            {media.downloads?.[0]?.status === 'downloading' && (
              <div className="bg-slate-700 rounded-lg p-4 mb-6">
                <div className="flex justify-between text-sm mb-2">
                  <span>Download Progress</span>
                  <span>{(media.downloads[0].progress ?? 0).toFixed(1)}%</span>
                </div>
                <div className="w-full bg-slate-600 rounded-full h-2 mb-2">
                  <div
                    className="bg-primary-500 h-2 rounded-full transition-all"
                    style={{ width: `${media.downloads[0].progress ?? 0}%` }}
                  ></div>
                </div>
                <div className="flex justify-between text-xs text-slate-400">
                  <span>Speed: {formatSpeed(media.downloads[0].downloadSpeed || 0)}</span>
                  <span>ETA: {formatEta(media.downloads[0].eta || 0)}</span>
                </div>
              </div>
            )}

            {/* Primary CTA */}
            <div className="flex flex-wrap gap-3 mb-6">
              {media.hasFile ? (
                <a
                  href={getJellyfinUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-700 rounded-lg font-semibold transition-colors"
                >
                  <Play className="w-5 h-5" />
                  Watch Now
                </a>
              ) : !media.downloads?.length || media.downloads[0].status === 'failed' ? (
                <button
                  onClick={() => setShowTorrentSearch(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-700 rounded-lg font-semibold transition-colors"
                >
                  <Download className="w-5 h-5" />
                  Download
                </button>
              ) : null}
              {media.downloads?.[0] && ['downloading', 'pending', 'paused'].includes(media.downloads[0].status) && (
                <Link
                  href="/downloads"
                  className="inline-flex items-center gap-2 px-6 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg font-semibold transition-colors"
                >
                  <Download className="w-5 h-5" />
                  View in Downloads
                </Link>
              )}
            </div>

            {/* Secondary Actions */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handlePin}
                disabled={isPinning}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  media.pinned
                    ? 'bg-yellow-600 hover:bg-yellow-700'
                    : 'bg-slate-700 hover:bg-slate-600'
                }`}
              >
                {isPinning ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : media.pinned ? (
                  <PinOff className="w-4 h-4" />
                ) : (
                  <Pin className="w-4 h-4" />
                )}
                {media.pinned ? 'Unpin' : 'Pin for Offline'}
              </button>

              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                title={media.type === 'tv' ? 'Remove downloaded file (episode metadata is preserved)' : 'Delete item and move files to trash'}
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                {media.type === 'tv' && media.hasFile ? 'Remove Download' : 'Delete'}
              </button>

              {media.imdbId && (
                <a
                  href={`https://www.imdb.com/title/${media.imdbId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
                >
                  View on IMDb
                </a>
              )}

              {/* Copy Stream URL - useful for external players */}
              <button
                onClick={copyStreamUrl}
                className="inline-flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
                title="Copy stream URL for use in external players like VLC"
              >
                {copiedUrl ? (
                  <>
                    <Check className="w-4 h-4 text-green-400" />
                    Copied!
                  </>
                ) : (
                  <>
                    <LinkIcon className="w-4 h-4" />
                    Copy Stream URL
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Stream URL Info */}
      <div className="mt-4 p-4 bg-slate-800/50 rounded-lg">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-medium text-slate-300">Stream URL</span>
        </div>
        <p className="text-xs text-slate-500 mb-2">
          Use this URL in external players like VLC. Note: This streams through the backend server.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-slate-900 p-2 rounded text-slate-400 overflow-x-auto">
            {getStreamUrl()}
          </code>
          <button
            onClick={copyStreamUrl}
            className="p-2 bg-slate-700 hover:bg-slate-600 rounded transition-colors flex-shrink-0"
            title="Copy to clipboard"
          >
            {copiedUrl ? (
              <Check className="w-4 h-4 text-green-400" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Torrent Search Modal */}
      {showTorrentSearch && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Find Download</h2>
              <button
                onClick={() => setShowTorrentSearch(false)}
                className="text-slate-400 hover:text-white"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <TorrentSearch
              title={media.title}
              year={media.year?.toString() || ''}
              type={media.type === 'tv' ? 'series' : media.type}
              season={media.season}
              episode={media.episode}
              defaultSearchMode={media.type === 'tv' ? 'episode' : undefined}
              onSelect={handleDownload}
            />
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        variant="danger"
        isLoading={isDeleting}
      />
    </div>
  );
}

// Wrap the page with error boundary to prevent full page crashes
export default function MediaDetailsPage({ params }: { params: { id: string } }) {
  console.log('[MediaDetailsPage] Rendering with params:', params);
  
  const id = params?.id;
  
  if (!id) {
    console.error('[MediaDetailsPage] No id found in params');
    return (
      <div className="text-center py-12">
        <XCircle className="w-16 h-16 mx-auto mb-4 text-red-500" />
        <h2 className="text-xl font-semibold mb-2">Invalid Media ID</h2>
        <p className="text-slate-400 mb-4">No media ID was provided</p>
        <Link href="/library" className="text-primary-500 hover:underline">
          Back to Library
        </Link>
      </div>
    );
  }
  
  console.log('[MediaDetailsPage] Loading media with id:', id);
  
  return (
    <ErrorBoundary
      fallbackTitle="Failed to Load Media"
      fallbackMessage="There was a problem loading this media item. Please try again or go back to the library."
      showBackToLibrary={true}
    >
      <MediaDetailsContent id={id} />
    </ErrorBoundary>
  );
}
