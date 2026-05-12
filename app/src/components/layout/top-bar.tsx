'use client';
/**
 * TopBar — dashboard top bar (CPD-111, CPD-117).
 * Left:  hamburger (mobile only)
 * Right: notifications bell | AuraFlux Collab toggle | UserButton
 */

import { UserButton } from '@clerk/nextjs';
import { usePathname } from 'next/navigation';
import { useGuide } from '@/contexts/guide-context';
import { useSidebar } from '@/contexts/sidebar-context';
import { NotificationsBell } from '@/components/notifications/notifications-bell';
import { cn } from '@/lib/utils';

// Collab only surfaces on job creation, job detail, and review queue pages
const COLLAB_ROUTES = ['/dashboard/jobs', '/dashboard/staging'];
function useCollabVisible() {
  const pathname = usePathname();
  return COLLAB_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'));
}

export function TopBar() {
  const { toggle, isOpen } = useGuide();
  const { openMobile }     = useSidebar();
  const showCollab         = useCollabVisible();

  return (
    <header className="h-12 shrink-0 border-b border-border bg-card/50 backdrop-blur-sm flex items-center justify-between px-4 gap-3">
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

        {showCollab && (
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
            Collab
          </button>
        )}

        <UserButton />
      </div>
    </header>
  );
}
