'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, X, ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';

interface SystemStatusData {
  omdb: {
    configured: boolean;
    message: string;
  };
  vpn: {
    available: boolean;
    message: string;
  };
  storage: {
    configured: boolean;
    disks: number;
    message: string;
  };
  issues: string[];
  healthy: boolean;
}

export function SystemStatus() {
  const [status, setStatus] = useState<SystemStatusData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await api.getSystemStatus();
        setStatus(data);
      } catch (error) {
        console.error('Failed to fetch system status:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
  }, []);

  if (loading || !status || status.healthy || dismissed) {
    return null;
  }

  return (
    <div className="bg-yellow-900/50 border border-yellow-600 rounded-lg p-4 mb-6">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-yellow-200">Setup Required</h3>
            <p className="text-yellow-300/80 text-sm mt-1">
              Some features are unavailable until you complete the initial setup.
            </p>
            <ul className="mt-3 space-y-2">
              {status.issues.map((issue, index) => (
                <li key={index} className="flex items-start gap-2 text-sm">
                  <span className="text-yellow-400">•</span>
                  <span className="text-yellow-200">
                    {issue}
                    {issue.includes('omdbapi.com') && (
                      <a
                        href="https://www.omdbapi.com/apikey.aspx"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1 inline-flex items-center gap-1 text-yellow-400 hover:text-yellow-300 underline"
                      >
                        Get API Key <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex gap-4 text-sm">
              <a
                href="/settings"
                className="text-yellow-400 hover:text-yellow-300 underline"
              >
                Go to Settings
              </a>
            </div>
          </div>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-yellow-500 hover:text-yellow-400"
          aria-label="Dismiss"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

export function SystemStatusBadge() {
  const [status, setStatus] = useState<SystemStatusData | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const data = await api.getSystemStatus();
        setStatus(data);
      } catch (error) {
        console.error('Failed to fetch system status:', error);
      }
    };

    fetchStatus();
  }, []);

  if (!status) {
    return null;
  }

  if (status.healthy) {
    return (
      <div className="flex items-center gap-2 text-green-400 text-sm">
        <CheckCircle className="w-4 h-4" />
        <span>All systems ready</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-yellow-400 text-sm">
      <AlertTriangle className="w-4 h-4" />
      <span>{status.issues.length} issue{status.issues.length !== 1 ? 's' : ''} require attention</span>
    </div>
  );
}
