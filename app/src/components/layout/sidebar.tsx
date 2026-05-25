'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { useRole } from '@/hooks/use-role';
import { usePlan } from '@/contexts/plan-context';
import { getCreditBalance } from '@/lib/api';
import { useSidebar } from '@/contexts/sidebar-context';
import { CreditToken } from '@/components/icons/brand-icons';

// ─── Icons ────────────────────────────────────────────────────────────────────

function Icon({ d, d2, viewBox = '0 0 24 24' }: { d: string; d2?: string; viewBox?: string }) {
  return (
    <svg width="16" height="16" viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
      {d2 && <path d={d2} />}
    </svg>
  );
}

const ICONS: Record<string, React.ReactNode> = {
  jobs:     <Icon d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z" d2="M16 3H8a2 2 0 0 0-2 2v2h12V5a2 2 0 0 0-2-2z" />,
  schedule:  <Icon d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />,
  templates: <Icon d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2" />,
  billing:  <Icon d="M2 9h20M2 15h20M1 5h22a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />,
  support:  <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  profile:  <Icon d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />,
  settings: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
  generate:  <Icon d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />,
  operator:  <Icon d="M4 6h16M4 12h16M4 18h16" />,
  customers: <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" d2="M20 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />,
  guide:     <Icon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" d2="M14 2v6h6M16 13H8M16 17H8M10 9H8" />,
  collab:   <Icon d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM12 16v-4M12 8h.01" />,
  credits:   <Icon d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />,
  team:      <Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />,
};

function iconFor(href: string) {
  if (href.includes('/jobs'))     return ICONS.jobs;
  if (href.includes('/schedule'))  return ICONS.schedule;
  if (href.includes('/templates')) return ICONS.templates;
  if (href.includes('/billing'))  return ICONS.billing;
  if (href.includes('/support'))  return ICONS.support;
  if (href.includes('/profile'))  return ICONS.profile;
  if (href.includes('/settings')) return ICONS.settings;
  if (href.includes('/generate'))  return ICONS.generate;
  if (href.includes('/operator'))  return ICONS.operator;
  if (href.includes('/admin'))     return ICONS.customers;
  if (href.includes('/staging'))   return ICONS.schedule;
  if (href.includes('/concierge')) return ICONS.collab;
  if (href.includes('/credits'))   return ICONS.credits;
  if (href.includes('/plans'))     return ICONS.billing;
  if (href.includes('/team'))      return ICONS.team;
  return ICONS.jobs;
}

// ─── Credits badge ────────────────────────────────────────────────────────────

/** Monthly included credits by tier — mirrors lib/db/postgres.js PLAN_DEFAULTS */
const TIER_INCLUDED_CREDITS: Record<string, number> = {
  operate: 50,
  guided:  200,
  managed: 1000,
  custom:  9999,
  diy:     50,
  dwy:     200,
  dfy:     1000,
};

function CreditsBadge({ collapsed }: { collapsed: boolean }) {
  const { getToken, isLoaded } = useAuth();
  const { planTier }           = usePlan();
  const [remaining, setRemaining] = useState<number | null>(null);
  const tierFallback = planTier ? (TIER_INCLUDED_CREDITS[planTier] ?? 50) : null;

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    async function load() {
      try {
        const token = await getToken();
        if (!token) return;
        const b = await getCreditBalance(token);
        if (!cancelled) setRemaining(b.included_remaining);
      } catch { /* fall back to tier allocation */ }
    }
    load();
    return () => { cancelled = true; };
  }, [getToken, isLoaded]);

  if (collapsed) return null;

  const display = remaining ?? tierFallback;

  return (
    <Link
      href="/credits"
      title="Credits remaining this period"
      className={cn(
        'flex items-center gap-2 w-full px-2.5 py-2 rounded-lg border border-border',
        'bg-card/50 hover:bg-accent/40 hover:border-primary/30 transition-colors',
      )}
    >
      <span
        className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/15 text-primary shrink-0"
        aria-hidden
      >
        <CreditToken size={16} />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-sm font-semibold tabular-nums text-foreground">
          {display === null
            ? <span className="inline-block w-8 h-3.5 rounded bg-muted animate-pulse" aria-hidden />
            : display.toLocaleString()}
        </span>
        <span className="block text-[11px] text-muted-foreground">credits left</span>
      </span>
    </Link>
  );
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

interface NavItem {
  href:      string;
  label:     string;
  external?: boolean;
  children?: { href: string; label: string }[];
  divider?:  string; // section label shown above this item when sidebar is expanded
}

