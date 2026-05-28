'use client';
/**
 * CheckoutWelcomeBanner — CPD-401 / CPD-403
 * Shown on /home when ?checkout=success is in the URL.
 *
 * CPD-403 pay-first flow: if ?session_id=cs_xxx is also present, the user
 * paid on the marketing site before creating an account. We call
 * POST /api/credits/claim-checkout to activate their plan, then clear the URL.
 */

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';

export function CheckoutWelcomeBanner({ firstName }: { firstName: string }) {
  const searchParams  = useSearchParams();
  const router        = useRouter();
  const { getToken }  = useAuth();
  const [visible, setVisible]   = useState(false);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (searchParams.get('checkout') !== 'success') return;
    const sessionId = searchParams.get('session_id');

    async function claimAndShow() {
      // CPD-403: if a Stripe session_id is present, claim the pending subscription
      if (sessionId) {
        setClaiming(true);
        try {
          const token = await getToken();
          if (token) {
            await fetch(`${process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com'}/credits/claim-checkout`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body:    JSON.stringify({ session_id: sessionId }),
            });
          }
        } catch { /* non-fatal — plan may already be applied via webhook */ }
        setClaiming(false);
      }
      setVisible(true);
      router.replace('/home');
    }

    claimAndShow();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (claiming) return (
    <div className="rounded-lg border border-border bg-card/50 px-5 py-4 text-sm text-muted-foreground animate-pulse">
      Activating your subscription…
    </div>
  );

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
