'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/clerk-compat';
import { useSearchParams } from 'next/navigation';
import { useBrand } from '@/contexts/brand-context';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { PageHeader, PageShell } from '@/components/ui/page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  listTemplates,
  updateTemplate,
  deleteTemplate,
  type JobTemplate,
  type RecurrenceType,
} from '@/lib/api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function recurrenceLabel(tpl: JobTemplate) {
  const time = tpl.recurrenceTime || '09:00';
  if (!tpl.recurrenceType || tpl.recurrenceType === 'once') return 'One-off — run manually';
  if (tpl.recurrenceType === 'daily') return `Daily at ${time} UTC`;
  if (tpl.recurrenceType === 'weekly') return `Every ${DAYS[tpl.recurrenceDay ?? 1]} at ${time} UTC`;
  if (tpl.recurrenceType === 'monthly') return `Monthly on day ${tpl.recurrenceDay ?? 1} at ${time} UTC`;
  return tpl.recurrenceType;
}

export default function TemplatesPage() {
  return (
    <Suspense fallback={<div className="max-w-3xl space-y-6"><div className="h-8 w-48 bg-muted/40 rounded animate-pulse" /></div>}>
      <TemplatesPageContent />
    </Suspense>
  );
}

function TemplatesPageContent() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand }        = useBrand();
  const activeBrandId          = activeBrand?.id;
  const searchParams = useSearchParams();
  const [templates, setTemplates] = useState<JobTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState<RecurrenceType>('once');
  const [editDay, setEditDay] = useState(1);
  const [editTime, setEditTime] = useState('09:00');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: string; confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
  } | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const { templates: tpls } = await listTemplates(token ?? undefined);
        setTemplates(tpls);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load templates');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isLoaded, activeBrandId]);

  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!editId || templates.length === 0) return;
    const tpl = templates.find((t) => t.id === editId);
    if (tpl) startEdit(tpl);
  }, [searchParams, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  function startRename(tpl: JobTemplate) {
    setRenamingId(tpl.id);
    setRenameValue(tpl.name);
  }

  async function saveRename(tpl: JobTemplate) {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === tpl.name) { setRenamingId(null); return; }
    setSaving(tpl.id);
    try {
      const token = await getToken();
      const { template: updated } = await updateTemplate(tpl.id, { name: trimmed }, token ?? undefined);
      setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? updated : t)));
      setRenamingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to rename template');
    } finally {
      setSaving(null);
    }
  }

  function startEdit(tpl: JobTemplate) {
    setEditingId(tpl.id);
    setEditType((tpl.recurrenceType as RecurrenceType) || 'once');
    setEditDay(tpl.recurrenceDay ?? 1);
    setEditTime(tpl.recurrenceTime || '09:00');
  }

  async function saveRecurrence(tpl: JobTemplate) {
    setSaving(tpl.id);
    try {
      const token = await getToken();
      const isRecurring = editType !== 'once';
      const { template: updated } = await updateTemplate(
        tpl.id,
        {
          recurrenceType: editType,
          recurrenceDay: editType === 'once' ? null : editDay,
          recurrenceTime: isRecurring ? editTime : null,
          recurrenceActive: isRecurring,
        },
        token ?? undefined,
      );
      setTemplates((prev) => prev.map((t) => (t.id === tpl.id ? updated : t)));
      setEditingId(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update template');
    } finally {
      setSaving(null);
    }
  }

  function handleDelete(tpl: JobTemplate) {
    setConfirmDialog({
      title: 'Delete template',
      description: `"${tpl.name}" will be permanently deleted and cannot be recovered.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => { setConfirmDialog(null); void doDelete(tpl); },
    });
  }

  async function doDelete(tpl: JobTemplate) {
    setSaving(tpl.id);
    try {
      const token = await getToken();
      await deleteTemplate(tpl.id, token ?? undefined);
      setTemplates((prev) => prev.filter((t) => t.id !== tpl.id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to delete template');
    } finally {
      setSaving(null);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="My Templates"
        subtitle="Reusable job configurations. Save from any completed job and schedule recurring runs."
      >
        <Link href="/myjobs/history" className={cn(buttonVariants({ size: 'sm', variant: 'outline' }))}>
          From job history
        </Link>
      </PageHeader>

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && templates.length === 0 && !error && (
        <EmptyState
          title="No templates yet"
          description="Open a completed job and choose Save as template, or finish a job from the history page."
          action={{ label: 'View job history', href: '/myjobs/history' }}
        />
      )}

      {!loading && templates.length > 0 && (
        <div className="space-y-3">
          {templates.map((tpl) => (
            <div key={tpl.id} className="rounded-lg border border-border px-4 py-3 space-y-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  {renamingId === tpl.id ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveRename(tpl); }}
                      className="flex items-center gap-1"
                    >
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => saveRename(tpl)}
                        onKeyDown={(e) => e.key === 'Escape' && setRenamingId(null)}
                        className="text-sm font-medium border border-border rounded px-2 py-0.5 bg-background w-full max-w-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRename(tpl)}
                      title="Click to rename"
                      className="text-sm font-medium truncate hover:text-primary text-left block max-w-xs"
                    >
                      {tpl.name}
                    </button>
                  )}
                  {tpl.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{tpl.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {tpl.contentType ?? 'custom'}
                    {tpl.platforms?.length ? ` · ${tpl.platforms.join(', ')}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{recurrenceLabel(tpl)}</p>
                  {tpl.nextFireAt && tpl.recurrenceActive && (
                    <p className="text-xs text-muted-foreground">
                      Next run: {new Date(tpl.nextFireAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Link
                    href={`/myjobs/new?templateId=${tpl.id}`}
                    className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'text-xs h-8')}
                  >
                    Run once
                  </Link>
                  <button
                    type="button"
                    onClick={() => (editingId === tpl.id ? setEditingId(null) : startEdit(tpl))}
                    className="text-xs text-primary hover:underline"
                  >
                    {editingId === tpl.id ? 'Cancel' : 'Set recurrence'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(tpl)}
                    disabled={saving === tpl.id}
                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {editingId === tpl.id && (
                <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recurrence cadence
                  </p>
                  <div className="flex flex-wrap gap-3 items-end">
                    <label className="text-xs space-y-1">
                      <span className="text-muted-foreground">Frequency</span>
                      <select
                        value={editType}
                        onChange={(e) => setEditType(e.target.value as RecurrenceType)}
                        className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                      >
                        <option value="once">One-off (manual runs only)</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </label>
                    {editType === 'weekly' && (
                      <label className="text-xs space-y-1">
                        <span className="text-muted-foreground">Day</span>
                        <select
                          value={editDay}
                          onChange={(e) => setEditDay(Number(e.target.value))}
                          className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                        >
                          {DAYS.map((d, i) => (
                            <option key={d} value={i}>{d}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {editType === 'monthly' && (
                      <label className="text-xs space-y-1">
                        <span className="text-muted-foreground">Day of month</span>
                        <input
                          type="number"
                          min={1}
                          max={28}
                          value={editDay}
                          onChange={(e) => setEditDay(Number(e.target.value))}
                          className="block w-16 text-sm border border-border rounded px-2 py-1.5 bg-background"
                        />
                      </label>
                    )}
                    {editType !== 'once' && (
                      <label className="text-xs space-y-1">
                        <span className="text-muted-foreground">Time (UTC)</span>
                        <input
                          type="time"
                          value={editTime}
                          onChange={(e) => setEditTime(e.target.value)}
                          className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => saveRecurrence(tpl)}
                      disabled={saving === tpl.id}
                      className={cn(buttonVariants({ size: 'sm' }), 'text-xs h-8')}
                    >
                      {saving === tpl.id ? 'Saving…' : 'Save cadence'}
                    </button>
                  </div>
                  {editType !== 'once' && (
                    <p className="text-xs text-muted-foreground">
                      Recurring templates appear on Schedule → Recurring and auto-fire when due.
                      Jobs start in Active immediately at fire time.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          open={true}
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmLabel={confirmDialog.confirmLabel}
          destructive={confirmDialog.destructive}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </PageShell>
  );
}
