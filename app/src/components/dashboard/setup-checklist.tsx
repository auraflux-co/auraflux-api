'use client';
/**
 * SetupChecklist — onboarding progress card shown on the dashboard home.
 *
 * Appears until all 4 steps are complete OR the user deliberately dismisses it.
 * Dismissal shows an inline warning (mentioning Collab) before confirming.
 * The platformConnected step surfaces a note for users who publish manually.
 *
 * Data flow:
 *  - setupDismissed flag comes from Clerk publicMetadata (server-rendered prop)
 *    so dismissed users never trigger a data fetch.
 *  - Step completion is fetched from GET /account/setup-status on mount.
 *  - Dismiss calls POST /account/setup-status/dismiss then hides the card.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { useGuide } from '@/contexts/guide-context';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupStatus {
  steps: {
    accountCreated:     boolean;
    sourceChannelSaved: boolean;
    platformConnected:  boolean;
  };
  doneCount:  number;
  totalSteps: number;
  allComplete: boolean;
  connectedHandles: { platform: string; handle: string | null }[];
  sourceChannels: Record<string, string>;
}

interface StepDef {
  key:     keyof SetupStatus['steps'];
  label:   (status: SetupStatus) => string;
  href?:   string;
  note?:   string;
}

// ─── Step definitions ─────────────────────────────────────────────────────────

const STEPS: StepDef[] = [
  {
    key:   'accountCreated',
    label: () => 'Account created',
  },
  {
    key:  'sourceChannelSaved',
    label: (s) => {
      const ch = s.sourceChannels;
      const handle = ch.twitchLogin || ch.youtubeHandle || ch.kickUsername || ch.tiktokUsername;
      return handle ? `Channel saved — ${handle}` : 'Set up My Channels';
    },
    href: '/settings/channels',
  },
  {
    key:   'platformConnected',
    label: (s) => {
      const conn = s.connectedHandles;
      if (conn.length > 0) {
        const p = conn[0];
        return `${capitalize(p.platform)} connected${p.handle ? ` — ${p.handle}` : ''}`;
      }
      return 'Connect a publishing platform';
    },
    href: '/settings/social',
    note: 'Skip if you plan to download and upload manually.',
  },
];

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  /** Passed from server via currentUser() publicMetadata. When true, skip render entirely. */
  setupDismissed?: boolean;
  /** Passed from server — 'operate' | 'guided' | 'managed' | 'custom' */
  planTier?: string;
}

