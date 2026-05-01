'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useRole } from '@/hooks/use-role';

const CUSTOMER_NAV = [
  { href: '/dashboard/jobs',     label: 'Jobs'      },
  { href: '/dashboard/schedule', label: 'Schedule'  },
  { href: '/dashboard/credits',  label: 'Credits'   },
  { href: '/dashboard/billing',  label: 'Billing'   },
  { href: '/dashboard/settings', label: 'Settings'  },
  { href: '/dashboard/profile',  label: 'Profile'   },
];

const OPERATOR_NAV = [
  { href: '/dashboard/generate', label: 'Generate'  },
  { href: '/dashboard/operator', label: 'Operator'  },
];

export function Sidebar() {
  const pathname  = usePathname();
  const { isOperator } = useRole();

  const navItems = isOperator ? [...CUSTOMER_NAV, ...OPERATOR_NAV] : CUSTOMER_NAV;

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === href;
    return pathname.startsWith(href);
  }

  return (
    <aside className="w-52 flex-shrink-0 border-r border-border bg-card flex flex-col h-screen">
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
              isActive(item.href)
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
