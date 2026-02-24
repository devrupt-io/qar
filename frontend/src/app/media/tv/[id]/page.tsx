'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { api } from '@/lib/api';
import ErrorBoundary from '@/components/ErrorBoundary';
import TorrentSearch from '@/components/TorrentSearch';
import ConfirmModal from '@/components/ConfirmModal';
import { 
  Tv, 
  Play, 
  Pin, 
  PinOff, 
  Trash2, 
  Download, 
  ArrowLeft,
  Calendar,
  HardDrive,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight
} from 'lucide-react';

interface Episode {
  id: string;
  title: string;
  season: number;
  episode: number;
  filePath?: string;
  diskPath?: string;
  downloads?: Array<{
    id: string;
    status: string;
    progress: number;
  }>;
}

interface TVShowDetails {
  id: string;
  title: string;
  year?: number;
  posterUrl?: string;
  plot?: string;
  imdbId?: string;
  totalSeasons?: number;
  pinned?: boolean;
  createdAt: string;
  episodes: Episode[];
}

function TVShowDetailsContent({ id }: { id: string }) {
  const router = useRouter();
  const [show, setShow] = useState<TVShowDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPinning, setIsPinning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set([1]));
  
  // Download modal state
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloadMode, setDownloadMode] = useState<'complete' | 'season' | 'episode'>('complete');
  const [selectedSeasonForDownload, setSelectedSeasonForDownload] = useState<number>(1);
  const [selectedEpisodeForDownload, setSelectedEpisodeForDownload] = useState<Episode | null>(null);
  
  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => Promise<void>;
  }>({ isOpen: false, title: '', message: '', confirmText: 'Confirm', onConfirm: async () => {} });

  useEffect(() => {
    loadShowDetails();
  }, [id]);

  const loadShowDetails = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getTvShow(id);
      setShow(data);
      
      // Expand all seasons by default
      if (data.episodes) {
        const seasons = new Set<number>(data.episodes.map((ep: Episode) => ep.season));
        setExpandedSeasons(seasons);
      }
    } catch (err: any) {
      console.error('API error:', err);
      setError(err.message || 'Failed to load TV show details');
    } finally {
      setLoading(false);
    }
  };

  const handlePin = async () => {
    if (!show) return;
    
    setIsPinning(true);
    try {
      await api.pinTvShow(show.title, !show.pinned);
      setShow({ ...show, pinned: !show.pinned });
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    } finally {
      setIsPinning(false);
    }
  };

  const handleDelete = async () => {
    if (!show) return;
    
    // First, get confirmation info from the backend
    try {
      const confirmInfo = await api.deleteTvShow(show.title, true);
      
      // If confirmation is required, show a detailed warning
      if (confirmInfo.requiresConfirmation) {
        setConfirmModal({
          isOpen: true,
          title: 'Delete TV Show',
          message: `${confirmInfo.message}\n\nAre you sure you want to continue?\n\nFiles will be moved to trash for potential recovery.`,
          confirmText: 'Delete Show',
          onConfirm: async () => {
            setIsDeleting(true);
            try {
              await fetch(`/api/media/tv/show/${encodeURIComponent(show.title)}?deleteFiles=true&confirmed=true`, {
                method: 'DELETE',
              });
              setConfirmModal(prev => ({ ...prev, isOpen: false }));
              router.push('/library');
            } catch (err) {
              console.error('Failed to delete:', err);
              setIsDeleting(false);
              setConfirmModal(prev => ({ ...prev, isOpen: false }));
            }
          },
        });
      } else {
        // Deletion was immediate (shouldn't happen, but handle it)
        router.push('/library');
      }
    } catch (err) {
      console.error('Failed to delete:', err);
      setIsDeleting(false);
    }
  };

  const toggleSeason = (season: number) => {
    const newExpanded = new Set(expandedSeasons);
    if (newExpanded.has(season)) {
      newExpanded.delete(season);
    } else {
      newExpanded.add(season);
    }
    setExpandedSeasons(newExpanded);
  };

  const openDownloadModal = (mode: 'complete' | 'season' | 'episode', season?: number, episode?: Episode) => {
    setDownloadMode(mode);
    if (season) {
      setSelectedSeasonForDownload(season);
    }
    if (episode) {
      setSelectedEpisodeForDownload(episode);
      setSelectedSeasonForDownload(episode.season);
    } else {
      setSelectedEpisodeForDownload(null);
    }
    setShowDownloadModal(true);
  };

  // State for notification messages
  const [notification, setNotification] = useState<{ type: 'success' | 'info'; message: string } | null>(null);
  
  interface DetectedEpisodes {
    type: string;
    isComplete: boolean;
    seasons: number[];
    episodes: Array<{ season: number; episode: number }>;
    description: string;
  }
  
  const handleDownload = async (magnetUri: string, detected?: DetectedEpisodes) => {
    if (!show) return;
    
    try {
      // Handle single episode download
      if (downloadMode === 'episode' && selectedEpisodeForDownload) {
        const episode = selectedEpisodeForDownload;
        
        if (episode.filePath && episode.diskPath) {
          setNotification({ type: 'info', message: 'Episode is already downloaded!' });
          setShowDownloadModal(false);
          setTimeout(() => setNotification(null), 3000);
          return;
        }
        
        const wantedEpisodes = [{ season: episode.season, episode: episode.episode }];
        const detectedEpisodes = detected || {
          type: 'episode',
          isComplete: false,
          seasons: [episode.season],
          episodes: wantedEpisodes,
          description: `S${String(episode.season).padStart(2, '0')}E${String(episode.episode).padStart(2, '0')}`,
        };
        
        await api.startDownload(episode.id, magnetUri, detectedEpisodes, wantedEpisodes);
        
        setShowDownloadModal(false);
        setSelectedEpisodeForDownload(null);
        setNotification({ type: 'success', message: `Download started for S${episode.season}E${episode.episode}` });
        setTimeout(() => setNotification(null), 3000);
        loadShowDetails();
        return;
      }
      
      // For complete series or season pack downloads, we need to start downloads
      // for all relevant episodes.
      
      // Get all episodes that need downloading based on mode
      const episodesToDownload = downloadMode === 'complete' 
        ? show.episodes.filter(ep => !ep.filePath && !ep.diskPath)
        : show.episodes.filter(ep => ep.season === selectedSeasonForDownload && !ep.filePath && !ep.diskPath);
      
      if (episodesToDownload.length === 0) {
        setNotification({ type: 'info', message: 'All episodes are already downloaded!' });
        setShowDownloadModal(false);
        setTimeout(() => setNotification(null), 3000);
        return;
      }
      
      // Build the list of wanted episodes - this is the explicit list of all episodes we want
      const wantedEpisodes = episodesToDownload.map(ep => ({ 
        season: ep.season, 
        episode: ep.episode 
      }));
      
      // Build detected episodes info if not provided
      // Include the wanted episodes in the detected info for proper tracking
      const detectedEpisodes = detected || {
        type: downloadMode === 'complete' ? 'complete' : 'season',
        isComplete: downloadMode === 'complete',
        seasons: downloadMode === 'complete' 
          ? Array.from(new Set(episodesToDownload.map(ep => ep.season)))
          : [selectedSeasonForDownload],
        episodes: wantedEpisodes, // Always include the full list of wanted episodes
        description: downloadMode === 'complete' 
          ? 'Complete Series' 
          : `Season ${selectedSeasonForDownload}`,
      };
      
      // Start download for the first episode (the torrent will be used for all)
      // The download manager should handle distributing files to the right episodes
      // Pass wantedEpisodes explicitly to ensure all episodes are downloaded
      const firstEpisode = episodesToDownload[0];
      console.log(`[TVShowPage] Starting season download for ${wantedEpisodes.length} episodes:`, wantedEpisodes);
      await api.startDownload(firstEpisode.id, magnetUri, detectedEpisodes, wantedEpisodes);
      
      setShowDownloadModal(false);
      setNotification({ type: 'success', message: `Download started for ${episodesToDownload.length} episode(s)` });
      setTimeout(() => setNotification(null), 3000);
      loadShowDetails(); // Refresh to show download status
    } catch (err) {
      console.error('Failed to start download:', err);
    }
  };

  const getEpisodeStatus = (episode: Episode): { label: string; color: string } => {
    if (episode.filePath && episode.diskPath) {
      return { label: 'Available', color: 'text-green-400' };
    }
    
    const download = episode.downloads?.[0];
    if (download) {
      if (download.status === 'completed') {
        return { label: 'Downloaded', color: 'text-green-400' };
      }
      if (download.status === 'downloading') {
        return { label: `${download.progress.toFixed(0)}%`, color: 'text-primary-400' };
      }
      if (download.status === 'pending') {
        return { label: 'Pending', color: 'text-yellow-400' };
      }
      if (download.status === 'paused') {
        return { label: 'Paused', color: 'text-yellow-400' };
      }
      if (download.status === 'failed') {
        return { label: 'Failed', color: 'text-red-400' };
      }
    }
    
    return { label: 'Not Downloaded', color: 'text-slate-400' };
  };

  // Group episodes by season
  const episodesBySeason = show?.episodes.reduce((acc, episode) => {
    const season = episode.season || 1;
    if (!acc[season]) {
      acc[season] = [];
    }
    acc[season].push(episode);
    return acc;
  }, {} as Record<number, Episode[]>) || {};

  // Sort seasons
  const sortedSeasons = Object.keys(episodesBySeason).map(Number).sort((a, b) => a - b);

  // Calculate stats
  const totalEpisodes = show?.episodes.length || 0;
  const downloadedEpisodes = show?.episodes.filter(ep => 
    (ep.filePath && ep.diskPath) || ep.downloads?.some(d => d.status === 'completed')
  ).length || 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-12 h-12 animate-spin text-primary-500" />
      </div>
    );
  }

  if (error || !show) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen text-center px-4">
        <XCircle className="w-16 h-16 text-red-500 mb-4" />
        <h2 className="text-2xl font-bold mb-2">Error Loading TV Show</h2>
        <p className="text-slate-400 mb-4">{error || 'TV show not found'}</p>
        <Link href="/library" className="btn-primary">
          Back to Library
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-12">
      {/* Back Button */}
      <Link 
        href="/library" 
        className="inline-flex items-center gap-2 text-slate-400 hover:text-white mb-6"
      >
        <ArrowLeft className="w-5 h-5" />
        Back to Library
      </Link>

      {/* Header */}
      <div className="flex flex-col md:flex-row gap-8 mb-8">
        {/* Poster */}
        <div className="w-full md:w-64 flex-shrink-0">
          <div className="relative aspect-[2/3] bg-slate-700 rounded-lg overflow-hidden">
            {show.posterUrl ? (
              <Image
                src={show.posterUrl}
                alt={show.title}
                fill
                className="object-cover"
                priority
              />
            ) : (
              <div className="flex items-center justify-center h-full">
                <Tv className="w-16 h-16 text-slate-500" />
              </div>
            )}
          </div>
        </div>

        {/* Info */}
        <div className="flex-grow">
          <div className="flex items-center gap-3 text-primary-400 mb-2">
            <Tv className="w-6 h-6" />
            <span className="capitalize">TV Show</span>
            {show.pinned && (
              <span className="px-2 py-1 bg-yellow-600 text-xs rounded">Pinned</span>
            )}
          </div>

          <h1 className="text-3xl font-bold mb-2">
            {show.year ? `${show.title} (${show.year})` : show.title}
          </h1>

          {/* Stats */}
          <div className="flex flex-wrap gap-4 text-slate-400 mb-4">
            <div className="flex items-center gap-1">
              <Calendar className="w-4 h-4" />
              <span>{show.year || 'Unknown year'}</span>
            </div>
            <div className="flex items-center gap-1">
              <HardDrive className="w-4 h-4" />
              <span>{downloadedEpisodes}/{totalEpisodes} episodes downloaded</span>
            </div>
            {show.totalSeasons && (
              <div className="flex items-center gap-1">
                <span>{show.totalSeasons} season{show.totalSeasons !== 1 ? 's' : ''}</span>
              </div>
            )}
          </div>

          {/* Plot */}
          {show.plot && (
            <p className="text-slate-300 mb-6 max-w-2xl">{show.plot}</p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            {downloadedEpisodes > 0 && (
              <a 
                href="/jellyfin-redirect" 
                className="btn-primary flex items-center gap-2"
              >
                <Play className="w-5 h-5" />
                Watch in Jellyfin
              </a>
            )}

            {/* Download Complete Series */}
            {downloadedEpisodes < totalEpisodes && (
              <button
                onClick={() => openDownloadModal('complete')}
                className="btn-primary flex items-center gap-2"
              >
                <Download className="w-5 h-5" />
                Download Series
              </button>
            )}

            <button
              onClick={handlePin}
              disabled={isPinning}
              className="btn-secondary flex items-center gap-2"
            >
              {isPinning ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : show.pinned ? (
                <PinOff className="w-5 h-5" />
              ) : (
                <Pin className="w-5 h-5" />
              )}
              {show.pinned ? 'Unpin' : 'Pin'}
            </button>

            {show.imdbId && (
              <a
                href={`https://www.imdb.com/title/${show.imdbId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
              >
                IMDb
              </a>
            )}

            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="btn-secondary text-red-400 hover:text-red-300 flex items-center gap-2"
            >
              {isDeleting ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Trash2 className="w-5 h-5" />
              )}
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Episodes by Season */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold">Episodes</h2>
        
        {sortedSeasons.map(season => {
          const seasonEpisodes = episodesBySeason[season];
          const downloadedInSeason = seasonEpisodes.filter(ep => 
            (ep.filePath && ep.diskPath) || ep.downloads?.some(d => d.status === 'completed')
          ).length;
          const allDownloaded = downloadedInSeason === seasonEpisodes.length;
          
          return (
            <div key={season} className="bg-slate-800 rounded-lg overflow-hidden">
              {/* Season Header */}
              <div className="flex items-center justify-between p-4 hover:bg-slate-700 transition-colors">
                <button
                  onClick={() => toggleSeason(season)}
                  className="flex items-center gap-3 flex-1"
                >
                  {expandedSeasons.has(season) ? (
                    <ChevronDown className="w-5 h-5" />
                  ) : (
                    <ChevronRight className="w-5 h-5" />
                  )}
                  <span className="font-semibold">Season {season}</span>
                  <span className="text-slate-400 text-sm">
                    {seasonEpisodes.length} episodes
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-400">
                    {downloadedInSeason} downloaded
                  </span>
                  {!allDownloaded && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openDownloadModal('season', season);
                      }}
                      className="btn-primary text-sm py-1 px-3 flex items-center gap-1"
                    >
                      <Download className="w-4 h-4" />
                      Download Season
                    </button>
                  )}
                </div>
              </div>

              {/* Episode List */}
              {expandedSeasons.has(season) && (
                <div className="border-t border-slate-700">
                  {episodesBySeason[season]
                    .sort((a, b) => (a.episode || 0) - (b.episode || 0))
                    .map(episode => {
                      const status = getEpisodeStatus(episode);
                      const isAvailable = episode.filePath && episode.diskPath;
                      const isDownloading = episode.downloads?.some(
                        d => d.status === 'downloading' || d.status === 'pending'
                      );
                      
                      return (
                        <div
                          key={episode.id}
                          className="flex items-center justify-between p-4 hover:bg-slate-700 transition-colors border-b border-slate-700 last:border-b-0"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-slate-400 w-16">
                              E{String(episode.episode).padStart(2, '0')}
                            </span>
                            <span>{episode.title}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className={status.color}>{status.label}</span>
                            {isAvailable ? (
                              <a
                                href="/jellyfin-redirect"
                                className="btn-primary text-sm py-1 px-3 flex items-center gap-1"
                              >
                                <Play className="w-4 h-4" />
                                Watch
                              </a>
                            ) : !isDownloading ? (
                              <button
                                onClick={() => openDownloadModal('episode', episode.season, episode)}
                                className="btn-secondary text-sm py-1 px-3 flex items-center gap-1"
                              >
                                <Download className="w-4 h-4" />
                                Download
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Download Modal */}
      {showDownloadModal && show && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">
                {downloadMode === 'complete' 
                  ? `Download ${show.title} - Complete Series`
                  : downloadMode === 'episode' && selectedEpisodeForDownload
                    ? `Download ${show.title} - S${String(selectedEpisodeForDownload.season).padStart(2, '0')}E${String(selectedEpisodeForDownload.episode).padStart(2, '0')}`
                    : `Download ${show.title} - Season ${selectedSeasonForDownload}`
                }
              </h2>
              <button
                onClick={() => {
                  setShowDownloadModal(false);
                  setSelectedEpisodeForDownload(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <TorrentSearch
              title={show.title}
              year={show.year?.toString() || ''}
              type="series"
              season={downloadMode === 'season' ? selectedSeasonForDownload : 
                      downloadMode === 'episode' && selectedEpisodeForDownload ? selectedEpisodeForDownload.season : undefined}
              episode={downloadMode === 'episode' && selectedEpisodeForDownload ? selectedEpisodeForDownload.episode : undefined}
              defaultSearchMode={downloadMode === 'episode' ? 'episode' : downloadMode}
              totalSeasons={show.totalSeasons}
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

      {/* Notification Toast */}
      {notification && (
        <div className={`fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${
          notification.type === 'success' ? 'bg-green-600' : 'bg-blue-600'
        }`}>
          <p className="text-white font-medium">{notification.message}</p>
        </div>
      )}
    </div>
  );
}

export default function TVShowDetailsPage() {
  const params = useParams();
  const id = params.id as string;

  return (
    <ErrorBoundary>
      <TVShowDetailsContent id={id} />
    </ErrorBoundary>
  );
}
