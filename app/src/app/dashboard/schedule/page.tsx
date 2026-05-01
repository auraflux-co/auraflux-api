'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { listJobs, updateJobSchedule, type Job } from '@/lib/api';

export default function SchedulePage() {
  const { getToken, isLoaded } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newDate, setNewDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    async function load() {
      try {
        const token = await getToken();
        const { jobs: all } = await listJobs(token ?? undefined);
        setJobs(all.filter((j) => j.publishMode === 'scheduled' || j.scheduledPublishAt));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load schedule');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken, isLoaded]);

  const upcoming = jobs.filter((j) => j.scheduledPublishAt && new Date(j.scheduledPublishAt) > new Date());
  const past     = jobs.filter((j) => j.scheduledPublishAt && new Date(j.scheduledPublishAt) <= new Date());

  async function handleSave(jobId: string) {
    if (!newDate) return;
    setSaving(true);
    setSaveError(null);
    try {
      const token = await getToken();
      await updateJobSchedule(jobId, 'scheduled', new Date(newDate).toISOString(), token ?? undefined);
      setJobs((prev) =>
        prev.map((j) => j.jobId === jobId ? { ...j, scheduledPublishAt: new Date(newDate).toISOString() } : j)
      );
      setEditing(null);
      setNewDate('');
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to update schedule');
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel(jobId: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const token = await getToken();
      await updateJobSchedule(jobId, 'immediate', undefined, token ?? undefined);
      setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : 'Failed to cancel schedule');
    } finally {
      setSaving(false);
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Schedule</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Scheduled publishes run automatically. The cron checks every 5 minutes.</p>
      </div>

      {error && <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>}
      {saveError && <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{saveError}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading schedule…</p>
      ) : (
        <>
          {/* Upcoming */}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">Upcoming</h2>
            {upcoming.length === 0 ? (
              <div className="rounded-lg border border-border px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">No scheduled publishes.</p>
                <p className="text-xs text-muted-foreground mt-1">
                  When you submit a job with a scheduled publish date it will appear here.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Job</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Platform</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Scheduled for</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {upcoming.map((job) => (
                      <tr key={job.jobId} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <a href={`/dashboard/jobs/${job.jobId}`} className="font-mono text-xs hover:underline">
                            {job.jobId.slice(0, 8)}…
                          </a>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                          {(job.platforms ?? []).join(', ') || '—'}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {editing === job.jobId ? (
                            <input
                              type="datetime-local"
                              className="text-xs border border-border rounded px-2 py-1 bg-background"
                              value={newDate}
                              onChange={(e) => setNewDate(e.target.value)}
                            />
                          ) : (
                            fmtDate(job.scheduledPublishAt!)
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {editing === job.jobId ? (
                              <>
                                <button
                                  onClick={() => handleSave(job.jobId)}
                                  disabled={saving || !newDate}
                                  className="text-xs text-primary hover:underline disabled:opacity-50"
                                >
                                  Save
                                </button>
                                <button
                                  onClick={() => { setEditing(null); setNewDate(''); }}
                                  className="text-xs text-muted-foreground hover:underline"
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => {
                                    setEditing(job.jobId);
                                    const d = new Date(job.scheduledPublishAt!);
                                    setNewDate(d.toISOString().slice(0, 16));
                                  }}
                                  className="text-xs text-primary hover:underline"
                                >
                                  Reschedule
                                </button>
                                <button
                                  onClick={() => handleCancel(job.jobId)}
                                  disabled={saving}
                                  className="text-xs text-destructive hover:underline disabled:opacity-50"
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Past scheduled */}
          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">Recently published</h2>
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Job</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Platform</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Published</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {past.slice(0, 10).map((job) => (
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
                          {fmtDate(job.scheduledPublishAt!)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
