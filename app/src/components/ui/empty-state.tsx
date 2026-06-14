/**
 * EmptyState — zero-data view with optional icon, title, body, and CTA.
 *
 * Usage:
 *   <EmptyState
 *     icon={<JobsIcon />}
 *     title="No jobs yet"
 *     description="Create your first production job to get started."
 *     action={{ label: 'Create a job', href: '/myjobs/new' }}
 *   />
 *
 * With a button action:
 *   <EmptyState
 *     icon={<PlusIcon />}
 *     title="No templates"
 *     description="Save time by creating a reusable template."
 *     action={{ label: 'Create template', onClick: () => setOpen(true) }}
 *   />
 */

import Link from 'next/link';
import { cn } from '@/lib/utils';

interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

interface EmptyStateProps {
  /** Optional icon displayed above the title. */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  /** Size variant. Defaults to "md". */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE_MAP = {
  sm: {
    wrapper: 'py-8',
    iconBox: 'w-10 h-10',
    iconSize: 'w-5 h-5',
    title: 'af-h3',
    desc: 'af-label',
  },
  md: {
    wrapper: 'py-14',
    iconBox: 'w-14 h-14',
    iconSize: 'w-6 h-6',
    title: 'text-[18px] font-semibold',
    desc: 'af-body text-muted-foreground',
  },
  lg: {
    wrapper: 'py-20',
    iconBox: 'w-18 h-18',
    iconSize: 'w-8 h-8',
    title: 'af-h2',
    desc: 'af-lead text-muted-foreground',
  },
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  const s = SIZE_MAP[size];

  return (
    <div className={cn(
      'flex flex-col items-center justify-center text-center gap-4',
      s.wrapper,
      className,
    )}>
      {icon && (
        <div className={cn(
          'rounded-xl bg-muted/60 flex items-center justify-center text-muted-foreground/60',
          s.iconBox,
        )}>
          <span className={s.iconSize}>{icon}</span>
        </div>
      )}
      <div className="space-y-1.5 max-w-sm">
        <p className={s.title}>{title}</p>
        {description && <p className={s.desc}>{description}</p>}
      </div>
      {action && (
        action.href ? (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground af-body font-semibold hover:bg-primary/85 transition-colors"
          >
            {action.label}
          </Link>
        ) : (
          <button
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground af-body font-semibold hover:bg-primary/85 transition-colors"
          >
            {action.label}
          </button>
        )
      )}
    </div>
  );
}
