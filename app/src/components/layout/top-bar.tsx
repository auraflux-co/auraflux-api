'use client';
/**
 * TopBar — dashboard top bar (CPD-111).
 * Shows credit counter (links to billing) and AuraFlux Guide toggle.
 */

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { UserButton } from '@clerk/nextjs';
import { useGuide } from '@/contexts/guide-context';
import { getCreditBalance, type CreditBalance } from '@/lib/api';
import { cn } from '@/lib/utils';

function CreditPill() {
  const { getToken } = useAuth();
  const [balance, setBalance] = useState<CreditBalance | null>(null);

  const fetch = useCallback(async () => {
    try {
      const token = await getToken();
      const b = await getCreditBalance(token ?? undefined);
      setBalance(b);
    } catch { /* non-fatal */ }
  }, [getToken]);

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 60_000);
    return () => clearInterval(t);
  }, [fetch]);

  if (!balance) return null;

  const used  = balance.included_total - balance.included_remaining;
  const total = balance.included_total;
  const pct   = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const nearLimit = pct >= 80;

  return (
    <Link
      href="/dashboard/billing"
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs transition-colors',
        'hover:border-border/80 hover:bg-accent/50',
        nearLimit
          ? 'border-yellow-500/40 bg-yellow-500/5 text-yellow-600 dark:text-yellow-400'
          : 'border-border bg-card text-muted-foreground',
      )}
    >
      {/* Mini progress arc */}
      <span className={cn('font-semibold tabular-nums', nearLimit ? '' : 'text-foreground')}>
        {used.toLocaleString()}
      </span>
      <span>/</span>
      <span>{total.toLocaleString()} credits</span>
      {nearLimit && <span className="text-[10px]">⚠</span>}
    </Link>
  );
}

export function TopBar() {
  const { toggle, isOpen } = useGuide();

  return (
    <header className="h-12 shrink-0 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-between px-4 gap-3">
      {/* Left — empty or breadcrumb slot */}
      <div />

      {/* Right — credits + guide toggle + user */}
      <div className="flex items-center gap-3">
        <CreditPill />

        <button
          onClick={toggle}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors',
            isOpen
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          AuraFlux Guide
        </button>

        <UserButton />
      </div>
    </header>
  );
}
