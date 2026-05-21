'use client';
/**
 * AuraFlux Guide — inline right panel (CPD-111, CPD-113).
 *
 * Renders as a right-side column within the page layout.
 * When a contextHint is set (e.g. from the job wizard), a pinned
 * banner shows at the top so the guide knows what you're working on.
 */

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useGuide } from '@/contexts/guide-context';
import { usePlan } from '@/contexts/plan-context';
import { ConciergeChat } from '@/components/concierge/concierge-chat';

export function GuidePanel() {
  const { isOpen, close, contextHint } = useGuide();
  const { planTier } = usePlan();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <aside
      className={cn(
        'shrink-0 border-l border-border bg-card flex flex-col overflow-hidden',
        'transition-[width] duration-300 ease-in-out',
        isOpen ? 'w-[360px]' : 'w-0 border-l-0',
      )}
    >
      {isOpen && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div>
              <p className="text-sm font-semibold">Collab</p>
              <p className="text-[10px] text-muted-foreground">Your guided setup assistant</p>
            </div>
            <button
              onClick={close}
              className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
              aria-label="Close guide"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Context hint banner — shown when the guide knows what you're working on */}
          {contextHint && (
            <div className="mx-3 mt-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3.5 shrink-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-primary mb-1.5">Active context</p>
              <p className="text-sm text-foreground leading-relaxed">{contextHint}</p>
            </div>
          )}

          {/* Chat */}
          <div className="flex-1 min-h-0">
            <ConciergeChat
              embedded
              currentSpec={{}}
              planTier={planTier ?? undefined}
              className="h-full rounded-none border-0 shadow-none"
            />
          </div>
        </>
      )}
    </aside>
  );
}
