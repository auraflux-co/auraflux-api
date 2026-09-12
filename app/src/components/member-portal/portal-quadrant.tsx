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

/** Creator hub card — dark slate panel + amber accents. */
export function PortalQuadrant({
  title,
  icon: Icon,
  accent = '#fbbf24',
  action,
  children,
  className,
  id,
}: Props) {
  return (
    <section
      id={id}
      className={cn(
        'bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 hover:border-slate-700 transition-colors flex flex-col min-h-[240px] scroll-mt-28',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-slate-800 border border-slate-700">
            <Icon className="size-[18px]" style={{ color: accent }} />
          </div>
          <h2 className="font-bold text-white text-base truncate">{title}</h2>
        </div>
        {action}
      </header>
      <div className="flex-1 flex flex-col space-y-4">{children}</div>
    </section>
  );
}
