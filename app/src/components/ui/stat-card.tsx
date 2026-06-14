/**
 * StatCard — KPI metric tile.
 *
 * Usage (basic):
 *   <StatCard label="Active Jobs" value={12} icon={<JobsIcon />} />
 *
 * Usage (with trend + description):
 *   <StatCard
 *     label="Credits Remaining"
 *     value="1,204"
 *     description="of 2,000 included"
 *     trend={{ direction: 'down', label: '−40% this month' }}
 *     icon={<CreditIcon />}
 *   />
 *
 * Usage (with progress bar):
 *   <StatCard label="Credits Used" value="60%" progress={60} />
 *
 * Use inside a responsive grid:
 *   <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
 *     <StatCard ... />
 *   </div>
 */

import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Trend {
  direction: 'up' | 'down' | 'neutral';
  label: string;
  /** Whether "up" is good (green) or bad (red). Defaults to true. */
  upIsGood?: boolean;
}

interface StatCardProps {
  label: string;
  value: string | number | React.ReactNode;
  description?: string;
  /** Optional icon displayed in top-right corner. */
  icon?: React.ReactNode;
  /** Optional trend indicator. */
  trend?: Trend;
  /** Progress bar 0–100. */
  progress?: number;
  /** Color of progress bar. Defaults to "primary" (gold). */
  progressColor?: 'primary' | 'success' | 'destructive' | 'warning';
  /** Skeleton loading state. */
  loading?: boolean;
  className?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded bg-muted/80 animate-pulse', className)} />;
}

const PROGRESS_COLOR: Record<NonNullable<StatCardProps['progressColor']>, string> = {
  primary:     'bg-primary',
  success:     'bg-success',
  destructive: 'bg-destructive',
  warning:     'bg-yellow-400',
};

function trendColor(direction: Trend['direction'], upIsGood = true) {
  if (direction === 'neutral') return 'text-muted-foreground';
  const isPositive = direction === 'up' ? upIsGood : !upIsGood;
  return isPositive ? 'text-success' : 'text-destructive';
}

function TrendIcon({ direction }: { direction: Trend['direction'] }) {
  if (direction === 'up') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
      <path d="M6 9.5V2.5M2.5 6 6 2.5 9.5 6" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  if (direction === 'down') return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
      <path d="M6 2.5v7M2.5 6 6 9.5 9.5 6" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  description,
  icon,
  trend,
  progress,
  progressColor = 'primary',
  loading = false,
  className,
}: StatCardProps) {
  return (
    <div className={cn(
      'af-surface flex flex-col gap-3 px-5 py-4',
      'transition-all duration-150 hover:border-primary/25',
      className,
    )}>
      {/* Header row: label + icon */}
      <div className="flex items-center justify-between gap-2">
        <span className="af-subhead">{label}</span>
        {icon && (
          <span className="text-muted-foreground/60 shrink-0">{icon}</span>
        )}
      </div>

      {/* Metric value */}
      {loading ? (
        <Skeleton className="h-8 w-28" />
      ) : (
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="af-metric">{value}</span>
          {description && (
            <span className="af-label">{description}</span>
          )}
        </div>
      )}

      {/* Optional progress bar */}
      {progress !== undefined && !loading && (
        <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', PROGRESS_COLOR[progressColor])}
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}

      {/* Optional trend indicator */}
      {trend && !loading && (
        <div className={cn(
          'flex items-center gap-1 af-caption',
          trendColor(trend.direction, trend.upIsGood),
        )}>
          <TrendIcon direction={trend.direction} />
          {trend.label}
        </div>
      )}
    </div>
  );
}

// ─── StatRow ─────────────────────────────────────────────────────────────────
// Convenience wrapper: responsive 4-col grid of StatCards.

interface StatRowProps {
  children: React.ReactNode;
  cols?: 2 | 3 | 4;
  className?: string;
}

const COL_MAP: Record<NonNullable<StatRowProps['cols']>, string> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

export function StatRow({ children, cols = 4, className }: StatRowProps) {
  return (
    <div className={cn('grid gap-4', COL_MAP[cols], className)}>
      {children}
    </div>
  );
}
