import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_TO_BADGE: Record<
  string,
  'pending' | 'draft' | 'reviewing' | 'scheduled' | 'published' | 'failed' | 'running' | undefined
> = {
  queued: 'pending',
  queued_scheduled: 'scheduled',
  held: 'pending',
  credit_paused: 'pending',
  draft: 'draft',
  running: 'running',
  processing: 'running',
  reviewing: 'reviewing',
  review: 'reviewing',
  ready_for_review: 'reviewing',
  staged: 'reviewing',
  operator_review: 'reviewing',
  scheduled: 'scheduled',
  published: 'published',
  complete: 'published',
  completed: 'published',
  failed: 'failed',
  error: 'failed',
  cancelled: 'draft',
};

type JobStatusBadgeProps = {
  status: string | null | undefined;
  /** Optional display label (e.g. from jobStatusLabel). */
  label?: string;
  className?: string;
};

/** Shared job lifecycle badge — uses Badge status tokens. */
export function JobStatusBadge({ status, label, className }: JobStatusBadgeProps) {
  const key = (status || 'unknown').toLowerCase();
  const badgeStatus = STATUS_TO_BADGE[key];
  const text = label || (status || 'unknown').replace(/_/g, ' ');
  return (
    <Badge
      variant="outline"
      status={badgeStatus}
      className={cn('text-[10px] font-semibold', !badgeStatus && 'border-slate-700 bg-slate-800 text-slate-400', className)}
    >
      {text}
    </Badge>
  );
}
