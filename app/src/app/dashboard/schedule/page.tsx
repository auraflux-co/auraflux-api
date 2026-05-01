'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  listJobs, updateJobSchedule, listTemplates, updateTemplate,
  getScheduleSuggestion,
  type Job, type JobTemplate,
} from '@/lib/api';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

type Tab = 'upcoming' | 'recurring' | 'history';

export default function SchedulePage() {
  const { getToken, isLoaded } = useAuth();
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

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const [{ jobs: all }, { templates: tpls }] = await Promise.all([
          listJobs(token ?? undefined),
          listTemplates(token ?? undefined),
        ]);
        setJobs(all.filter((j) => j.scheduledPublishAt || j.scheduledStartAt));
        setTemplates(tpls.filter((t) => t.recurrenceType && t.recurrenceType !== 'once'));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load schedule');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isLoaded]);

  const upcoming = jobs.filter((j) => {
    const at = j.scheduledStartAt || j.scheduledPublishAt;
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

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'upcoming',  label: 'Upcoming',  count: upcoming.length },
    { id: 'recurring', label: 'Recurring', count: recurringActive.length + recurringInactive.length },
    { id: 'history',   label: 'History',   count: history.length },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Schedule</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Upcoming job starts and deferred publishes. Cron checks every 5 minutes.
        </p>
      </div>

      {error && <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>}

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
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {/* Upcoming tab */}
          {tab === 'upcoming' && (
            upcoming.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm font-medium">No upcoming scheduled items</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Use a recurring template or schedule a job start from the job wizard.
                </p>
              </div>
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
                            <a href={`/dashboard/jobs/${job.jobId}`} className="font-mono text-xs hover:underline">
                              {job.jobId.slice(0, 8)}…
                            </a>
                            {(job as Job & { templateName?: string }).templateName && (
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {(job as Job & { templateName?: string }).templateName}
                              </p>
                            )}
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
            {/* Copilot Schedule Suggestion — CPD-121/122/123 */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-primary shrink-0">
                  <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                </svg>
                <span className="text-xs font-semibold uppercase tracking-wide text-primary">AuraFlux Copilot</span>
              </div>
              <p className="text-xs text-foreground/80">
                Copilot can draft a publishing schedule based on your templates and goals.
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
              <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm font-medium">No recurring schedules</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Go to <a href="/dashboard/templates" className="underline">Templates</a> and set a recurrence cadence on any template.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {[...recurringActive, ...recurringInactive].map((tpl) => (
                  <div key={tpl.id} className={`rounded-lg border px-4 py-3 flex items-center justify-between gap-4 ${tpl.recurrenceActive ? 'border-border' : 'border-border opacity-60'}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{tpl.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{recurrenceLabel(tpl)}</p>
                      {tpl.nextFireAt && tpl.recurrenceActive && (
                        <p className="text-xs text-muted-foreground">Next run: {fmtDate(tpl.nextFireAt)}</p>
                      )}
                      {tpl.lastFiredAt && (
                        <p className="text-xs text-muted-foreground">Last fired: {fmtDate(tpl.lastFiredAt)}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <a href={`/dashboard/templates`} className="text-xs text-muted-foreground hover:underline">
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
                          <a href={`/dashboard/jobs/${job.jobId}`} className="font-mono text-xs hover:underline">
                            {job.jobId.slice(0, 8)}…
                          </a>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                          {(job.platforms ?? []).join(', ') || '—'}
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
                            {job.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
