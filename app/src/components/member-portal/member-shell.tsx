'use client';

/**
 * Creator portal chrome — dark slate + amber design system.
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
  { href: '/library', label: 'Library' },
  { href: '/myjobs', label: 'Jobs' },
  { href: '/schedule', label: 'Schedule' },
  { href: '/templates', label: 'Templates' },
  { href: '/stats', label: 'Analytics' },
  { href: '/review', label: 'Review' },
  { href: '/billing', label: 'Billing' },
  { href: '/settings', label: 'Settings' },
  { href: '/support', label: 'Support' },
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
    <div className="member-portal min-h-screen flex flex-col bg-slate-950 text-white antialiased">
      <header className="sticky top-0 z-50 bg-slate-900/80 backdrop-blur-md border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2.5 min-h-14">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/home" className="flex items-center gap-2 shrink-0">
                <span className="font-extrabold tracking-tight text-lg text-white">
                  AuraFlux
                </span>
                <span className="hidden sm:inline text-[10px] font-semibold uppercase tracking-wider text-slate-400 border border-slate-700 rounded-full px-2 py-0.5">
                  Creator
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
                      'relative px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                      active
                        ? 'bg-amber-400/10 text-amber-400'
                        : 'text-slate-300 hover:text-amber-400',
                    )}
                  >
                    {item.label}
                    {active && (
                      <span
                        aria-hidden
                        className="absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-amber-400"
                      />
                    )}
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
                    ? 'bg-amber-400 text-slate-950 border-amber-400'
                    : 'border-slate-700 text-slate-300 hover:text-amber-400',
                )}
              >
                Assist
              </button>
              <UserButton />
              <button
                type="button"
                className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-slate-700 text-white"
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                onClick={() => setMenuOpen((v) => !v)}
              >
                {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
              </button>
            </div>
          </div>

          {menuOpen && (
            <nav className="lg:hidden pb-3 flex flex-col gap-1 border-t border-slate-800 pt-2">
              {NAV.map((item) => {
                const active = navActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      active
                        ? 'bg-amber-400/10 text-amber-400'
                        : 'text-slate-300 hover:text-amber-400',
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
