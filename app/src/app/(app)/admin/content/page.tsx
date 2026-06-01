'use client';
/**
 * /admin/content — CPD-490
 * Superadmin: Edit in-app UI copy without a deploy.
 * DB overrides win over JSON defaults; delete a row to reset.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.auraflux.co';

const PAGE_KEYS = [
  'global',
  'myjobs',
  'generate',
  'billing',
  'settings',
  'collab',
  'admin',
];

type Override = { key: string; value: string; updated_by: string; updated_at: string };

export default function AppContentPage() {
  const router           = useRouter();
  const { getToken }     = useAuth();
  const { isSuperAdmin } = useRole();

  const [selectedPage, setSelectedPage] = useState<string>('myjobs');
  const [overrides,    setOverrides]    = useState<Override[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [saving,       setSaving]       = useState<string | null>(null);
  const [msg,          setMsg]          = useState<{ text: string; ok: boolean } | null>(null);

  // For add-new form
  const [newKey,   setNewKey]   = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    if (isSuperAdmin === false) router.replace('/admin');
  }, [isSuperAdmin, router]);

  useEffect(() => {
    loadOverrides(selectedPage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPage]);

  async function loadOverrides(page: string) {
    setLoading(true);
    setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/app-content/${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setOverrides(data.overrides ?? []);
    } catch {
      setMsg({ text: 'Failed to load overrides', ok: false });
    } finally {
      setLoading(false);
    }
  }

  async function save(key: string, value: string) {
    setSaving(key);
    setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/app-content`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ page_key: selectedPage, key, value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setMsg({ text: `"${key}" saved`, ok: true });
      loadOverrides(selectedPage);
    } catch (e) {
      setMsg({ text: `Save failed: ${e instanceof Error ? e.message : String(e)}`, ok: false });
    } finally {
      setSaving(null);
    }
  }

  async function resetKey(key: string) {
    if (!confirm(`Reset "${key}" to default? The DB override will be deleted.`)) return;
    setSaving(key);
    try {
      const token = await getToken();
      await fetch(`${API_BASE}/api/admin/app-content/${selectedPage}/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      setMsg({ text: `"${key}" reset to default`, ok: true });
      loadOverrides(selectedPage);
    } catch {
      setMsg({ text: 'Reset failed', ok: false });
    } finally {
      setSaving(null);
    }
  }

  async function addNew() {
    if (!newKey.trim() || !newValue.trim()) return;
    await save(newKey.trim(), newValue.trim());
    setNewKey('');
    setNewValue('');
  }

  if (isSuperAdmin === null) {
    return (
      <PageShell>
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm animate-pulse">Loading…</div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="App Content Editor"
        subtitle="Override UI copy on any app page. Changes take effect within 5 minutes (cached). Delete a row to reset to default."
      />

      {msg && (
        <div className={`rounded-lg px-4 py-3 text-sm mb-4 flex items-center justify-between ${msg.ok ? 'bg-primary/10 text-primary border border-primary/30' : 'bg-destructive/10 text-destructive border border-destructive/30'}`}>
          {msg.text}
          <button className="opacity-60 hover:opacity-100 ml-3" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="flex gap-6">
        {/* Page picker */}
        <div className="w-40 shrink-0">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Page</p>
          <div className="space-y-1">
            {PAGE_KEYS.map(k => (
              <button
                key={k}
                onClick={() => setSelectedPage(k)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  selectedPage === k
                    ? 'bg-primary/10 text-primary border border-primary/30'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        {/* Overrides table */}
        <div className="flex-1 space-y-4">
          {loading ? (
            <div className="text-sm text-muted-foreground animate-pulse">Loading overrides…</div>
          ) : overrides.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No overrides for <strong>{selectedPage}</strong> — app is using JSON defaults. Add a key below to override.
            </div>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-40">Key</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Value</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide w-36">Last updated</th>
                    <th className="w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {overrides.map(row => (
                    <OverrideRow
                      key={row.key}
                      row={row}
                      saving={saving === row.key}
                      onSave={(v) => save(row.key, v)}
                      onReset={() => resetKey(row.key)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add new override */}
          <div className="rounded-xl border border-border p-4 space-y-3">
            <p className="text-sm font-semibold text-foreground">Add override</p>
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="key  e.g. empty_state_title"
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                className="w-52 px-3 py-2 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <input
                type="text"
                placeholder="value"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addNew()}
                className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                onClick={addNew}
                disabled={!newKey.trim() || !newValue.trim() || saving !== null}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

function OverrideRow({
  row,
  saving,
  onSave,
  onReset,
}: {
  row: Override;
  saving: boolean;
  onSave: (v: string) => void;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(row.value);

  function commit() {
    if (draft.trim() !== row.value) onSave(draft.trim());
    setEditing(false);
  }

  return (
    <tr className="group hover:bg-muted/20 transition-colors">
      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{row.key}</td>
      <td className="px-4 py-2.5">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={commit}
            className="w-full px-2 py-1 rounded border border-primary/40 bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        ) : (
          <span
            onClick={() => setEditing(true)}
            className="cursor-pointer hover:text-primary transition-colors"
          >
            {row.value}
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground">
        {new Date(row.updated_at).toLocaleDateString()}
      </td>
      <td className="px-4 py-2.5">
        <button
          onClick={onReset}
          disabled={saving}
          className="text-xs text-destructive/60 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all disabled:opacity-40"
        >
          Reset
        </button>
      </td>
    </tr>
  );
}
