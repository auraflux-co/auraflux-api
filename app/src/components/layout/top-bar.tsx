'use client';
/**
 * TopBar — dashboard top bar (CPD-111, CPD-116).
 * Credits moved to sidebar header. Top bar is: AuraFlux Copilot toggle + UserButton.
 */

import { UserButton } from '@clerk/nextjs';
import { useGuide } from '@/contexts/guide-context';
import { cn } from '@/lib/utils';

export function TopBar() {
  const { toggle, isOpen } = useGuide();

  return (
    <header className="h-12 shrink-0 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-end px-4 gap-3">
      <button
        onClick={toggle}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors',
          isOpen
            ? 'bg-primary text-primary-foreground border-primary'
            : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
        )}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        AuraFlux Copilot
      </button>

      <UserButton />
    </header>
  );
}
