'use client';

import { HardDrive } from 'lucide-react';

interface Disk {
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

interface Props {
  disks: Disk[];
  loading: boolean;
}

export default function DiskStats({ disks, loading }: Props) {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getUsageColor = (percent: number): string => {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 75) return 'bg-yellow-500';
    return 'bg-primary-500';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (disks.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400">
        <HardDrive className="w-12 h-12 mx-auto mb-2 opacity-50" />
        <p>No disks configured</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {disks.map(disk => (
        <div key={disk.name} className="bg-slate-700/50 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <HardDrive className="w-6 h-6 text-primary-400" />
            <div>
              <h3 className="font-medium">Disk {disk.name.toUpperCase()}</h3>
              <p className="text-xs text-slate-400">{disk.path}</p>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="relative h-3 bg-slate-600 rounded-full overflow-hidden mb-2">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all ${getUsageColor(disk.usedPercent)}`}
              style={{ width: `${disk.usedPercent}%` }}
            />
          </div>

          {/* Stats */}
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">
              {formatBytes(disk.usedBytes)} used
            </span>
            <span className="text-slate-400">
              {formatBytes(disk.freeBytes)} free
            </span>
          </div>
          <div className="text-right text-sm font-medium mt-1">
            {disk.usedPercent.toFixed(1)}% of {formatBytes(disk.totalBytes)}
          </div>
        </div>
      ))}
    </div>
  );
}
