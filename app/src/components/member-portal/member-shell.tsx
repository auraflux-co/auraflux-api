'use client';

/**
 * Customer member portal chrome — Pavilion MemberShell pattern,
 * AuraFlux brand tokens (navy + gold on warm canvas).
 * Not used for superadmin (legacy sidebar remains for platform tools).
 */

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { UserButton } from '@/lib/clerk-compat';
import { NotificationsBell } from '@/components/notifications/notifications-bell';
import { useGuide } from '@/contexts/guide-context';
import { BrandSwitcher } from '@/components/layout/brand-switcher';
import { GuidePanel } from '@/components/guide/guide-panel';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/home', label: 'Home' },
  { href: '/peaks', label: 'Peaks' },
  { href: '/myjobs', label: 'Jobs' },
  { href: '/review', label: 'Review' },
  { href: '/billing', label: 'Billing' },
  { href: '/settings', label: 'Settings' },
  { href: '/support', label: 'Help' },
] as const;

function navActive(pathname: string, href: string) {
  if (href === '/home') return pathname === '/home';
  if (href === '/myjobs') {
    return pathname === '/myjobs' || pathname.startsWith('/myjobs/');
  }
  if (href === '/settings') {
    return pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/profile';
  }
  if (href === '/billing') {
    return pathname.startsWith('/billing') || pathname.startsWith('/credits');
  }
  return pathname === href || pathname.startsWith(href + '/');
}

export function MemberShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { toggle, isOpen } = useGuide();

  return (
    <div className="member-portal min-h-screen flex flex-col bg-[var(--mp-canvas)] text-[var(--mp-text)]">
      <header className="sticky top-0 z-50 bg-[var(--mp-card)] border-b border-[var(--mp-border)] shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2.5 min-h-14">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/home" className="flex items-center gap-2 shrink-0">
                <span className="font-extrabold tracking-tight text-lg text-[var(--mp-text)]">
                  AuraFlux
                </span>
                <span className="hidden sm:inline text-[10px] font-semibold uppercase tracking-wider text-[var(--mp-muted)] border border-[var(--mp-border)] rounded-full px-2 py-0.5">
                  Member
                </span>
              </Link>
              <div className="hidden md:block min-w-0">
                <BrandSwitcher collapsed={false} />
              </div>
            </div>

            <nav className="hidden lg:flex items-center justify-center gap-1 flex-wrap">
              {NAV.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                      active
                        ? 'bg-[var(--mp-soft)] text-[var(--mp-text)]'
                        : 'text-[var(--mp-muted)] hover:text-[var(--mp-text)] hover:bg-[var(--mp-soft)]/70',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="flex items-center justify-end gap-2">
              <NotificationsBell />
              <button
                type="button"
                onClick={toggle}
                className={cn(
                  'hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold transition-colors',
                  isOpen
                    ? 'bg-[var(--mp-accent)] text-[var(--mp-accent-fg)] border-[var(--mp-accent)]'
                    : 'border-[var(--mp-border)] text-[var(--mp-muted)] hover:text-[var(--mp-text)]',
                )}
              >
                Collab
              </button>
              <UserButton />
              <button
                type="button"
                className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--mp-border)] text-[var(--mp-text)]"
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
              </button>
            </div>
          </div>

          {menuOpen && (
            <nav className="lg:hidden pb-3 flex flex-col gap-1 border-t border-[var(--mp-border)] pt-2">
              {NAV.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      'px-3 py-2 rounded-lg text-sm font-semibold',
                      active
                        ? 'bg-[var(--mp-soft)] text-[var(--mp-text)]'
                        : 'text-[var(--mp-muted)]',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
              <div className="px-1 pt-2 md:hidden">
                <BrandSwitcher collapsed={false} />
              </div>
            </nav>
          )}
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">{children}</div>
        </main>
        <GuidePanel />
      </div>
    </div>
  );
}
