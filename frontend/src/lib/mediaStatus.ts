/**
 * Single source of truth for computing media item download/availability status.
 *
 * Every UI surface (library grid, movie detail, TV episode detail) must use
 * these helpers so the displayed badge is always consistent.
 */

export interface StatusBadge {
  label: string;
  color: string;
}

export interface DownloadInfo {
  status: string;
  progress: number;
  completedAt?: string;
}

export interface StatusableItem {
  hasFile?: boolean;
  downloads?: DownloadInfo[];
}

export interface TVShowStatusableItem {
  totalEpisodes?: number;
  downloadedEpisodes?: number;
  downloadingEpisodes?: number;
}

/**
 * Get the status badge for a single media item (movie, web, or individual episode).
 *
 * Relies on the `hasFile` boolean returned by the backend which performs an
 * actual filesystem check.  Never checks `filePath`/`diskPath` directly —
 * those DB fields can be stale.
 */
export function getMediaStatus(item: StatusableItem): StatusBadge {
  if (item.hasFile) {
    return { label: 'Available', color: 'bg-green-500' };
  }

  const download = item.downloads?.[0];
  if (download) {
    if (download.status === 'completed') {
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
}

/**
 * Get the status badge for a TV show (aggregated episode counts).
 *
 * The backend computes `downloadedEpisodes` with filesystem verification,
 * so these counts are trustworthy.
 */
export function getTvShowStatus(item: TVShowStatusableItem): StatusBadge {
  const downloaded = item.downloadedEpisodes || 0;
  const total = item.totalEpisodes || 0;

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

/**
 * Variant of getMediaStatus that returns text-* colors instead of bg-*
 * for use in inline text contexts (e.g. TV episode rows).
 */
export function getMediaStatusText(item: StatusableItem): StatusBadge {
  if (item.hasFile) {
    return { label: 'Available', color: 'text-green-400' };
  }

  const download = item.downloads?.[0];
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
}
