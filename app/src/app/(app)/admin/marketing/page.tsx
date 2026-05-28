'use client';
/**
 * /admin/marketing — CPD-402
 * Superadmin-only: edit marketing site page copy without touching Framer.
 * Content saved to Postgres → backend API → Cloudflare Worker reads on each request.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

// ── Page / section schema ─────────────────────────────────────────────────────
// These are the editable sections. Add new sections here to expose them in the UI.
const PAGE_SCHEMA: { page: string; label: string; sections: { key: string; label: string; multiline?: boolean }[] }[] = [
  {
    page: 'pricing',
    label: 'Pricing Page',
    sections: [
      { key: 'hero_headline',    label: 'Hero Headline' },
      { key: 'hero_subtext',     label: 'Hero Subtext',     multiline: true },
      { key: 'operate_headline', label: 'Operate Plan Headline' },
      { key: 'operate_body',     label: 'Operate Plan Body', multiline: true },
      { key: 'guided_headline',  label: 'Guided Plan Headline' },
      { key: 'guided_body',      label: 'Guided Plan Body',  multiline: true },
      { key: 'managed_headline', label: 'Managed Plan Headline' },
      { key: 'managed_body',     label: 'Managed Plan Body', multiline: true },
    ],
  },
  {
    page: 'homepage',
    label: 'Homepage',
    sections: [
      { key: 'hero_headline', label: 'Hero Headline' },
      { key: 'hero_subtext',  label: 'Hero Subtext',  multiline: true },
      { key: 'cta_primary',  label: 'Primary CTA Text' },
      { key: 'cta_secondary', label: 'Secondary CTA Text' },
    ],
  },
  {
    page: 'contact',
    label: 'Contact Page',
    sections: [
      { key: 'faq_1_q',   label: 'FAQ 1 — Question' },
      { key: 'faq_1_a',   label: 'FAQ 1 — Answer',   multiline: true },
      { key: 'faq_2_q',   label: 'FAQ 2 — Question' },
      { key: 'faq_2_a',   label: 'FAQ 2 — Answer',   multiline: true },
      { key: 'faq_3_q',   label: 'FAQ 3 — Question' },
      { key: 'faq_3_a',   label: 'FAQ 3 — Answer',   multiline: true },
      { key: 'faq_4_q',   label: 'FAQ 4 — Question' },
      { key: 'faq_4_a',   label: 'FAQ 4 — Answer',   multiline: true },
    ],
  },
  {
    page: 'roadmap',
    label: 'Roadmap',
    sections: [
      { key: 'hero_headline',         label: 'Hero Headline' },
      { key: 'hero_subtext',          label: 'Hero Subtext',                    multiline: true },
      { key: 'roadmap_subscriptions', label: 'Subscription Platform Publishing', multiline: true },
      { key: 'roadmap_compilation',   label: 'Compilation Carousel',            multiline: true },
      { key: 'roadmap_showfilm',      label: 'Show & Film Content Type',        multiline: true },
      { key: 'roadmap_avatar',        label: 'AI Avatar Video',                 multiline: true },
      { key: 'roadmap_shoppable',     label: 'Shoppable Video',                 multiline: true },
      { key: 'roadmap_paidads',       label: 'Paid Ad Creative',                multiline: true },
    ],
  },
];

type PageContent = Record<string, Record<string, string>>;
type Msg = { text: string; ok: boolean } | null;

type InterpretedChange = {
  page_key: string;
  section_key: string;
  page_label: string;
  section_label: string;
  value: string;
};

export default function MarketingEditorPage() {
  const router           = useRouter();
  const { getToken }     = useAuth();
  const { isSuperAdmin } = useRole();
  const [content, setContent]     = useState<PageContent>({});
  const [draft,   setDraft]       = useState<PageContent>({});
  const [loading, setLoading]     = useState(true);
  const [saving,  setSaving]      = useState<string | null>(null);
  const [msg,     setMsg]         = useState<Msg>(null);
  const [activeTab, setActiveTab]         = useState(PAGE_SCHEMA[0].page);
  const [chatInput, setChatInput]         = useState('');
  const [chatLoading, setChatLoading]     = useState(false);
  const [pendingChanges, setPendingChanges] = useState<InterpretedChange[] | null>(null);
  const [applyingAll, setApplyingAll]     = useState(false);

  useEffect(() => {
    if (isSuperAdmin === false) { router.replace('/admin'); }
  }, [isSuperAdmin, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/admin/marketing/pages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      const { pages } = await res.json();
      const map: PageContent = {};
      for (const row of pages as { page_key: string; section_key: string; content: string }[]) {
        if (!map[row.page_key]) map[row.page_key] = {};
        map[row.page_key][row.section_key] = row.content;
      }
      setContent(map);
      setDraft(JSON.parse(JSON.stringify(map)));
    } catch (e) {
      setMsg({ text: `Load failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { load(); }, [load]);

  function handleChange(pageKey: string, sectionKey: string, value: string) {
    setDraft(prev => ({
      ...prev,
      [pageKey]: { ...(prev[pageKey] ?? {}), [sectionKey]: value },
    }));
  }

  async function save(pageKey: string, sectionKey: string) {
    const key = `${pageKey}/${sectionKey}`;
    setSaving(key);
    setMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/admin/marketing/pages`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ page_key: pageKey, section_key: sectionKey, content: draft[pageKey]?.[sectionKey] ?? '' }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      setContent(prev => ({
        ...prev,
        [pageKey]: { ...(prev[pageKey] ?? {}), [sectionKey]: draft[pageKey]?.[sectionKey] ?? '' },
      }));
      setMsg({ text: 'Saved — Cloudflare cache refreshes within 5 minutes', ok: true });
    } catch (e) {
      setMsg({ text: `Save failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      setSaving(null);
    }
  }

  async function revert(pageKey: string, sectionKey: string) {
    const key = `${pageKey}/${sectionKey}`;
    setSaving(key);
    setMsg(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/admin/marketing/pages/${pageKey}/${sectionKey}`, {
        method:  'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      setContent(prev => {
        const next = { ...prev };
        if (next[pageKey]) { delete next[pageKey][sectionKey]; }
        return next;
      });
      setDraft(prev => {
        const next = { ...prev };
        if (next[pageKey]) { delete next[pageKey][sectionKey]; }
        return next;
      });
      setMsg({ text: 'Reverted to worker default', ok: true });
    } catch (e) {
      setMsg({ text: `Revert failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      setSaving(null);
    }
  }

  async function interpret() {
    if (!chatInput.trim()) return;
    setChatLoading(true);
    setMsg(null);
    setPendingChanges(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_BASE}/api/admin/marketing/interpret`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ instruction: chatInput, currentContent: content }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      if (!body.changes.length) {
        setMsg({ text: 'No matching fields found — try being more specific (e.g. "change the pricing hero headline to…")', ok: false });
      } else {
        setPendingChanges(body.changes);
      }
    } catch (e) {
      setMsg({ text: `Interpret failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      setChatLoading(false);
    }
  }

  async function applyAll() {
    if (!pendingChanges?.length) return;
    setApplyingAll(true);
    setMsg(null);
    try {
      const token = await getToken();
      await Promise.all(pendingChanges.map(c =>
        fetch(`${API_BASE}/api/admin/marketing/pages`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ page_key: c.page_key, section_key: c.section_key, content: c.value }),
        }),
      ));
      // Merge into local content state
      setContent(prev => {
        const next = { ...prev };
        for (const c of pendingChanges) {
          next[c.page_key] = { ...(next[c.page_key] ?? {}), [c.section_key]: c.value };
        }
        return next;
      });
      setDraft(prev => {
        const next = { ...prev };
        for (const c of pendingChanges) {
          next[c.page_key] = { ...(next[c.page_key] ?? {}), [c.section_key]: c.value };
        }
        return next;
      });
      setPendingChanges(null);
      setChatInput('');
      setMsg({ text: `${pendingChanges.length} change${pendingChanges.length > 1 ? 's' : ''} applied — live on auraflux.co now`, ok: true });
    } catch (e) {
      setMsg({ text: `Apply failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally {
      setApplyingAll(false);
    }
  }

  function isDirty(pageKey: string, sectionKey: string) {
    return (draft[pageKey]?.[sectionKey] ?? '') !== (content[pageKey]?.[sectionKey] ?? '');
  }

  if (isSuperAdmin === null || loading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center h-40 text-muted-foreground text-sm animate-pulse">
          Loading…
        </div>
      </PageShell>
    );
  }

  const activePage = PAGE_SCHEMA.find(p => p.page === activeTab);

  return (
    <PageShell>
      <PageHeader
        title="Marketing Site Editor"
        subtitle="Edit auraflux.co page copy. Changes are live within 5 minutes via Cloudflare cache."
      />

      {msg && (
        <div className={`rounded-lg px-4 py-3 text-sm mb-4 ${msg.ok ? 'bg-primary/10 text-primary border border-primary/30' : 'bg-destructive/10 text-destructive border border-destructive/30'}`}>
          {msg.text}
          <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      {/* ── Natural language editor ─────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-card p-4 mb-6 space-y-3">
        <p className="text-sm font-medium text-foreground">Tell the site what to change</p>
        <p className="text-xs text-muted-foreground">
          Describe any change in plain English — e.g. <em>"change the pricing hero headline to 'Publish smarter, not harder'"</em> or <em>"update the Operate plan body to highlight 50 credits per month"</em>.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={e => { setChatInput(e.target.value); setPendingChanges(null); }}
            onKeyDown={e => e.key === 'Enter' && !chatLoading && interpret()}
            placeholder="Describe your change…"
            disabled={chatLoading}
            className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          <button
            onClick={interpret}
            disabled={!chatInput.trim() || chatLoading}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {chatLoading ? 'Thinking…' : 'Preview'}
          </button>
        </div>

        {/* Pending changes preview */}
        {pendingChanges && pendingChanges.length > 0 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-foreground">
              {pendingChanges.length} change{pendingChanges.length > 1 ? 's' : ''} proposed — review and confirm:
            </p>
            {pendingChanges.map((c, i) => (
              <div key={i} className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
                <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
                  {c.page_label} → {c.section_label}
                </p>
                <p className="text-sm text-foreground">{c.value}</p>
              </div>
            ))}
            <div className="flex gap-2 pt-1">
              <button
                onClick={applyAll}
                disabled={applyingAll}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
              >
                {applyingAll ? 'Applying…' : `Apply ${pendingChanges.length > 1 ? 'all' : 'change'}`}
              </button>
              <button
                onClick={() => setPendingChanges(null)}
                className="px-4 py-2 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {PAGE_SCHEMA.map(p => (
          <button
            key={p.page}
            onClick={() => setActiveTab(p.page)}
            className={`px-4 py-2 text-sm font-medium transition-colors rounded-t-md ${
              activeTab === p.page
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {activePage && (
        <div className="space-y-5">
          {activePage.sections.map(sec => {
            const key     = `${activePage.page}/${sec.key}`;
            const current = content[activePage.page]?.[sec.key];
            const dirty   = isDirty(activePage.page, sec.key);
            const isSavingThis = saving === key;

            return (
              <div key={key} className="rounded-lg border border-border bg-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">{sec.label}</label>
                  <div className="flex gap-2">
                    {current !== undefined && (
                      <button
                        onClick={() => revert(activePage.page, sec.key)}
                        disabled={isSavingThis}
                        className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors"
                      >
                        Revert to default
                      </button>
                    )}
                    <button
                      onClick={() => save(activePage.page, sec.key)}
                      disabled={!dirty || isSavingThis}
                      className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
                        dirty && !isSavingThis
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : 'bg-muted text-muted-foreground cursor-not-allowed'
                      }`}
                    >
                      {isSavingThis ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                {sec.multiline ? (
                  <textarea
                    rows={4}
                    value={draft[activePage.page]?.[sec.key] ?? current ?? ''}
                    onChange={e => handleChange(activePage.page, sec.key, e.target.value)}
                    placeholder={current === undefined ? '(using worker default)' : ''}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
                  />
                ) : (
                  <input
                    type="text"
                    value={draft[activePage.page]?.[sec.key] ?? current ?? ''}
                    onChange={e => handleChange(activePage.page, sec.key, e.target.value)}
                    placeholder={current === undefined ? '(using worker default)' : ''}
                    className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                )}

                {current === undefined && (
                  <p className="text-[11px] text-muted-foreground/60">No override stored — worker uses hardcoded default</p>
                )}
                {dirty && (
                  <p className="text-[11px] text-amber-500">Unsaved changes</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
