'use client';
/**
 * FleetRosterPanel — solo roster fleet on ClipzWorld News (CPD-1067).
 * Polls /api/fleet/status (both sidecars, Tier C encode contract, alerts).
 */

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useRole } from '@/hooks/use-role';
import type { FleetDashboardSnapshot, FleetSlotPhase } from '@/lib/fleet-status';
import { phaseBadgeClass } from '@/lib/fleet-status';

const POLL_MS = 30_000;

function PhasePill({ phase }: { phase: FleetSlotPhase }) {
  return (
    <span className={cn('inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wide', phaseBadgeClass(phase))}>
      {phase}
    </span>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={cn(spinning && 'animate-spin')}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export function FleetRosterPanel() {
  const { isSuperAdmin, isLoaded } = useRole();
  const [data, setData] = useState<FleetDashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spinning, setSpinning] = useState(false);

  const fetchFleet = useCallback(async () => {
    setSpinning(true);
    try {
      const res = await fetch('/api/fleet/status', { cache: 'no-store' });
      const json = (await res.json()) as FleetDashboardSnapshot & { error?: string };
      if (!res.ok) {
        setError(json.error || res.statusText);
        setData(null);
        return;
      }
      setError(null);
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setTimeout(() => setSpinning(false), 400);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSuperAdmin) return;
    fetchFleet();
    const t = setInterval(fetchFleet, POLL_MS);
    return () => clearInterval(t);
  }, [fetchFleet, isLoaded, isSuperAdmin]);

  if (!isLoaded || !isSuperAdmin) return null;

  const tier = data?.tierC;

  return (
    <section className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border bg-muted/20">
        <div>
          <h2 className="text-sm font-semibold tracking-wide uppercase text-foreground">
            Solo Roster Fleet
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            ClipzWorld News · 10 slots · Tier C {tier ? `${tier.w}×${tier.h} @ ${tier.bitrateK}k` : '1080p @ 6800k'} per live encode
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {data && (
            <span className={cn('font-semibold tabular-nums', data.totalLive > 0 ? 'text-red-400' : '')}>
              {data.totalLive} live
            </span>
          )}
          <button
            type="button"
            onClick={() => fetchFleet()}
            className="p-1.5 rounded hover:bg-muted transition-colors"
            aria-label="Refresh fleet status"
          >
            <RefreshIcon spinning={spinning} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm text-destructive bg-destructive/10 border-b border-destructive/20">
          {error}
        </div>
      )}

      {data?.alerts?.length ? (
        <div className="px-4 py-2 text-xs bg-amber-950/40 border-b border-amber-800/40 text-amber-100 space-y-1">
          <div className="font-semibold uppercase tracking-wide text-amber-300/90">Alerts</div>
          {data.alerts.map((a) => (
            <div key={a}>⚠ {a}</div>
          ))}
        </div>
      ) : null}

      {!data && !error && (
        <div className="px-4 py-8 text-sm text-muted-foreground animate-pulse">Loading fleet…</div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
          {data.sidecars.map((sc) => (
            <div key={sc.fleetId} className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{sc.label}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate max-w-[240px]">
                    {sc.url.replace(/^https?:\/\//, '')}
                  </div>
                </div>
                <span className={cn(
                  'text-[10px] font-bold uppercase px-2 py-0.5 rounded border',
                  sc.running ? 'border-red-500/50 text-red-300 bg-red-500/10' : 'border-border text-muted-foreground',
                )}>
                  {sc.running ? 'online' : 'offline'}
                </span>
              </div>

              {sc.encodeContract && (
                <div className="text-[11px] text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1">
                  <span>Encoders configured</span>
                  <span className="text-foreground tabular-nums">{sc.encodeContract.totals?.encoderCount ?? '—'}</span>
                  <span>Video bitrate (configured)</span>
                  <span className="text-foreground tabular-nums">
                    {sc.encodeContract.totals?.configuredVideoBitrateK != null
                      ? `${sc.encodeContract.totals.configuredVideoBitrateK}k`
                      : '—'}
                  </span>
                  <span>YouTube 1080p target</span>
                  <span className={sc.encodeContract.passHints?.allMeetYoutube1080p ? 'text-emerald-400' : 'text-amber-400'}>
                    {sc.encodeContract.passHints?.allMeetYoutube1080p ? 'pass' : 'check'}
                  </span>
                </div>
              )}

              {sc.fleet?.slots?.length ? (
                <ul className="space-y-1.5">
                  {sc.fleet.slots.map((slot) => (
                    <li
                      key={`${sc.fleetId}-${slot.slot}`}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                    >
                      <span className="text-muted-foreground w-12 shrink-0">#{slot.slot}</span>
                      <span className="font-medium">@{slot.login}</span>
                      <PhasePill phase={slot.phase} />
                      {slot.watchUrl && slot.phase === 'live' && (
                        <a
                          href={slot.watchUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-violet-400 hover:underline"
                        >
                          YouTube
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {sc.running ? 'Fleet orchestrator not active on this sidecar.' : 'Sidecar offline — start solo_roster fleet.'}
                </p>
              )}

              {sc.uptimeSec != null && sc.running && (
                <p className="text-[10px] text-muted-foreground">
                  Uptime {Math.floor(sc.uptimeSec / 60)}m · poll every {(sc.fleet?.pollMs ?? 45000) / 1000}s
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <span>Updated {data ? new Date(data.updatedAt).toLocaleTimeString() : '—'}</span>
        <a
          href="https://auraflux-broadcast-staging.onrender.com/live-broadcast/health"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground"
        >
          Sidecar A health
        </a>
        <a
          href="https://auraflux-broadcast-staging-b.onrender.com/live-broadcast/health"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground"
        >
          Sidecar B health
        </a>
        <span>Set Subscribers chat in Studio when reviewing stream-frame thumbnails.</span>
      </div>
    </section>
  );
}
