'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { listTemplates, deleteTemplate, updateTemplate, type JobTemplate, type RecurrenceType } from '@/lib/api';

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const CONTENT_ICONS: Record<string, string> = {
  news: '📰', clips: '🎬', sports: '🏆', show_commentary: '🎙️',
  short: '⚡', custom: '✨',
};

export default function TemplatesPage() {
  const { getToken, isLoaded } = useAuth();
  const [templates, setTemplates] = useState<JobTemplate[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);
  const [editing, setEditing]     = useState<string | null>(null);
  const [editName, setEditName]   = useState('');
  const [editDesc, setEditDesc]   = useState('');
  const [saving, setSaving]       = useState(false);

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
  }, [getToken, isLoaded]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this template? This cannot be undone.')) return;
    setDeleting(id);
    try {
      const token = await getToken();
      await deleteTemplate(id, token ?? undefined);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(null);
    }
  }

  async function handleSaveEdit(id: string) {
    setSaving(true);
    try {
      const token = await getToken();
      const updated = await updateTemplate(id, { name: editName, description: editDesc || undefined }, token ?? undefined);
      setTemplates((prev) => prev.map((t) => t.id === id ? updated.template : t));
      setEditing(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggleRecurrence(tpl: JobTemplate) {
    try {
      const token = await getToken();
      const updated = await updateTemplate(tpl.id, { recurrenceActive: !tpl.recurrenceActive }, token ?? undefined);
      setTemplates((prev) => prev.map((t) => t.id === tpl.id ? updated.template : t));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  function recurrenceLabel(tpl: JobTemplate) {
    if (!tpl.recurrenceType || tpl.recurrenceType === 'once') return null;
    const time = tpl.recurrenceTime || '09:00';
    if (tpl.recurrenceType === 'daily') return `Daily at ${time} UTC`;
    if (tpl.recurrenceType === 'weekly') return `Every ${DAYS[tpl.recurrenceDay ?? 1]} at ${time} UTC`;
    if (tpl.recurrenceType === 'monthly') return `Monthly on the ${tpl.recurrenceDay}th at ${time} UTC`;
    return tpl.recurrenceType;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Templates</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reusable job configurations. Save from any completed job and schedule recurring runs.
          </p>
        </div>
        <a
          href="/dashboard/jobs/new"
          className="text-sm px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          New job
        </a>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">No templates yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            After a job completes, open it and click <strong>Save as template</strong>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((tpl) => {
            const icon = CONTENT_ICONS[tpl.contentType ?? ''] ?? '📄';
            const recLabel = recurrenceLabel(tpl);
            const isEditing = editing === tpl.id;
            return (
              <div key={tpl.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <span className="text-xl mt-0.5 shrink-0">{icon}</span>
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input
                            className="w-full text-sm border border-border rounded px-2 py-1 bg-background font-medium"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="Template name"
                          />
                          <input
                            className="w-full text-xs border border-border rounded px-2 py-1 bg-background text-muted-foreground"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="Description (optional)"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSaveEdit(tpl.id)}
                              disabled={saving || !editName.trim()}
                              className="text-xs text-primary hover:underline disabled:opacity-50"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditing(null)}
                              className="text-xs text-muted-foreground hover:underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm font-medium truncate">{tpl.name}</p>
                          {tpl.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">{tpl.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {tpl.contentType && (
                              <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{tpl.contentType}</span>
                            )}
                            {(tpl.platforms || []).map((p) => (
                              <span key={p} className="text-xs bg-muted px-2 py-0.5 rounded-full">{p}</span>
                            ))}
                          </div>
                          {recLabel && (
                            <div className="flex items-center gap-2 mt-2">
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${tpl.recurrenceActive ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                              <span className="text-xs text-muted-foreground">{recLabel}</span>
                              {tpl.nextFireAt && tpl.recurrenceActive && (
                                <span className="text-xs text-muted-foreground">
                                  — next: {new Date(tpl.nextFireAt).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {!isEditing && (
                    <div className="flex items-center gap-3 shrink-0">
                      <a
                        href={`/dashboard/jobs/new?templateId=${tpl.id}`}
                        className="text-xs text-primary hover:underline"
                      >
                        Use
                      </a>
                      <button
                        onClick={() => {
                          setEditing(tpl.id);
                          setEditName(tpl.name);
                          setEditDesc(tpl.description || '');
                        }}
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        Edit
                      </button>
                      {recLabel && (
                        <button
                          onClick={() => toggleRecurrence(tpl)}
                          className={`text-xs hover:underline ${tpl.recurrenceActive ? 'text-amber-600' : 'text-green-600'}`}
                        >
                          {tpl.recurrenceActive ? 'Pause' : 'Resume'}
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(tpl.id)}
                        disabled={deleting === tpl.id}
                        className="text-xs text-destructive hover:underline disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
