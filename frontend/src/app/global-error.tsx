'use client';

import { useEffect } from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';

interface GlobalErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorPageProps) {
  useEffect(() => {
    console.error('Global application error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-slate-900 text-white min-h-screen flex items-center justify-center">
        <div className="text-center p-8">
          <AlertOctagon className="w-20 h-20 mb-6 text-red-500 mx-auto" />
          <h1 className="text-2xl font-bold mb-3">Application Error</h1>
          <p className="text-slate-400 mb-6 max-w-md mx-auto">
            A critical error occurred. Please refresh the page or try again later.
          </p>
          
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh Page
          </button>
        </div>
      </body>
    </html>
  );
}
