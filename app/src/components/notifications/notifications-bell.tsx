'use client';
/**
 * NotificationsBell — DB-backed notifications (CPD-307)
 *
 * Reads from GET /notifications so read state persists across devices.
 * Polls every 30s. Each notification type has a colour-coded dot.
 *
 * Type colour map:
 *   job_ready / job_published         → green
 *   job_failed / credits_exhausted    → red
 *   job_held / credits_low / scheduled_missed / template_failed → amber
 *   platform_connected / credit_pack_purchased → blue
 *   operator_note / support_resolved  → violet
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type AppNotification,
} from '@/lib/api';

const POLL_MS = 30_000;

const DOT_CLASS: Record<string, string> = {
  job_ready:             'bg-emerald-500',
  job_revision_ready:    'bg-emerald-500',
  job_revision_requested:'bg-amber-500',
  job_published:         'bg-emerald-500',
  job_failed:            'bg-destructive',
  credits_exhausted:     'bg-destructive',
  job_held:              'bg-amber-500',
  credits_low:           'bg-amber-500',
  scheduled_missed:      'bg-amber-500',
  template_failed:       'bg-amber-500',
  platform_connected:    'bg-blue-500',
  credit_pack_purchased: 'bg-blue-500',
  platform_expired:      'bg-amber-500',
  operator_note:         'bg-violet-500',
  support_resolved:      'bg-violet-500',
};

function dotClass(type: string, read: boolean) {
  return cn(DOT_CLASS[type] ?? 'bg-muted-foreground', 'mt-1 shrink-0 w-2 h-2 rounded-full', read && 'opacity-30');
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationsBell() {
  const { getToken, isLoaded }            = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open,          setOpen]          = useState(false);
  const ref                               = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const res   = await listNotifications(token ?? undefined);
      setNotifications(res.notifications ?? []);
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

  async function handleClickNotif(n: AppNotification) {
    if (!n.read) {
      const token = await getToken();
      markNotificationRead(n.id, token ?? undefined).catch(() => {});
      setNotifications((prev) => prev.map((x) => x.id === n.id ? { ...x, read: true } : x));
    }
    setOpen(false);
  }

  async function handleMarkAllRead() {
    const token = await getToken();
    markAllNotificationsRead(token ?? undefined).catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        className={cn(
          'relative flex items-center justify-center w-8 h-8 rounded-full border transition-colors',
          open
            ? 'bg-primary/10 border-primary/40'
            : 'border-border hover:bg-primary/10 hover:border-primary/30',
        )}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className="text-primary">
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
        <div className="absolute right-0 top-10 z-50 w-80 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold">Notifications</span>
            {unread > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No notifications yet.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-border">
              {notifications.map((n) => {
                const inner = (
                  <div className={cn(
                    'flex items-start gap-2.5 px-3 py-2.5 hover:bg-accent/40 transition-colors cursor-pointer',
                    !n.read && 'bg-primary/5',
                  )}>
                    <span className={dotClass(n.type, n.read)} />
                    <div className="flex-1 min-w-0">
                      <p className={cn('text-xs leading-snug', !n.read && 'font-medium')}>{n.title}</p>
                      {n.body && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{n.body}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground/60 mt-0.5">{relativeTime(n.createdAt)}</p>
                    </div>
                    {!n.read && (
                      <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-primary mt-1.5" />
                    )}
                  </div>
                );

                return (
                  <li key={n.id} onClick={() => handleClickNotif(n)}>
                    {n.actionUrl ? (
                      <Link href={n.actionUrl}>{inner}</Link>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
