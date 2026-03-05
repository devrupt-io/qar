'use client';

import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Play } from 'lucide-react';
import { api } from '@/lib/api';

export default function JellyfinRedirectPage() {
  const [status, setStatus] = useState<'loading' | 'setting-up' | 'redirecting' | 'error'>('loading');
  const [message, setMessage] = useState('Checking Jellyfin status...');
  const [errorDetails, setErrorDetails] = useState<string | null>(null);

  useEffect(() => {
    async function handleJellyfin() {
      try {
        // First check Jellyfin status
        const jellyfinStatus = await api.getJellyfinStatus();

        if (!jellyfinStatus.available) {
          setStatus('error');
          setMessage('Jellyfin is not available');
          setErrorDetails('The Jellyfin server is not running. Please check your Docker containers.');
          return;
        }

        // If not configured, run auto-setup
        if (!jellyfinStatus.configured) {
          setStatus('setting-up');
          setMessage('Setting up Jellyfin for first use...');
          
          const setupResult = await api.setupJellyfin();
          if (!setupResult.success) {
            setStatus('error');
            setMessage('Jellyfin setup failed');
            setErrorDetails(setupResult.message);
            return;
          }
        }

        // Get token and redirect URL from backend
        setStatus('redirecting');
        setMessage('Redirecting to Jellyfin...');

        try {
          const tokenData = await api.getJellyfinToken();
          
          // Redirect to Jellyfin's redirect page (served from Jellyfin's origin)
          // This page will set localStorage and redirect to the Jellyfin home
          window.location.href = tokenData.redirectUrl;
        } catch (e) {
          // No token available, just redirect to Jellyfin directly using current hostname
          const jellyfinUrl = `${window.location.protocol}//${window.location.hostname}:8096`;
          window.location.href = jellyfinUrl;
        }
      } catch (error: any) {
        setStatus('error');
        setMessage('Failed to connect to Jellyfin');
        setErrorDetails(error.message || 'Unknown error');
      }
    }

    handleJellyfin();
  }, []);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="card max-w-md w-full text-center">
        {status === 'loading' || status === 'setting-up' || status === 'redirecting' ? (
          <>
            <Loader2 className="w-12 h-12 animate-spin text-primary-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">
              {status === 'setting-up' ? 'Setting Up Jellyfin' : 'Connecting to Jellyfin'}
            </h2>
            <p className="text-slate-400">{message}</p>
          </>
        ) : status === 'error' ? (
          <>
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">{message}</h2>
            {errorDetails && (
              <p className="text-slate-400 mb-4">{errorDetails}</p>
            )}
            <button
              onClick={() => window.location.reload()}
              className="btn-primary"
            >
              Try Again
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
