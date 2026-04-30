'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { UserButton } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';

const BASE_NAV = [
  { href: '/dashboard',           label: 'Overview' },
  { href: '/dashboard/jobs',      label: 'Jobs' },
  { href: '/dashboard/generate',  label: 'Generate' },
  { href: '/dashboard/concierge', label: 'AI Concierge' },
  { href: '/dashboard/schedule',  label: 'Schedule' },
  { href: '/dashboard/credits',   label: 'Credits' },
  { href: '/dashboard/plans',     label: 'Plans' },
  { href: '/dashboard/settings',  label: 'Settings' },
];

const OPERATOR_NAV = [
  { href: '/dashboard/operator', label: 'Operator' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { isOperator } = useRole();

  const navItems = isOperator ? [...BASE_NAV, ...OPERATOR_NAV] : BASE_NAV;

  return (
    <aside className="w-56 flex-shrink-0 border-r border-border bg-card flex flex-col h-screen">
      <div className="p-4 border-b border-border">
        <span className="font-semibold text-sm tracking-tight">AuraFlux</span>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              pathname.startsWith(item.href) && item.href !== '/dashboard'
                ? 'bg-accent text-accent-foreground'
                : pathname === item.href
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-border">
        <UserButton />
      </div>
    </aside>
  );
}
