'use client';
/**
 * ReviewCountBadge — lightweight client component that shows a live count
 * of jobs ready to review. Used by the dashboard home nav tile.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { listJobs, type Job } from '@/lib/api';

const REVIEW_STATUSES = new Set(['complete', 'staged']);

export function ReviewCountBadge() {
  const { getToken }       = useAuth();
  const [count, setCount]  = useState<number | null>(null);

  const fetch = useCallback(async () => {
    try {
      const token = await getToken();
      const res   = await listJobs(token ?? undefined);
      const jobs  = (res.jobs ?? []) as Job[];
      setCount(jobs.filter((j) => REVIEW_STATUSES.has(j.status)).length);
    } catch { /* non-fatal */ }
  }, [getToken]);

  useEffect(() => {
    fetch();
    const t = setInterval(fetch, 15_000);
    return () => clearInterval(t);
  }, [fetch]);

  if (count === null || count === 0) return null;

  return (
    <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1.5 tabular-nums">
      {count}
    </span>
  );
}
