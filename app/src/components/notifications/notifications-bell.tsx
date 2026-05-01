'use client';
/**
 * NotificationsBell — job event notifications (CPD-117).
 *
 * Derives notifications from recent jobs:
 *   held    → "needs attention"
 *   failed  → "job failed"
 *   complete/published → "ready"
 *
 * "Read" state tracked in localStorage keyed by jobId+status.
 * No extra backend needed — uses existing GET /jobs endpoint.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { listJobs, type Job } from '@/lib/api';

const NOTIFY_STATUSES = new Set(['held', 'failed', 'complete', 'published']);
const POLL_MS = 60_000;

interface Notification {
  key:     string;
  jobId:   string;
  status:  string;
  label:   string;
  href:    string;
  read:    boolean;
  ts:      number;
}

function notifKey(jobId: string, status: string) {
  return `notif:${jobId}:${status}`;
}

function isRead(key: string) {
  try { return localStorage.getItem(key) === 'read'; } catch { return false; }
}

function markRead(key: string) {
  try { localStorage.setItem(key, 'read'); } catch { /* noop */ }
}

function toNotification(job: Job): Notification | null {
  if (!NOTIFY_STATUSES.has(job.status)) return null;
  const key = notifKey(job.jobId, job.status);

  const labels: Record<string, string> = {
    held:      'Needs your attention',
    failed:    'Job failed',
    complete:  'Job ready',
    published: 'Published',
  };

  return {
    key,
    jobId:  job.jobId,
    status: job.status,
    label:  labels[job.status] ?? job.status,
    href:   `/dashboard/jobs/${job.jobId}`,
    read:   isRead(key),
    ts:     job.createdAt ? new Date(job.createdAt).getTime() : 0,
  };
}

export function NotificationsBell() {
  const { getToken, isLoaded }              = useAuth();
  const [notifications, setNotifications]   = useState<Notification[]>([]);
  const [open,          setOpen]            = useState(false);
  const ref                                 = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const res   = await listJobs(token ?? undefined);
      const notifs = (res.jobs ?? [])
        .map(toNotification)
        .filter(Boolean) as Notification[];
      // Refresh read state from localStorage each load
      setNotifications(notifs.map((n) => ({ ...n, read: isRead(n.key) })));
    } catch { /* non-fatal */ }
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, isLoaded]);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const unread = notifications.filter((n) => !n.read).length;

  function handleOpen() {
    setOpen((v) => !v);
  }

  function handleMarkAllRead() {
    notifications.forEach((n) => markRead(n.key));
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  function handleClickNotif(n: Notification) {
    markRead(n.key);
    setNotifications((prev) => prev.map((x) => x.key === n.key ? { ...x, read: true } : x));
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        title="Notifications"
        className={cn(
          'relative flex items-center justify-center w-8 h-8 rounded-full border transition-colors',
          open
            ? 'bg-accent border-border text-foreground'
            : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent/50',
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-destructive text-[9px] font-bold text-destructive-foreground leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold">Notifications</span>
            {unread > 0 && (
              <button onClick={handleMarkAllRead} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No notifications yet.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-border">
              {notifications.map((n) => (
                <li key={n.key}>
                  <Link
                    href={n.href}
                    onClick={() => handleClickNotif(n)}
                    className={cn(
                      'flex items-start gap-2.5 px-3 py-2.5 hover:bg-accent/40 transition-colors',
                      !n.read && 'bg-primary/5',
                    )}
                  >
                    <span className={cn(
                      'mt-1 shrink-0 w-2 h-2 rounded-full',
                      n.status === 'held'      && 'bg-amber-500',
                      n.status === 'failed'    && 'bg-destructive',
                      n.status === 'complete'  && 'bg-emerald-500',
                      n.status === 'published' && 'bg-blue-500',
                      n.read && 'opacity-30',
                    )} />
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-xs', !n.read && 'font-medium')}>{n.label}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{n.jobId.slice(0, 12)}…</p>
                    </div>
                    {!n.read && (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-1.5" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
