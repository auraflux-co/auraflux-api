'use client';
/**
 * Admin error boundary — captures render errors for /admin/* routes
 * and displays them in plain text so we can diagnose the crash.
 * Remove this file once the root cause of the /admin/overview crash is fixed.
 */

import { useEffect } from 'react';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin error boundary]', error);
  }, [error]);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold text-destructive">Admin page error</h2>
      <pre className="text-xs bg-muted p-4 rounded overflow-auto max-h-64 whitespace-pre-wrap">
        {error.message}
        {'\n\n'}
        {error.stack}
      </pre>
      <button
        onClick={reset}
        className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted"
      >
        Try again
      </button>
    </div>
  );
}
