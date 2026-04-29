'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { UserButton } from '@clerk/nextjs';

const NAV_ITEMS = [
  { href: '/dashboard',          label: 'Overview' },
  { href: '/dashboard/jobs',     label: 'Jobs' },
  { href: '/dashboard/concierge',label: 'AI Concierge' },
  { href: '/dashboard/schedule', label: 'Schedule' },
  { href: '/dashboard/settings', label: 'Settings' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 flex-shrink-0 border-r border-border bg-card flex flex-col h-screen">
      <div className="p-4 border-b border-border">
        <span className="font-semibold text-sm tracking-tight">AuraFlux</span>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
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
