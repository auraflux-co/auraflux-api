'use client';
/**
 * AuraFlux Guide — inline right panel (CPD-111, updated CPD-112b).
 *
 * Renders as a right-side column within the page layout (not a fixed overlay).
 * Opens/closes via the top-bar toggle, sliding the content area.
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
    <aside
      className={cn(
        'shrink-0 border-l border-border bg-card flex flex-col overflow-hidden',
        'transition-[width] duration-300 ease-in-out',
        isOpen ? 'w-[360px]' : 'w-0 border-l-0',
      )}
    >
      {/* Only render content when open to avoid invisible tab stops */}
      {isOpen && (
        <>
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

          {/* Chat — fills remaining height, scrolls internally */}
          <div className="flex-1 min-h-0">
            <ConciergeChat
              currentSpec={{}}
              className="h-full rounded-none border-0 shadow-none"
            />
          </div>
        </>
      )}
    </aside>
  );
}
