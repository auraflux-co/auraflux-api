import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-slate-700/40 text-slate-300 border-slate-600',
  queued_scheduled: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  running: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  processing: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  held: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  credit_paused: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  reviewing: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  review: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  ready_for_review: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  staged: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  operator_review: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  scheduled: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  published: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  complete: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-300 border-red-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
  cancelled: 'bg-slate-700/40 text-slate-400 border-slate-600',
};

type JobStatusBadgeProps = {
  status: string | null | undefined;
  /** Optional display label (e.g. from jobStatusLabel). */
  label?: string;
  className?: string;
};

/** Shared job lifecycle badge for Review, My Jobs, Schedule. */
export function JobStatusBadge({ status, label, className }: JobStatusBadgeProps) {
  const key = (status || 'unknown').toLowerCase();
  const style = STATUS_STYLES[key] || 'bg-slate-800 text-slate-400 border-slate-700';
  const text = label || (status || 'unknown').replace(/_/g, ' ');
  return (
    <Badge
      variant="outline"
      className={cn('capitalize border text-[10px] font-semibold', style, className)}
    >
      {text}
    </Badge>
  );
}
