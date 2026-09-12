'use client';

/**
 * PaidAccessGate — after login, require an active customer subscription
 * (or superadmin). Unpaid users stay on-app with sign-in / plans choices.
 * Checkout handoff (?session_id=) is allowed through so claim can run.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAuth, useUser } from '@/lib/clerk-compat';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

const PAID_CACHE_KEY = 'auraflux_paid_access';

function readPaidCache(): 'ok' | null {
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(PAID_CACHE_KEY) === 'paid' ? 'ok' : null;
  } catch {
    return null;
  }
}

function writePaidCache(paid: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (paid) sessionStorage.setItem(PAID_CACHE_KEY, 'paid');
    else sessionStorage.removeItem(PAID_CACHE_KEY);
  } catch { /* ignore */ }
}

export function PaidAccessGate({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, isLoaded, signOut } = useAuth();
  const { user } = useUser();
  const searchParams = useSearchParams();
  // Optimistic: if this tab already confirmed paid, skip the full-screen wait on refresh
  const [state, setState] = useState<'checking' | 'ok' | 'blocked'>(() => readPaidCache() ?? 'checking');

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      writePaidCache(false);
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
          writePaidCache(true);
          setState('ok');
        } else {
          writePaidCache(false);
          setState('blocked');
        }
      } catch {
        if (!cancelled) setState('ok'); // fail open on network blip
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken, searchParams]);

  if (state === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground bg-background">
        Checking creator access…
      </div>
    );
  }

  if (state === 'blocked') {
    const email = user?.email || user?.primaryEmailAddress?.emailAddress;
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 font-sans antialiased">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-5 text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-400">
            Creator access
          </p>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">
            Creator plan required
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            You&apos;re signed in
            {email ? (
              <>
                {' '}
                as <span className="text-slate-200 font-medium">{email}</span>
              </>
            ) : null}
            , but this account doesn&apos;t have an active creator subscription yet.
            Sign in with a creator account, or get a plan — we won&apos;t send you away
            automatically.
          </p>
          <div className="space-y-3 pt-2">
            <button
              type="button"
              className="w-full flex items-center justify-center bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3.5 px-4 rounded-xl transition-all text-sm"
              onClick={() => {
                void signOut().then(() => {
                  window.location.href = '/sign-in?redirect_url=%2Fhome';
                });
              }}
            >
              Sign in as a customer →
            </button>
            <a
              href="https://auraflux.co/pricing"
              className="w-full flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold py-3.5 px-4 rounded-xl transition-all text-xs tracking-wide"
            >
              View plans on auraflux.co
            </a>
            <Link
              href="/login"
              className="block text-xs text-slate-500 hover:text-amber-400 transition-colors pt-1"
            >
              Back to portal entry
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