// Base nav — same for all customer tiers
const CUSTOMER_NAV_BASE: NavItem[] = [
  {
    href: '/myjobs',
    label: 'My Jobs',
    children: [
      { href: '/myjobs/new',     label: 'New job' },
      { href: '/myjobs/active',  label: 'Active'  },
      { href: '/myjobs/history', label: 'History' },
    ],
  },
  { href: '/review',    label: 'Review Queue'  },
  { href: '/schedule',   label: 'Schedule'      },
  { href: '/templates',  label: 'My Templates'  },
  {
    href:  '/billing',
    label: 'Billing',
    children: [
      { href: '/billing',          label: 'Subscription'          },
      { href: '/credits',          label: 'Credits'               },
      { href: '/billing/payment',  label: 'Payment & Invoices'    },
    ],
  },
  { href: '/support',    label: 'Support'   },
  { href: '/profile',    label: 'Profile'   },
];

// Settings children differ by plan tier
function settingsNavItem(planTier: string | null): NavItem {
  const isOperate = !planTier || planTier === 'operate' || planTier === 'custom';
  const children: { href: string; label: string }[] = [];
  if (isOperate) {
    children.push({ href: '/settings/api-keys', label: 'API Keys' });
  }
  children.push(
    { href: '/settings/channels', label: 'My Channels'       },
    { href: '/settings/social',  label: 'My Social Accounts' },
    { href: '/settings/team',            label: 'My Team'           },
  );
  return { href: '/settings', label: 'Settings', children };
}

const ADMIN_NAV: NavItem[] = [
  { href: '/admin',             label: 'Overview',      divider: 'Platform tools' },
  { href: '/admin/users',       label: 'All Users'      },
  { href: '/admin/support',     label: 'Support Inbox'  },
  { href: '/admin/crm',         label: 'CRM'            },
  { href: '/admin/permissions', label: 'Permissions'    },
  { href: '/operator',          label: 'All Jobs'       },
  { href: '/review',            label: 'Review Queue'   },
  { href: '/generate',          label: 'Generate Video' },
  { href: '/generate/canva',    label: 'Canva Images'   },
];

