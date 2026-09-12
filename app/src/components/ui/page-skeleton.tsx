import { cn } from '@/lib/utils';

type PageSkeletonProps = {
  rows?: number;
  className?: string;
};

/** Uniform pulse skeleton for Creator loading states. */
export function PageSkeleton({ rows = 4, className }: PageSkeletonProps) {
  return (
    <div className={cn('space-y-3 animate-pulse', className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-1/3 rounded bg-slate-800" />
          <div className="h-20 rounded-xl bg-slate-900 border border-slate-800" />
        </div>
      ))}
    </div>
  );
}
