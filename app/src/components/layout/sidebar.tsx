'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useRole } from '@/hooks/use-role';

interface NavItem {
  href:      string;
  label:     string;
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
  const pathname   = usePathname();
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

          // Item with children — always-expanded sub-group
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
    </aside>
  );
}
