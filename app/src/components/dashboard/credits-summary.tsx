'use client';
/**
 * CreditsSummary — compact inline credits bar for the dashboard home.
 * Shows remaining included credits, a visual usage bar, and the period
 * renewal date so users always know where they stand without navigating
 * to the full /credits page.
 *
 * Fetches once on mount (no polling — credit balance changes only when
 * a job completes, not on a live basis).
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getCreditBalance, type CreditBalance } from '@/lib/api';

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function CreditsSummary() {
  const { getToken }                         = useAuth();
  const [balance, setBalance]                = useState<CreditBalance | null>(null);
  const [loaded, setLoaded]                  = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const b = await getCreditBalance(token);
        if (!cancelled) setBalance(b);
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  if (!loaded) {
    return (
      <div className="flex items-center gap-3 animate-pulse">
        <div className="h-2 w-40 rounded-full bg-muted" />
        <div className="h-3 w-24 rounded bg-muted" />
      </div>
    );
  }

  if (!balance) return null;

  const total   = balance.included_total;
  const used    = total - balance.included_remaining;
  const pct     = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const warn    = pct >= 75;
  const packLeft = balance.pack_remaining;

  return (
    <Link
      href="/credits"
      className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm hover:opacity-80 transition-opacity"
    >
      {/* Remaining label */}
      <span className={cn('font-medium tabular-nums', warn ? 'text-yellow-500' : 'text-foreground')}>
        {balance.included_remaining.toLocaleString()}
        <span className="font-normal text-muted-foreground"> / {total.toLocaleString()} credits</span>
      </span>

      {/* Progress bar */}
      <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden shrink-0">
        <div
          className={cn('h-full rounded-full transition-all', warn ? 'bg-yellow-500' : 'bg-primary')}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Pack credits (if any) */}
      {packLeft > 0 && (
        <span className="text-xs text-muted-foreground">
          +{packLeft.toLocaleString()} pack
        </span>
      )}

      {/* Renewal */}
      <span className="text-xs text-muted-foreground">
        · Renews {fmt(balance.period_end)}
      </span>

      <span className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">↗</span>
    </Link>
  );
}
