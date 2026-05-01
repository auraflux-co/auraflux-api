'use client';
/**
 * AuraFlux Guide — persistent slide-out panel (CPD-111).
 * Accessible from any dashboard page via the top bar button.
 * Renders the ConciergeChat inline.
 */

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useGuide } from '@/contexts/guide-context';
import { ConciergeChat } from '@/components/concierge/concierge-chat';

export function GuidePanel() {
  const { isOpen, close } = useGuide();

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <>
      {/* Backdrop (mobile / small screens) */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/40 backdrop-blur-sm lg:hidden"
          onClick={close}
        />
      )}

      {/* Slide-out panel */}
      <aside
        className={cn(
          'fixed top-0 right-0 z-40 h-screen w-[380px] max-w-[90vw]',
          'border-l border-border bg-card shadow-2xl',
          'flex flex-col',
          'transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div>
            <p className="text-sm font-semibold">AuraFlux Guide</p>
            <p className="text-[10px] text-muted-foreground">Ask anything about your content production</p>
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

        {/* Chat — fills remaining height */}
        <div className="flex-1 min-h-0">
          <ConciergeChat
            currentSpec={{}}
            className="h-full rounded-none border-0 shadow-none"
          />
        </div>
      </aside>
    </>
  );
}
