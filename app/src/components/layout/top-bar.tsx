'use client';
/**
 * TopBar — dashboard top bar (CPD-111, CPD-117).
 * Left:  hamburger (mobile only)
 * Right: notifications bell | AuraFlux Collab toggle | UserButton
 */

import { UserButton, useAuth } from '@clerk/nextjs';
import { useGuide } from '@/contexts/guide-context';
import { useSidebar } from '@/contexts/sidebar-context';
import { NotificationsBell } from '@/components/notifications/notifications-bell';
import { useBrand } from '@/contexts/brand-context';
import { cn } from '@/lib/utils';

const COLLAB_LABEL = 'Collab';

export function TopBar() {
  const { toggle, isOpen } = useGuide();
  const { openMobile }     = useSidebar();
  const { actor }          = useAuth();
  const { activeBrand, brands, setActiveBrand } = useBrand();
  const collabLabel        = COLLAB_LABEL;

  const isSubBrand  = activeBrand && activeBrand.is_primary === false;
  const primaryBrand = brands.find((b) => b.is_primary) ?? null;
  const hasBanners  = !!(actor || isSubBrand);

  return (
    <header className={cn('shrink-0 border-b border-border bg-card/50 backdrop-blur-sm flex flex-col px-4', hasBanners ? 'h-auto' : 'h-12')}>
      {/* Actor warp banner — visible when an admin is signed in as a customer */}
      {actor && (
        <div className="w-full bg-amber-500/10 border-b border-amber-500/20 py-1.5 flex items-center justify-center gap-3 text-xs text-amber-700">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Acting as another account
          <UserButton />
        </div>
      )}
      {/* Sub-brand context bar — visible when viewing a non-primary brand */}
      {isSubBrand && (
        <div className="w-full bg-indigo-500/8 border-b border-indigo-500/20 py-1 flex items-center justify-center gap-2.5 text-xs text-indigo-400">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
          </svg>
          <span className="text-indigo-300 opacity-60">Viewing</span>
          <span className="font-semibold text-indigo-200">{activeBrand.name}</span>
          {primaryBrand && (
            <button
              onClick={() => setActiveBrand(primaryBrand)}
              className="ml-2 flex items-center gap-1 px-2 py-0.5 rounded border border-indigo-400/30 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors opacity-80 hover:opacity-100"
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              Switch to {primaryBrand.name}
            </button>
          )}
        </div>
      )}
      <div className="flex-1 flex items-center justify-between gap-3 h-12">
      {/* Hamburger — mobile only */}
      <button
        onClick={openMobile}
        className="md:hidden flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        aria-label="Open menu"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6"  x2="21" y2="6"  />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      <div className="hidden md:block" />

      {/* Right cluster */}
      <div className="flex items-center gap-3">
        <NotificationsBell />

        <button
          onClick={toggle}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors',
            isOpen
              ? 'bg-primary text-primary-foreground border-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
          )}
          aria-label={isOpen ? 'Close Collab' : 'Open Collab'}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {collabLabel}
        </button>

        {!actor && <UserButton />}
      </div>
    </div>
    </header>
  );
}
