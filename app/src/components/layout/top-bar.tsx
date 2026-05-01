'use client';
/**
 * TopBar — dashboard top bar (CPD-111, CPD-114).
 * Static "Credits N" display (loads once, no polling).
 * AuraFlux Copilot toggle. User button.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { UserButton } from '@clerk/nextjs';
import { useGuide } from '@/contexts/guide-context';
import { getCreditBalance } from '@/lib/api';
import { cn } from '@/lib/utils';

function CreditsDisplay() {
  const { getToken } = useAuth();
  const [used, setUsed] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = await getToken();
        if (!token) return;
        const b = await getCreditBalance(token);
        if (!cancelled) setUsed(b.included_total - b.included_remaining);
      } catch { /* non-fatal — show nothing if unavailable */ }
    }
    load();
    return () => { cancelled = true; };
  }, [getToken]);

  return (
    <Link
      href="/dashboard/billing"
      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className="text-xs font-normal">Credits</span>
      <span className="font-semibold tabular-nums text-foreground">
        {used === null ? '—' : used.toLocaleString()}
      </span>
    </Link>
  );
}

export function TopBar() {
  const { toggle, isOpen } = useGuide();

  return (
    <header className="h-12 shrink-0 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-between px-4 gap-3">
      <div />

      <div className="flex items-center gap-4">
        <CreditsDisplay />

        <button
          onClick={toggle}
          title="AuraFlux AI"
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-full border transition-colors',
            isOpen
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        <UserButton />
      </div>
    </header>
  );
}
