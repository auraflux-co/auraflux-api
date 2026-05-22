/**
 * PageShell — standard authenticated page wrapper.
 *
 * Usage:
 *   <PageShell>
 *     <PageHeader title="My Jobs" subtitle="Track and manage your production jobs">
 *       <Button>New Job</Button>   ← optional trailing actions
 *     </PageHeader>
 *     ... page body
 *   </PageShell>
 *
 * Width: defaults to max-w-5xl. Pass maxWidth="7xl" for wider admin pages.
 */

import { cn } from '@/lib/utils';

// ─── PageShell ────────────────────────────────────────────────────────────────

interface PageShellProps {
  children: React.ReactNode;
  /** Tailwind max-width token. Defaults to "5xl" (~1024px). */
  maxWidth?: '3xl' | '4xl' | '5xl' | '6xl' | '7xl' | 'full';
  className?: string;
}

const MAX_WIDTH_MAP: Record<NonNullable<PageShellProps['maxWidth']>, string> = {
  '3xl':  'max-w-3xl',
  '4xl':  'max-w-4xl',
  '5xl':  'max-w-5xl',
  '6xl':  'max-w-6xl',
  '7xl':  'max-w-7xl',
  'full': 'w-full',
};

export function PageShell({ children, maxWidth = '5xl', className }: PageShellProps) {
  return (
    <div className={cn('space-y-8', MAX_WIDTH_MAP[maxWidth], className)}>
      {children}
    </div>
  );
}

// ─── PageHeader ───────────────────────────────────────────────────────────────

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Optional badge/tag rendered next to the title (e.g. plan badge). */
  badge?: React.ReactNode;
  /** Trailing content — typically action buttons. */
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, badge, children, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 flex-wrap', className)}>
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="af-h1">{title}</h1>
          {badge}
        </div>
        {subtitle && (
          <p className="af-body text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2 shrink-0">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── PageSection ─────────────────────────────────────────────────────────────

interface PageSectionProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function PageSection({ title, description, children, className }: PageSectionProps) {
  return (
    <section className={cn('space-y-4', className)}>
      {(title || description) && (
        <div className="space-y-0.5">
          {title && <h2 className="af-h3">{title}</h2>}
          {description && <p className="af-label">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
