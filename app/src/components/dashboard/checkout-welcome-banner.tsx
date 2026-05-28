'use client';
/**
 * CheckoutWelcomeBanner — CPD-401
 * Shown on /home when ?checkout=success is in the URL (first subscription).
 * Reads the query param client-side, cleans it from the URL, auto-dismisses.
 */

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';

export function CheckoutWelcomeBanner({ firstName }: { firstName: string }) {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (searchParams.get('checkout') === 'success') {
      setVisible(true);
      router.replace('/home');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/8 px-5 py-4 flex items-start justify-between gap-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">
          Welcome to AuraFlux, {firstName}! 🎉
        </p>
        <p className="text-sm text-muted-foreground">
          Your subscription is confirmed. Start by connecting a channel and running your first job.
        </p>
        <div className="flex gap-3 pt-1">
          <Link
            href="/myjobs/new"
            className="text-sm font-medium text-primary hover:underline underline-offset-2"
          >
            Start a job →
          </Link>
          <Link
            href="/settings/channels"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Connect a channel
          </Link>
        </div>
      </div>
      <button
        onClick={() => setVisible(false)}
        className="shrink-0 text-muted-foreground/60 hover:text-muted-foreground transition-colors text-sm mt-0.5"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
