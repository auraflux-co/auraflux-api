'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useRole } from '@/hooks/use-role';

const CONFLUENCE_GUIDE_URL =
  'https://robertsworkspace-18914505.atlassian.net/wiki/spaces/AF/pages/6684693/Customer+Guide+Using+AuraFlux';

interface NavItem {
  href:      string;
  label:     string;
  external?: boolean;
  children?: { href: string; label: string }[];
}

const CUSTOMER_NAV: NavItem[] = [
  {
    href: '/dashboard/jobs',
    label: 'Jobs',
    children: [
      { href: '/dashboard/jobs/new',     label: 'New job'  },
      { href: '/dashboard/jobs/active',  label: 'Active'   },
      { href: '/dashboard/jobs/history', label: 'History'  },
    ],
  },
  { href: '/dashboard/support',  label: 'Support'  },
  { href: '/dashboard/schedule', label: 'Schedule' },
  { href: '/dashboard/credits',  label: 'Credits'  },
  { href: '/dashboard/billing',  label: 'Billing'  },
  { href: '/dashboard/settings', label: 'Settings' },
  { href: '/dashboard/profile',  label: 'Profile'  },
];

const OPERATOR_NAV: NavItem[] = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/operator', label: 'Operator' },
];

export function Sidebar() {
  const pathname       = usePathname();
  const { isOperator } = useRole();

  const navItems = isOperator ? [...CUSTOMER_NAV, ...OPERATOR_NAV] : CUSTOMER_NAV;

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === href;
    return pathname === href || pathname.startsWith(href + '/');
  }

  function isGroupActive(item: NavItem) {
    return isActive(item.href) || (item.children ?? []).some((c) => isActive(c.href));
  }

  return (
    <aside className="w-52 flex-shrink-0 border-r border-border bg-card flex flex-col h-screen">
      <div className="p-4 border-b border-border">
        <span className="font-semibold text-sm tracking-tight">AuraFlux</span>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const groupActive = isGroupActive(item);

          if (!item.children) {
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive(item.href)
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                {item.label}
              </Link>
            );
          }

          return (
            <div key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
                  groupActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                {item.label}
              </Link>
              <div className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2">
                {item.children.map((child) => (
                  <Link
                    key={child.href}
                    href={child.href}
                    className={cn(
                      'flex items-center px-2 py-1.5 rounded-md text-xs transition-colors',
                      isActive(child.href)
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                    )}
                  >
                    {child.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Bottom — Guides link */}
      <div className="p-2 border-t border-border">
        <a
          href={CONFLUENCE_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          Guides
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto shrink-0 opacity-50">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      </div>
    </aside>
  );
}
