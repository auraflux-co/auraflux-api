'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useBrand } from '@/contexts/brand-context';
import { FlowNetwork } from '@/components/icons/brand-icons';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import {
  listJobs, updateJobSchedule, listTemplates, updateTemplate,
  getScheduleSuggestion, getSchedulePrefs, saveSchedulePrefs,
  type Job, type JobTemplate, type ScheduleSlot, type SchedulePrefs,
} from '@/lib/api';
import { jobDisplayTitle, jobStatusLabel, platformListLabel, formatUserError } from '@/lib/job-labels';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

type Tab = 'upcoming' | 'recurring' | 'history' | 'mySchedule';

const PLATFORMS_DISPLAY: Record<string, string> = {
  youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram',
};
const PLATFORM_COLORS: Record<string, string> = {
  youtube: 'border-red-800/60 text-red-400', tiktok: 'border-cyan-800/60 text-cyan-400',
  instagram: 'border-purple-800/60 text-purple-400',
};
const ALL_PLATFORMS = ['youtube', 'tiktok', 'instagram'] as const;

export default function SchedulePage() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand } = useBrand();
  const activeBrandId = activeBrand?.id;
  const [tab, setTab]               = useState<Tab>('upcoming');
  const [jobs, setJobs]             = useState<Job[]>([]);
  const [templates, setTemplates]   = useState<JobTemplate[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [saving, setSaving]             = useState<string | null>(null);
  const [suggestion, setSuggestion]     = useState<string | null>(null);
  const [suggesting, setSuggesting]     = useState(false);
  const [goalsInput, setGoalsInput]     = useState('');
  const [editingJob, setEditingJob] = useState<string | null>(null);
  const [newDate, setNewDate]       = useState('');
  // My Schedule prefs (CPD-594)
  const [prefs, setPrefs]           = useState<SchedulePrefs>({});
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [prefsMsg, setPrefsMsg]     = useState<string | null>(null);
  const [addSlot, setAddSlot]       = useState<Record<string, { day: string; time: string }>>({});

  useEffect(() => {
    if (!isLoaded) return;
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const [{ jobs: all }, { templates: tpls }, { prefs: savedPrefs }] = await Promise.all([
          listJobs(token ?? undefined),
          listTemplates(token ?? undefined),
          getSchedulePrefs(token ?? undefined),
        ]);
        setJobs(all.filter((j) => j.status === 'queued_scheduled' || j.scheduledPublishAt || j.scheduledStartAt));
        setTemplates(tpls.filter((t) => t.recurrenceType && t.recurrenceType !== 'once'));
        setPrefs(savedPrefs ?? {});
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load schedule');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isLoaded, activeBrandId]);

  const upcoming = jobs.filter((j) => {
    const at = j.scheduledStartAt || j.scheduledPublishAt;
    if (j.status === 'queued_scheduled' && !at) return true;
    return at && new Date(at) > new Date();
  });
  const history = jobs.filter((j) => {
    const at = j.scheduledStartAt || j.scheduledPublishAt;
    return at && new Date(at) <= new Date();
  });
  const recurringActive   = templates.filter((t) => t.recurrenceActive);
  const recurringInactive = templates.filter((t) => !t.recurrenceActive);

  async function handleReschedule(jobId: string) {
    if (!newDate) return;
    setSaving(jobId);
    try {
      const token = await getToken();
      await updateJobSchedule(jobId, 'scheduled', new Date(newDate).toISOString(), token ?? undefined);
      setJobs((prev) => prev.map((j) => j.jobId === jobId
        ? { ...j, scheduledPublishAt: new Date(newDate).toISOString() } : j));
      setEditingJob(null);
      setNewDate('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Reschedule failed');
    } finally {
      setSaving(null);
    }
  }

  async function handleRemove(jobId: string) {
    setSaving(jobId);
    try {
      const token = await getToken();
      await updateJobSchedule(jobId, 'immediate', undefined, token ?? undefined);
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setSaving(null);
    }
  }

  async function handleSuggest() {
    setSuggesting(true);
    setSuggestion(null);
    try {
      const token = await getToken();
      const { suggestion: text } = await getScheduleSuggestion(
        { templates: templates.map((t) => ({ name: t.name, contentType: t.contentType })),
          platforms: [...new Set(templates.flatMap((t) => t.platforms))],
          goals: goalsInput || undefined },
        token ?? undefined,
      );
      setSuggestion(text);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Suggestion failed');
    } finally {
      setSuggesting(false);
    }
  }

  async function toggleTemplate(tpl: JobTemplate) {
    setSaving(tpl.id);
    try {
      const token = await getToken();
      const { template: updated } = await updateTemplate(tpl.id, { recurrenceActive: !tpl.recurrenceActive }, token ?? undefined);
      setTemplates((prev) => prev.map((t) => t.id === tpl.id ? updated : t));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(null);
    }
  }

  async function handleSavePrefs() {
    setPrefsSaving(true);
    setPrefsMsg(null);
    try {
      const token = await getToken();
      const { prefs: saved } = await saveSchedulePrefs(prefs, token ?? undefined);
      setPrefs(saved);
      setPrefsMsg('Saved');
      setTimeout(() => setPrefsMsg(null), 2500);
    } catch {
      setPrefsMsg('Save failed. Please try again.');
    } finally {
      setPrefsSaving(false);
    }
  }

  function addPrefSlot(platform: string) {
    const s = addSlot[platform];
    if (!s?.time) return;
    const day = s.day === '' ? -1 : parseInt(s.day, 10);
    const slot: ScheduleSlot = { day, time: s.time };
    setPrefs((prev) => ({ ...prev, [platform]: [...(prev[platform as keyof SchedulePrefs] ?? []), slot] }));
    setAddSlot((prev) => ({ ...prev, [platform]: { day: '', time: '' } }));
  }

  function removePrefSlot(platform: string, idx: number) {
    setPrefs((prev) => {
      const arr = [...(prev[platform as keyof SchedulePrefs] ?? [])];
      arr.splice(idx, 1);
      return { ...prev, [platform]: arr };
    });
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function recurrenceLabel(tpl: JobTemplate) {
    const time = tpl.recurrenceTime || '09:00';
    if (tpl.recurrenceType === 'daily')   return `Daily at ${time} UTC`;
    if (tpl.recurrenceType === 'weekly')  return `Every ${DAYS[tpl.recurrenceDay ?? 1]} at ${time} UTC`;
    if (tpl.recurrenceType === 'monthly') return `Monthly on the ${tpl.recurrenceDay}th at ${time} UTC`;
    return tpl.recurrenceType ?? '';
  }

  const totalPrefsSlots = ALL_PLATFORMS.reduce((n, p) => n + (prefs[p]?.length ?? 0), 0);
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'upcoming',   label: 'Upcoming',    count: upcoming.length },
    { id: 'recurring',  label: 'Recurring',   count: recurringActive.length + recurringInactive.length },
    { id: 'history',    label: 'History',     count: history.length },
    { id: 'mySchedule', label: 'My Schedule', count: totalPrefsSlots },
  ];

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Schedule"
        subtitle="Upcoming job starts and deferred publishes. Jobs start within a few minutes of their scheduled time."
        badge={<FlowNetwork size={20} className="text-primary shrink-0" />}
      />

      {/* Content strategy tip */}
      <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary shrink-0">
            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          <span className="text-xs font-semibold uppercase tracking-wide text-primary">Recommended Content Mix</span>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border/60 bg-background p-3 space-y-1.5">
            <p className="font-semibold text-foreground">Shorts — 30% of output</p>
            <p className="text-muted-foreground">Post 3–5× per week. Repurpose clips from long-form to multiply output. Acts as a discovery billboard to hook new viewers.</p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background p-3 space-y-1.5">
            <p className="font-semibold text-foreground">Long-form — 70% of output</p>
            <p className="text-muted-foreground">Post 1–2× per month. Aim for 8+ minutes to unlock mid-roll ads. Builds community loyalty and maximises RPM.</p>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Top channels follow a 30/70 Shorts-to-long-form ratio — each format serves a distinct role in growth and monetisation.</p>
      </div>

      {error && <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
            {count > 0 && (
              <span className="ml-1.5 text-xs bg-muted rounded-full px-1.5 py-0.5">{count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="af-body text-muted-foreground">Loading…</p>
      ) : (
        <>
          {/* Upcoming tab */}
          {tab === 'upcoming' && (
            upcoming.length === 0 ? (
              <EmptyState
                title="No upcoming scheduled items"
                description="Use a recurring template or schedule a job start from the job wizard."
                size="sm"
              />
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Job</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Type</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Scheduled</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {upcoming.map((job) => {
                      const isStart = !!job.scheduledStartAt && !job.scheduledPublishAt;
                      const at = job.scheduledStartAt || job.scheduledPublishAt!;
                      return (
                        <tr key={job.jobId} className="hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3">
                            <a href={`/myjobs/${job.jobId}`} className="text-xs font-medium hover:underline">
                              {jobDisplayTitle(job)}
                            </a>
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${isStart ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {isStart ? 'Job start' : 'Publish'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs">
                            {editingJob === job.jobId ? (
                              <input
                                type="datetime-local"
                                className="text-xs border border-border rounded px-2 py-1 bg-background"
                                value={newDate}
                                onChange={(e) => setNewDate(e.target.value)}
                              />
                            ) : fmtDate(at)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              {editingJob === job.jobId ? (
                                <>
                                  <button
                                    onClick={() => handleReschedule(job.jobId)}
                                    disabled={saving === job.jobId || !newDate}
                                    className="text-xs text-primary hover:underline disabled:opacity-50"
                                  >Save</button>
                                  <button
                                    onClick={() => { setEditingJob(null); setNewDate(''); }}
                                    className="text-xs text-muted-foreground hover:underline"
                                  >Cancel</button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditingJob(job.jobId);
                                      setNewDate(new Date(at).toISOString().slice(0, 16));
                                    }}
                                    className="text-xs text-primary hover:underline"
                                  >Reschedule</button>
                                  <button
                                    onClick={() => handleRemove(job.jobId)}
                                    disabled={saving === job.jobId}
                                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                                  >Remove</button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {/* Recurring tab */}
          {tab === 'recurring' && (
            <>
            {/* Collab Schedule Suggestion — CPD-121/122/123 */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary shrink-0">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                </svg>
                <span className="text-xs font-semibold uppercase tracking-wide text-primary">Schedule Assistant</span>
              </div>
              <p className="text-xs text-foreground/80">
                We can draft a publishing schedule based on your templates and goals.
                {' '}Guided customers get a 30-day proposal table. Managed customers get a full calendar ready to queue.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={goalsInput}
                  onChange={(e) => setGoalsInput(e.target.value)}
                  placeholder="Goals or notes (optional) — e.g. 'grow YouTube, 3x/week'"
                  className="flex-1 text-xs border border-border rounded px-3 py-1.5 bg-background"
                />
                <button
                  onClick={handleSuggest}
                  disabled={suggesting}
                  className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {suggesting ? 'Thinking…' : 'Suggest schedule'}
                </button>
              </div>
              {suggestion && (
                <div className="rounded border border-border bg-background p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto">
                  {suggestion}
                </div>
              )}
            </div>

            {templates.length === 0 ? (
              <EmptyState
                title="No recurring schedules"
                description="Go to Templates and set a recurrence cadence on any template."
                action={{ label: 'Go to Templates', href: '/templates' }}
                size="sm"
              />
            ) : (
              <div className="space-y-3">
                {[...recurringActive, ...recurringInactive].map((tpl) => (
                  <div key={tpl.id} className={`rounded-lg border px-4 py-3 flex items-center justify-between gap-4 ${tpl.recurrenceActive ? 'border-border' : 'border-border opacity-60'}`}>
                    <div className="flex-1 min-w-0">
                      <p className="af-body font-medium truncate">{tpl.name}</p>
                      <p className="af-caption mt-0.5">{recurrenceLabel(tpl)}</p>
                      {tpl.nextFireAt && tpl.recurrenceActive && (
                        <p className="af-caption">Next run: {fmtDate(tpl.nextFireAt)}</p>
                      )}
                      {tpl.lastFiredAt && (
                        <p className="text-xs text-muted-foreground">Last fired: {fmtDate(tpl.lastFiredAt)}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <a href={`/templates?edit=${tpl.id}`} className="text-xs text-muted-foreground hover:underline">
                        Edit cadence
                      </a>
                      <button
                        onClick={() => toggleTemplate(tpl)}
                        disabled={saving === tpl.id}
                        className={`text-xs hover:underline disabled:opacity-50 ${tpl.recurrenceActive ? 'text-amber-600' : 'text-green-600'}`}
                      >
                        {tpl.recurrenceActive ? 'Pause' : 'Resume'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
            }
            </>
          )}

          {/* History tab */}
          {tab === 'history' && (
            history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Job</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Platform</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Ran at</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {history.slice(0, 20).map((job) => (
                      <tr key={job.jobId} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <a href={`/myjobs/${job.jobId}`} className="text-xs font-medium hover:underline">
                            {jobDisplayTitle(job)}
                          </a>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                          {platformListLabel(job.platforms ?? [])}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {fmtDate((job.scheduledStartAt || job.scheduledPublishAt)!)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            job.status === 'complete' ? 'bg-green-100 text-green-700' :
                            job.status === 'failed'   ? 'bg-red-100 text-red-700' :
                            'bg-muted text-muted-foreground'
                          }`}>
                            {jobStatusLabel(job.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {/* My Schedule tab */}
          {tab === 'mySchedule' && (
            <div className="space-y-6">
              <p className="text-xs text-muted-foreground">
                Save your preferred publish days and times per platform. These appear as one-click options when scheduling a job from the Review Queue.
              </p>

              {ALL_PLATFORMS.map((platform) => {
                const slots = prefs[platform] ?? [];
                const draft = addSlot[platform] ?? { day: '', time: '' };
                return (
                  <div key={platform} className={`rounded-xl border ${PLATFORM_COLORS[platform]} bg-muted/10 p-4 space-y-3`}>
                    <p className="text-sm font-semibold">{PLATFORMS_DISPLAY[platform]}</p>

                    {/* Existing slots */}
                    {slots.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No saved slots yet.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {slots.map((s, i) => (
                          <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-xs">
                            {s.day === -1 ? 'Daily' : DAYS[s.day]} at {s.time}
                            <button
                              onClick={() => removePrefSlot(platform, i)}
                              className="text-muted-foreground hover:text-destructive transition-colors"
                              aria-label="Remove slot"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Add new slot */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        value={draft.day}
                        onChange={(e) => setAddSlot((prev) => ({ ...prev, [platform]: { ...draft, day: e.target.value } }))}
                        className="rounded border border-border bg-background px-2 py-1 text-xs"
                      >
                        <option value="">Daily</option>
                        {DAYS.map((d, i) => <option key={i} value={String(i)}>{d}</option>)}
                      </select>
                      <input
                        type="time"
                        value={draft.time}
                        onChange={(e) => setAddSlot((prev) => ({ ...prev, [platform]: { ...draft, time: e.target.value } }))}
                        className="rounded border border-border bg-background px-2 py-1 text-xs"
                      />
                      <button
                        onClick={() => addPrefSlot(platform)}
                        disabled={!draft.time}
                        className="text-xs px-3 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 transition-colors"
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Save button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSavePrefs}
                  disabled={prefsSaving}
                  className="text-sm px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {prefsSaving ? 'Saving…' : 'Save my schedule'}
                </button>
                {prefsMsg && (
                  <span className={`text-xs ${prefsMsg === 'Saved' ? 'text-green-500' : 'text-destructive'}`}>
                    {prefsMsg}
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