const CONFLUENCE_GUIDE_URL =
  'https://robertsworkspace-18914505.atlassian.net/wiki/spaces/AF/pages/6684693/Customer+Guide+Using+AuraFlux';

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar({ setupLocked }: { setupLocked?: boolean } = {}) {
  const pathname                               = usePathname();
  const { isSuperAdmin }                       = useRole();
  const { planTier }                           = usePlan();
  const { collapsed, toggleCollapsed, closeMobile } = useSidebar();
  const router                                 = useRouter();

  const CUSTOMER_NAV = [...CUSTOMER_NAV_BASE, settingsNavItem(planTier)];

  // Superadmin sees platform tools; everyone else sees customer nav
  const navItems = setupLocked
    ? []
    : isSuperAdmin
      ? ADMIN_NAV
      : CUSTOMER_NAV;

  function isActive(href: string) {
    if (href === '/home') return pathname === href;
    return pathname === href || pathname.startsWith(href + '/');
  }

  function isGroupActive(item: NavItem) {
    return isActive(item.href) || (item.children ?? []).some((c) => isActive(c.href));
  }

  function handleNavClick(href: string) {
    closeMobile();
    router.push(href);
  }

  return (
    <aside
      className={cn(
        'flex-shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col h-screen transition-[width] duration-200 ease-in-out overflow-hidden',
        collapsed ? 'w-14' : 'w-52',
      )}
    >
      {/* Header */}
      <div className={cn(
        'border-b border-border shrink-0',
        collapsed ? 'px-3 py-3 flex justify-center' : 'px-3 py-3 space-y-2.5',
      )}>
        {!collapsed && (
          <>
            <Link href="/home" className="flex items-center gap-2.5 hover:opacity-90 transition-opacity min-w-0">
              <Image src="/brand/logo.png" alt="AuraFlux" width={56} height={34} className="shrink-0 object-contain" priority />
              <span className="font-semibold text-[15px] tracking-tight text-foreground truncate">AuraFlux</span>
            </Link>
            <CreditsBadge collapsed={collapsed} />
          </>
        )}
        {collapsed && (
          <Link href="/home" title="AuraFlux">
            <Image src="/brand/logo.png" alt="AuraFlux" width={36} height={22} className="object-contain" priority />
          </Link>
        )}
      </div>

      {/* Nav */}
      <nav className={cn('flex-1 p-2 space-y-0.5 overflow-y-auto', collapsed && 'px-1.5')}>
        {navItems.map((item) => {
          const groupActive = isGroupActive(item);
          const icon        = iconFor(item.href);

          if (collapsed) {
            return (
              <button
                key={item.href}
                onClick={() => handleNavClick(item.href)}
                title={item.label}
                className={cn(
                  'flex items-center justify-center w-full p-2 rounded-md transition-colors',
                  groupActive
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/60',
                )}
              >
                {icon}
              </button>
            );
          }

          if (!item.children) {
            return (
              <div key={item.href}>
                {item.divider && (
                  <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
                    {item.divider}
                  </p>
                )}
                <button
                  onClick={() => handleNavClick(item.href)}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm transition-colors text-left',
                    isActive(item.href)
                      ? 'bg-primary/15 text-primary font-semibold'
                      : 'text-foreground/80 hover:text-foreground hover:bg-accent/60',
                  )}
                >
                  {icon}
                  {item.label}
                </button>
              </div>
            );
          }

          return (
            <div key={item.href}>
              <button
                onClick={() => handleNavClick(item.href)}
                className={cn(
                  'flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm transition-colors text-left',
                  groupActive
                    ? 'text-primary font-semibold'
                    : 'text-foreground/80 hover:text-foreground hover:bg-accent/60',
                )}
              >
                {icon}
                {item.label}
              </button>
              <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2">
                {item.children.map((child) => (
                  <button
                    key={child.href}
                    onClick={() => handleNavClick(child.href)}
                    className={cn(
                      'flex items-center w-full px-2 py-1.5 rounded-md text-sm transition-colors text-left',
                      isActive(child.href)
                        ? 'bg-primary/15 text-primary font-semibold'
                        : 'text-foreground/70 hover:text-foreground hover:bg-accent/60',
                    )}
                  >
                    {child.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={cn('border-t border-border p-2 space-y-0.5 shrink-0', collapsed && 'px-1.5')}>
        {/* Guides link */}
        <a
          href={CONFLUENCE_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Customer guides"
          className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
        >
          {ICONS.guide}
          {!collapsed && (
            <>
              Guides
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto shrink-0 opacity-50">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </>
          )}
        </a>

        {/* Collapse toggle */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className={cn('shrink-0 transition-transform', collapsed && 'rotate-180')}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

// ─── Mobile overlay ───────────────────────────────────────────────────────────

export function MobileSidebarOverlay() {
  const { mobileOpen, closeMobile } = useSidebar();
  if (!mobileOpen) return null;
  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 md:hidden"
      onClick={closeMobile}
      aria-hidden="true"
    />
  );
}

export function MobileSidebar({ setupLocked }: { setupLocked?: boolean } = {}) {
  const { mobileOpen, closeMobile } = useSidebar();
  const pathname                    = usePathname();
  const { isSuperAdmin }            = useRole();
  const { planTier }                = usePlan();
  const router                      = useRouter();

  const CUSTOMER_NAV = [...CUSTOMER_NAV_BASE, settingsNavItem(planTier)];

  const navItems = setupLocked
    ? []
    : isSuperAdmin
      ? ADMIN_NAV
      : CUSTOMER_NAV;

  function isActive(href: string) {
    if (href === '/home') return pathname === href;
    return pathname === href || pathname.startsWith(href + '/');
  }

  function isGroupActive(item: NavItem) {
    return isActive(item.href) || (item.children ?? []).some((c) => isActive(c.href));
  }

  function go(href: string) {
    closeMobile();
    router.push(href);
  }

  return (
    <aside className={cn(
      'fixed top-0 left-0 z-50 h-full w-64 bg-sidebar border-r border-sidebar-border flex flex-col md:hidden',
      'transition-transform duration-200 ease-in-out',
      mobileOpen ? 'translate-x-0' : '-translate-x-full',
    )}>
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <Link href="/home" className="flex items-center gap-2.5" onClick={closeMobile}>
          <Image src="/brand/logo.png" alt="AuraFlux" width={52} height={32} className="shrink-0 object-contain" priority />
          <span className="font-semibold text-[15px] tracking-tight">AuraFlux</span>
        </Link>
        <button onClick={closeMobile} className="text-muted-foreground hover:text-foreground p-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const groupActive = isGroupActive(item);
          const icon        = iconFor(item.href);

          if (!item.children) {
            return (
              <button key={item.href} onClick={() => go(item.href)}
                className={cn('flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm transition-colors text-left',
                  isActive(item.href) ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground/80 hover:text-foreground hover:bg-accent/60')}>
                {icon}{item.label}
              </button>
            );
          }

          return (
            <div key={item.href}>
              <button onClick={() => go(item.href)}
                className={cn('flex items-center gap-2.5 w-full px-3 py-2 rounded-md text-sm transition-colors text-left',
                  groupActive ? 'text-primary font-semibold' : 'text-foreground/80 hover:text-foreground hover:bg-accent/60')}>
                {icon}{item.label}
              </button>
              <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2">
                {item.children.map((child) => (
                  <button key={child.href} onClick={() => go(child.href)}
                    className={cn('flex items-center w-full px-2 py-1.5 rounded-md text-sm transition-colors text-left',
                      isActive(child.href) ? 'bg-primary/15 text-primary font-semibold' : 'text-foreground/70 hover:text-foreground hover:bg-accent/60')}>
                    {child.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="p-2 border-t border-border">
        <a href={CONFLUENCE_GUIDE_URL} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-foreground/70 hover:text-foreground hover:bg-accent/60 transition-colors">
          {ICONS.guide}Guides
        </a>
      </div>
    </aside>
  );
}
