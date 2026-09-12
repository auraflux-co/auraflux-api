'use client';

/**
 * Creator Schedule — month grid (plan vs published).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { EmptyState } from '@/components/ui/empty-state';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { JobStatusBadge } from '@/components/ui/job-status-badge';
import {
  fetchScheduleMonth,
  saveScheduleMonthDay,
  saveScheduleMonthDefaults,
  fetchScheduleEligibleJobs,
  scheduleJobOnMonth,
  type ScheduleMonthView,
  type ScheduleMonthDayCell,
  type ScheduleEligibleJob,
} from '@/lib/api';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthLabel(year: number, monthNum: number) {
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function statusClass(status: string) {
  switch (status) {
    case 'met': return 'border-emerald-500/40 bg-emerald-500/10';
    case 'partial': return 'border-amber-400/40 bg-amber-400/10';
    case 'missed': return 'border-red-500/40 bg-red-500/10';
    case 'planned': return 'border-sky-500/30 bg-sky-500/5';
    default: return 'border-slate-800 bg-slate-900/40';
  }
}

export function ScheduleMonthGrid({
  getToken,
  brandId,
}: {
  getToken: () => Promise<string | null>;
  brandId: string | null | undefined;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [monthNum, setMonthNum] = useState(now.getUTCMonth() + 1);
  const [view, setView] = useState<ScheduleMonthView | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScheduleMonthDayCell | null>(null);
  const [editShort, setEditShort] = useState(1);
  const [editLong, setEditLong] = useState(0);
  const [editLive, setEditLive] = useState(0);
  const [editNote, setEditNote] = useState('');
  const [defShort, setDefShort] = useState(1);
  const [defLong, setDefLong] = useState(0);
  const [defLive, setDefLive] = useState(0);
  const [eligible, setEligible] = useState<ScheduleEligibleJob[]>([]);
  const [pickJobId, setPickJobId] = useState('');
  const [pickTime, setPickTime] = useState('12:00');
  const [saving, setSaving] = useState(false);

  const ym = `${year}-${String(monthNum).padStart(2, '0')}`;

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const [month, elig] = await Promise.all([
        fetchScheduleMonth(ym, token),
        fetchScheduleEligibleJobs(token),
      ]);
      setView(month);
      setEligible(elig.jobs || []);
      if (month.defaults) {
        setDefShort(month.defaults.short ?? 1);
        setDefLong(month.defaults.longform ?? 0);
        setDefLive(month.defaults.live ?? 0);
      }
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Failed to load month'));
      setView(null);
    } finally {
      setBusy(false);
    }
  }, [getToken, ym, brandId]);

  useEffect(() => {
    void load();
  }, [load]);

  function shiftMonth(delta: number) {
    let y = year;
    let m = monthNum + delta;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setYear(y);
    setMonthNum(m);
    setSelected(null);
  }

  function openDay(date: string | null) {
    if (!date || !view?.daysByDate[date]) return;
    const cell = view.daysByDate[date];
    setSelected(cell);
    setEditShort(cell.planned.short);
    setEditLong(cell.planned.longform);
    setEditLive(cell.planned.live);
    setEditNote(cell.planned.note || '');
    setPickJobId('');
    setPickTime('12:00');
  }

  async function saveDay() {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const res = await saveScheduleMonthDay({
        date: selected.date,
        short: editShort,
        longform: editLong,
        live: editLive,
        note: editNote,
      }, token);
      if (res.month) setView(res.month);
      if (res.day) setSelected(res.day);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Save day failed'));
    } finally {
      setSaving(false);
    }
  }

  async function saveDefaults() {
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const month = await saveScheduleMonthDefaults({
        month: ym,
        short: defShort,
        longform: defLong,
        live: defLive,
      }, token);
      setView(month);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Save defaults failed'));
    } finally {
      setSaving(false);
    }
  }

  async function schedulePicked() {
    if (!selected || !pickJobId) return;
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session not ready');
      const iso = `${selected.date}T${pickTime}:00.000Z`;
      await scheduleJobOnMonth(pickJobId, iso, token);
      await load();
      openDay(selected.date);
    } catch (e) {
      setError(formatUserError(e instanceof Error ? e.message : 'Schedule failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => shiftMonth(-1)}>Prev</Button>
        <p className="text-sm font-semibold text-slate-100 min-w-[10rem] text-center">
          {monthLabel(year, monthNum)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => shiftMonth(1)}>Next</Button>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void load()} disabled={busy}>
          Refresh
        </Button>
      </div>

      {view && (
        <p className="text-xs text-slate-500">
          Cadence goals met on {view.summary.metDays} of {view.summary.plannedDays} planned days this month.
          Colors: met · partial · missed · upcoming plan.
        </p>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Month defaults (uncustomized days)</p>
        <div className="flex flex-wrap gap-3 items-end">
          <TargetField label="Shorts" value={defShort} onChange={setDefShort} />
          <TargetField label="Long-form" value={defLong} onChange={setDefLong} />
          <TargetField label="Live" value={defLive} onChange={setDefLive} />
          <Button type="button" size="sm" onClick={() => void saveDefaults()} disabled={saving}>
            Save defaults
          </Button>
        </div>
      </div>

      {busy && !view ? (
        <PageSkeleton rows={2} />
      ) : view ? (
        <div className="grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((d) => (
            <div key={d} className="text-[10px] font-bold uppercase text-slate-500 text-center py-1">{d}</div>
          ))}
          {view.weeks.flat().map((date, idx) => {
            if (!date) return <div key={`pad-${idx}`} className="min-h-[5.5rem] rounded-lg bg-transparent" />;
            const cell = view.daysByDate[date];
            const dayNum = Number(date.slice(-2));
            const p = cell?.planned;
            const a = cell?.actual;
            return (
              <button
                key={date}
                type="button"
                onClick={() => openDay(date)}
                className={cn(
                  'min-h-[5.5rem] rounded-lg border p-1.5 text-left transition-colors hover:border-amber-400/40',
                  statusClass(cell?.status || 'empty'),
                  selected?.date === date && 'ring-1 ring-amber-400/50',
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-slate-200">{dayNum}</span>
                  {a && a.total > 0 && (
                    <span className="text-[10px] text-slate-400">{a.total} out</span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 leading-tight">
                  Plan {p?.short ?? 0}s / {p?.longform ?? 0}l
                </p>
                {cell?.jobs?.slice(0, 2).map((j) => (
                  <p key={j.jobId} className="text-[10px] text-slate-300 truncate mt-0.5">{j.title || j.jobId}</p>
                ))}
              </button>
            );
          })}
        </div>
      ) : null}

      {selected && (
        <div className="rounded-xl border border-slate-700 bg-slate-950/80 p-4 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-slate-100">{selected.date}</p>
              <p className="text-xs text-slate-500 capitalize">Status: {selected.status}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button>
          </div>

          <div className="flex flex-wrap gap-3 items-end">
            <TargetField label="Shorts" value={editShort} onChange={setEditShort} />
            <TargetField label="Long-form" value={editLong} onChange={setEditLong} />
            <TargetField label="Live" value={editLive} onChange={setEditLive} />
          </div>
          <div>
            <Label className="text-xs text-slate-500">Note</Label>
            <Input value={editNote} onChange={(e) => setEditNote(e.target.value)} className="mt-1" placeholder="Optional day note" />
          </div>
          <Button type="button" size="sm" onClick={() => void saveDay()} disabled={saving}>
            Save day plan
          </Button>

          <div className="border-t border-slate-800 pt-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Jobs this day</p>
            {!selected.jobs.length && (
              <EmptyState
                size="sm"
                className="!py-4"
                title="No jobs on this day"
                description="Publish or schedule a job onto this date."
                action={{ label: 'New job', href: '/myjobs/new' }}
              />
            )}
            {selected.jobs.map((j) => (
              <div key={j.jobId} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-slate-300 truncate flex items-center gap-2">
                  <JobStatusBadge status={j.status} className="shrink-0" />
                  {j.title || j.jobId}
                </span>
                <Link href={`/myjobs/${j.jobId}`} className="text-amber-400 hover:underline shrink-0">Open</Link>
              </div>
            ))}
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Schedule a job onto this day</p>
            {!eligible.length ? (
              <p className="text-xs text-slate-500">No eligible jobs — finish a Short first, then schedule it here.</p>
            ) : (
              <div className="flex flex-wrap gap-2 items-end">
                <div className="min-w-[12rem] flex-1">
                  <Label className="text-xs text-slate-500">Job</Label>
                  <select
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-2 text-xs"
                    value={pickJobId}
                    onChange={(e) => setPickJobId(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {eligible.map((j) => (
                      <option key={j.jobId} value={j.jobId}>
                        {j.title || j.jobId} ({j.status})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Time (UTC)</Label>
                  <Input type="time" value={pickTime} onChange={(e) => setPickTime(e.target.value)} className="mt-1" />
                </div>
                <Button type="button" size="sm" onClick={() => void schedulePicked()} disabled={saving || !pickJobId}>
                  Schedule
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TargetField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <Label className="text-xs text-slate-500">{label}</Label>
      <Input
        type="number"
        min={0}
        max={20}
        value={value}
        onChange={(e) => onChange(Math.max(0, parseInt(e.target.value, 10) || 0))}
        className="mt-1 w-20"
      />
    </div>
  );
}
