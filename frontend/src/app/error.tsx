'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import Link from 'next/link';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    // Log the error to the console for debugging
    console.error('Application error:', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
      <AlertTriangle className="w-20 h-20 mb-6 text-yellow-500" />
      <h1 className="text-2xl font-bold mb-3">Something went wrong</h1>
      <p className="text-slate-400 mb-6 max-w-md">
        An unexpected error occurred. You can try again or return to the home page.
      </p>
      
      {process.env.NODE_ENV === 'development' && (
        <details className="mb-6 text-left max-w-lg w-full">
          <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-300">
            Error Details
          </summary>
          <pre className="mt-2 p-4 bg-slate-800 rounded-lg text-xs text-red-400 overflow-auto max-h-48">
            {error.message}
            {error.digest && `\nDigest: ${error.digest}`}
            {'\n'}
            {error.stack}
          </pre>
        </details>
      )}
      
      <div className="flex gap-4">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary-600 hover:bg-primary-700 rounded-lg font-medium transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try Again
        </button>
        
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-lg font-medium transition-colors"
        >
          <Home className="w-4 h-4" />
          Home
        </Link>
      </div>
    </div>
  );
}
