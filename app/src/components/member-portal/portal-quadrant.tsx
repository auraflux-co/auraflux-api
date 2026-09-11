import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  title: ReactNode;
  icon: LucideIcon;
  accent?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
};

/** Pavilion-style hub card — white panel on warm member-portal canvas. */
export function PortalQuadrant({
  title,
  icon: Icon,
  accent = 'var(--mp-accent)',
  action,
  children,
  className,
  id,
}: Props) {
  return (
    <section
      id={id}
      className={cn(
        'bg-[var(--mp-card)] rounded-2xl border border-[var(--mp-border)] shadow-sm flex flex-col min-h-[240px] scroll-mt-28',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[var(--mp-border-soft)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--mp-soft)' }}
          >
            <Icon className="size-[18px]" style={{ color: accent }} />
          </div>
          <h2 className="font-bold text-[var(--mp-text)] text-base truncate">{title}</h2>
        </div>
        {action}
      </header>
      <div className="px-5 py-4 flex-1 flex flex-col">{children}</div>
    </section>
  );
}