export function SetupChecklist({ setupDismissed, planTier }: Props) {
  const { getToken, isLoaded } = useAuth();
  const { openWithContext } = useGuide();

  // Guided and managed customers have an operator who can help them complete setup.
  const isOperatorRun = planTier === 'guided' || planTier === 'managed';

  const [status, setStatus]         = useState<SetupStatus | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [hidden, setHidden]         = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const callDismissApi = useCallback(async () => {
    const token = await getToken();
    try {
      await apiFetch('/account/setup-status/dismiss', {
        method: 'POST',
        token: token ?? undefined,
      });
    } catch {
      // Best-effort
    }
  }, [getToken]);

  const fetchStatus = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    try {
      const data = await apiFetch<SetupStatus>('/account/setup-status', { token });
      setStatus(data);
      setFetchError(false);
      // Auto-dismiss in Clerk when all steps complete so nav unlocks on next render
      if (data.allComplete) {
        await callDismissApi();
        setHidden(true);
      }
    } catch {
      setFetchError(true);
    }
  }, [getToken, callDismissApi]);

  // Wait until Clerk has loaded before attempting the fetch so getToken()
  // reliably returns a token rather than null on the first render.
  useEffect(() => {
    if (!setupDismissed && isLoaded) fetchStatus();
  }, [setupDismissed, isLoaded, fetchStatus]);

  const handleDismiss = useCallback(async () => {
    setDismissing(true);
    await callDismissApi();
    setHidden(true);
    setDismissing(false);
  }, [callDismissApi]);

  // Don't render if dismissed (server-side or in-session)
  if (setupDismissed || hidden) return null;
  // Collapse once all steps done (auto-dismiss was called above)
  if (status?.allComplete) return null;

  // If status is still loading, show a skeleton so the user knows something is here
  if (!status && !fetchError) {
    return (
      <div className="rounded-lg border border-primary/20 bg-card p-5 space-y-3 animate-pulse">
        <div className="h-4 w-48 rounded bg-muted" />
        <div className="h-1.5 w-full rounded-full bg-muted" />
        <div className="space-y-2 pt-1">
          {[1,2,3].map((i) => <div key={i} className="h-4 w-full rounded bg-muted" />)}
        </div>
      </div>
    );
  }

  // If the fetch failed, show static links so the user is never stuck
  if (fetchError && !status) {
    return (
      <div className="rounded-lg border border-primary/20 bg-card px-5 py-4 space-y-3">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <span className="text-primary">✦</span> Complete your setup
        </p>
        <ul className="space-y-2 text-sm">
          <li><Link href="/settings/channels" className="text-primary hover:underline">Set up My Channels →</Link></li>
          <li><Link href="/settings/social" className="text-primary hover:underline">Connect a publishing platform →</Link></li>
        </ul>
      </div>
    );
  }

  // At this point status is guaranteed non-null (all null paths returned above)
  const s   = status!;
  const pct = Math.round((s.doneCount / s.totalSteps) * 100);

  return (
    <Card className="border-primary/20 bg-card">
      <CardContent className="pt-5 pb-4 space-y-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 flex-1">
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <span className="text-primary">✦</span>
              Complete your setup
              <span className="text-xs font-normal text-muted-foreground ml-1">
                ({s.doneCount} of {s.totalSteps} done)
              </span>
            </p>
            {/* Progress bar */}
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Dismiss trigger */}
          {!confirmDismiss && (
            <button
              onClick={() => setConfirmDismiss(true)}
              className="text-muted-foreground hover:text-foreground transition-colors text-xs shrink-0 mt-0.5"
              aria-label="Dismiss setup guide"
            >
              ✕
            </button>
          )}
        </div>

        {/* Dismiss warning */}
        {confirmDismiss && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2.5 space-y-2 text-xs">
            <p className="text-amber-800 dark:text-amber-300 font-medium">
              Dismiss the setup guide?
            </p>
            <p className="text-amber-700 dark:text-amber-400">
              You can still reach these settings any time:
              channels under <strong>Settings → My Channels</strong>,
              publishing connections under <strong>Settings → My Social Accounts</strong>.
              The <strong>Collab</strong> button (top-right of the dashboard) is also available whenever you need assistance.
            </p>
            <div className="flex gap-2 pt-0.5">
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={dismissing}
                onClick={handleDismiss}
              >
                {dismissing ? 'Dismissing…' : 'Yes, dismiss'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setConfirmDismiss(false)}
              >
                Keep guide
              </Button>
            </div>
          </div>
        )}

        {/* Step list */}
        <ul className="space-y-2">
          {STEPS.map(({ key, label, href, note }) => {
            const done = s.steps[key];
            return (
              <li key={key} className="flex items-start gap-2.5 text-sm">
                {/* Check / circle */}
                <span
                  className={`mt-0.5 shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold
                    ${done
                      ? 'bg-primary text-primary-foreground'
                      : 'border-2 border-muted-foreground/40'
                    }`}
                >
                  {done && '✓'}
                </span>

                <div className="flex-1 min-w-0">
                  <span className={done ? 'line-through text-muted-foreground' : 'text-foreground'}>
                    {label(s)}
                  </span>
                  {!done && note && (
                    <p className="text-xs text-muted-foreground mt-0.5">{note}</p>
                  )}
                  {!done && href && (
                    <Link
                      href={href}
                      className="text-xs text-primary hover:underline mt-0.5 inline-block"
                    >
                      Go →
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {/* Guided/managed — Collab CTA */}
        {isOperatorRun && !s.allComplete && (
          <div className="border-t border-border pt-3 mt-1">
            <button
              onClick={() => openWithContext('Completing account setup — source channels (Settings → My Channels) and publishing platforms (Settings → Social Accounts)')}
              className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors group"
            >
              <span className="text-primary group-hover:scale-110 transition-transform">✦</span>
              <span>
                Need help? Your AuraFlux operator can complete this setup for you —
                <span className="text-primary font-medium ml-1">open Collab →</span>
              </span>
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
