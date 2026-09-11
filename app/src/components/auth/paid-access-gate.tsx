'use client';

/**
 * PaidAccessGate — after login, require an active Stripe subscription
 * (or superadmin). Unpaid users are sent to auraflux.co/pricing.
 * Checkout handoff (?session_id=) is allowed through so claim can run.
 */

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/clerk-compat';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

export function PaidAccessGate({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [state, setState] = useState<'checking' | 'ok' | 'blocked'>('checking');

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setState('ok');
      return;
    }

    // Allow claim handoff through without blocking
    if (searchParams.get('session_id') && searchParams.get('checkout') === 'success') {
      setState('ok');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) {
          if (!cancelled) setState('ok');
          return;
        }
        const res = await fetch(`${API_BASE}/credits/access`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data.paid) {
          setState('ok');
        } else {
          setState('blocked');
          const next = encodeURIComponent(pathname || '/home');
          window.location.href = `https://auraflux.co/pricing?paywall=1&next=${next}`;
        }
      } catch {
        if (!cancelled) setState('ok'); // fail open on network blip for superadmin ops
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken, pathname, searchParams]);

  if (state === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Checking subscription…
      </div>
    );
  }

  if (state === 'blocked') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Redirecting to pricing…
      </div>
    );
  }

  return <>{children}</>;
}
