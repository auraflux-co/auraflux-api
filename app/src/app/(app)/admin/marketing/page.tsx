'use client';
/**
 * /admin/marketing — CPD-402
 * Superadmin-only: AI-powered marketing site editor.
 * All edits go through Gemini → worker_edit / html_patch / html_patches.
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://auraflux-api.onrender.com';

const SUGGESTED_PROMPTS = [
  { label: 'What can I edit?', prompt: 'List all the pages you can edit and what kind of content changes are easiest to make on each.' },
  { label: 'Update Plans headline', prompt: 'Update the Plans page (/plans) hero headline to be more compelling and conversion-focused.' },
  { label: 'Add roadmap item', prompt: 'Add a new feature to the Now column on the roadmap: "Multi-language Voiceover" — AI-generated voiceover in Spanish, French, and Portuguese.' },
  { label: 'Our Story bio', prompt: 'Update the founder bio on the Our Story page (/our-story) to be more personal and compelling. Keep it concise.' },
  { label: 'Blog posts', prompt: 'Update the blog page post titles and descriptions to feel more specific and less generic.' },
  { label: 'Home social proof', prompt: 'Update the Trusted By section on the homepage — make the platform quotes feel more authentic and specific.' },
  { label: 'Our System copy', prompt: 'Review the portal descriptions on the Our System page and make them more customer-friendly and less technical.' },
];

type ChatMessage = { role: 'user' | 'assistant'; text: string };

type HtmlPatch  = { page: string; description: string; html: string };
type HtmlPatches = HtmlPatch[];
type WorkerEdit  = { description: string; edits: { constant: string; value: string }[] };

export default function MarketingEditorPage() {
  const router           = useRouter();
  const { getToken }     = useAuth();
  const { isSuperAdmin } = useRole();

  const [chatInput,        setChatInput]        = useState('');
  const [chatLoading,      setChatLoading]      = useState(false);
  const [chatHistory,      setChatHistory]      = useState<ChatMessage[]>([]);
  const [msg,              setMsg]              = useState<{ text: string; ok: boolean } | null>(null);

  const [pendingWorkerEdit, setPendingWorkerEdit] = useState<WorkerEdit | null>(null);
  const [pendingPatch,      setPendingPatch]      = useState<HtmlPatch | null>(null);
  const [pendingPatches,    setPendingPatches]    = useState<HtmlPatches | null>(null);
  const [applying,         setApplying]          = useState(false);

  useEffect(() => {
    if (isSuperAdmin === false) router.replace('/admin');
  }, [isSuperAdmin, router]);

  async function send(text?: string) {
    const userText = (text ?? chatInput).trim();
    if (!userText || chatLoading) return;
    setChatHistory(h => [...h, { role: 'user', text: userText }]);
    setChatInput('');
    setChatLoading(true);
    setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/marketing/interpret`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ instruction: userText }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);

      if (body.type === 'message') {
        setChatHistory(h => [...h, { role: 'assistant', text: body.message }]);
      } else if (body.type === 'worker_edit') {
        setPendingWorkerEdit({ description: body.description, edits: body.edits });
        const names = body.edits.map((e: { constant: string }) => `**${e.constant}**`).join(', ');
        setChatHistory(h => [...h, { role: 'assistant', text: `Updating ${names} → ${body.description}` }]);
      } else if (body.type === 'html_patch') {
        setPendingPatch({ page: body.page, description: body.description, html: body.html });
        setChatHistory(h => [...h, { role: 'assistant', text: `Ready to patch **${body.page}**: ${body.description}` }]);
      } else if (body.type === 'html_patches') {
        setPendingPatches(body.patches);
        const pages = body.patches.map((p: HtmlPatch) => `**${p.page}**`).join(', ');
        setChatHistory(h => [...h, { role: 'assistant', text: `Ready to patch ${pages} — review and deploy below.` }]);
      } else {
        setChatHistory(h => [...h, { role: 'assistant', text: `⚠️ Unhandled type "${body.type}": ${JSON.stringify(body).slice(0, 300)}` }]);
      }
    } catch (e) {
      setChatHistory(h => [...h, { role: 'assistant', text: `Something went wrong: ${e instanceof Error ? e.message : e}` }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function deployWorkerEdit() {
    if (!pendingWorkerEdit) return;
    setApplying(true); setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/marketing/worker-edit`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ edits: pendingWorkerEdit.edits }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      const names = pendingWorkerEdit.edits.map(e => e.constant).join(', ');
      setPendingWorkerEdit(null);
      setChatHistory(h => [...h, { role: 'assistant', text: `✅ Deployed — ${names} updated on auraflux.co` }]);
      setMsg({ text: `${names} live within ~60 seconds`, ok: true });
    } catch (e) {
      setMsg({ text: `Deploy failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally { setApplying(false); }
  }

  async function deployPatch() {
    if (!pendingPatch) return;
    setApplying(true); setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/marketing/html-patch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ page: pendingPatch.page, html: pendingPatch.html }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      setChatHistory(h => [...h, { role: 'assistant', text: `✅ **${pendingPatch.page}** is live on auraflux.co` }]);
      setPendingPatch(null);
      setMsg({ text: `${pendingPatch.page} live within ~60 seconds`, ok: true });
    } catch (e) {
      setMsg({ text: `Deploy failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally { setApplying(false); }
  }

  async function deployPatches() {
    if (!pendingPatches?.length) return;
    setApplying(true); setMsg(null);
    try {
      const token = await getToken();
      const res   = await fetch(`${API_BASE}/api/admin/marketing/html-patches`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ patches: pendingPatches.map(p => ({ page: p.page, html: p.html })) }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error);
      const pages = pendingPatches.map(p => p.page).join(', ');
      setChatHistory(h => [...h, { role: 'assistant', text: `✅ ${pages} live on auraflux.co` }]);
      setPendingPatches(null);
      setMsg({ text: `${pages} live within ~60 seconds`, ok: true });
    } catch (e) {
      setMsg({ text: `Deploy failed: ${e instanceof Error ? e.message : e}`, ok: false });
    } finally { setApplying(false); }
  }

  const isEmpty = chatHistory.length === 0 && !pendingWorkerEdit && !pendingPatch && !pendingPatches;

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
        title="Marketing Site Editor"
        subtitle="Chat with Gemini to edit auraflux.co. Changes deploy to Cloudflare in ~60 seconds."
      />

      {msg && (
        <div className={`rounded-lg px-4 py-3 text-sm mb-4 flex items-center justify-between ${msg.ok ? 'bg-primary/10 text-primary border border-primary/30' : 'bg-destructive/10 text-destructive border border-destructive/30'}`}>
          {msg.text}
          <button className="opacity-60 hover:opacity-100 ml-3" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col" style={{ minHeight: '70vh' }}>

        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm font-medium text-foreground">Marketing Assistant</span>
          </div>
          {!isEmpty && (
            <button
              onClick={() => { setChatHistory([]); setPendingWorkerEdit(null); setPendingPatch(null); setPendingPatches(null); setMsg(null); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>

        {/* Empty state with suggested prompts */}
        {isEmpty ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 gap-8">
            <div className="text-center space-y-2">
              <p className="text-base font-medium text-foreground">What would you like to change?</p>
              <p className="text-sm text-muted-foreground">Describe the change in plain English — Gemini will edit the site and queue a deploy.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 w-full max-w-xl">
              {SUGGESTED_PROMPTS.map(s => (
                <button
                  key={s.label}
                  onClick={() => send(s.prompt)}
                  disabled={chatLoading}
                  className="text-left px-3 py-2.5 rounded-lg border border-border bg-background hover:border-primary/40 hover:bg-primary/5 transition-all text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Chat history */
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {chatHistory.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-muted text-foreground rounded-bl-sm'
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-xl rounded-bl-sm px-3 py-2.5 text-sm flex items-center gap-2 text-muted-foreground">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
                  </span>
                  Working…
                </div>
              </div>
            )}
          </div>
        )}

        {/* Pending action cards */}
        {(pendingWorkerEdit || pendingPatch || pendingPatches) && (
          <div className="border-t border-border px-4 py-3 space-y-2 flex-shrink-0">

            {/* Worker Edit */}
            {pendingWorkerEdit && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wide">Worker Edit</span>
                  <span className="text-xs text-muted-foreground">affects all pages</span>
                </div>
                <p className="text-sm text-foreground">{pendingWorkerEdit.description}</p>
                {pendingWorkerEdit.edits.map((e, i) => (
                  <details key={i}>
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      ▾ {e.constant} ({e.value.length.toLocaleString()} chars)
                    </summary>
                    <pre className="mt-2 text-[11px] text-muted-foreground bg-background rounded p-2 overflow-auto max-h-36 border border-border whitespace-pre-wrap break-all">
                      {e.value.slice(0, 1500)}{e.value.length > 1500 ? '\n…' : ''}
                    </pre>
                  </details>
                ))}
                <div className="flex gap-2 pt-1">
                  <button onClick={deployWorkerEdit} disabled={applying} className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40 transition-colors">
                    {applying ? 'Deploying…' : 'Deploy to auraflux.co'}
                  </button>
                  <button onClick={() => setPendingWorkerEdit(null)} className="px-4 py-2 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Discard</button>
                </div>
              </div>
            )}

            {/* Multi-page patches */}
            {pendingPatches && pendingPatches.length > 0 && (
              <div className="space-y-2">
                {pendingPatches.map((p, i) => (
                  <div key={i} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wide">Patch {i + 1}/{pendingPatches.length}</span>
                      <span className="text-[11px] text-muted-foreground font-mono">{p.page}</span>
                    </div>
                    <p className="text-sm text-foreground">{p.description}</p>
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">▾ View HTML ({p.html.length.toLocaleString()} chars)</summary>
                      <pre className="mt-2 text-[11px] text-muted-foreground bg-background rounded p-2 overflow-auto max-h-36 border border-border whitespace-pre-wrap break-all">
                        {p.html.slice(0, 2000)}{p.html.length > 2000 ? '\n…' : ''}
                      </pre>
                    </details>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button onClick={deployPatches} disabled={applying} className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-semibold hover:bg-amber-400 disabled:opacity-40 transition-colors">
                    {applying ? 'Deploying…' : `Deploy all ${pendingPatches.length} pages`}
                  </button>
                  <button onClick={() => setPendingPatches(null)} className="px-4 py-2 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Discard</button>
                </div>
              </div>
            )}

            {/* Single patch */}
            {pendingPatch && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wide">HTML Patch</span>
                  <span className="text-[11px] text-muted-foreground font-mono">{pendingPatch.page}</span>
                </div>
                <p className="text-sm text-foreground">{pendingPatch.description}</p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">▾ View HTML ({pendingPatch.html.length.toLocaleString()} chars)</summary>
                  <pre className="mt-2 text-[11px] text-muted-foreground bg-background rounded p-2 overflow-auto max-h-36 border border-border whitespace-pre-wrap break-all">
                    {pendingPatch.html.slice(0, 3000)}{pendingPatch.html.length > 3000 ? '\n…' : ''}
                  </pre>
                </details>
                <div className="flex gap-2 pt-1">
                  <button onClick={deployPatch} disabled={applying} className="px-4 py-2 rounded-md bg-amber-500 text-black text-sm font-semibold hover:bg-amber-400 disabled:opacity-40 transition-colors">
                    {applying ? 'Deploying…' : 'Deploy to auraflux.co'}
                  </button>
                  <button onClick={() => setPendingPatch(null)} className="px-4 py-2 rounded-md border border-border text-sm text-muted-foreground hover:text-foreground transition-colors">Discard</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Input */}
        <div className={`flex gap-2 p-3 flex-shrink-0 ${!isEmpty ? 'border-t border-border' : ''}`}>
          <input
            type="text"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !chatLoading && send()}
            placeholder={isEmpty ? 'Describe a change or ask a question…' : 'Reply…'}
            disabled={chatLoading}
            className="flex-1 px-3 py-2 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          <button
            onClick={() => send()}
            disabled={!chatInput.trim() || chatLoading}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </PageShell>
  );
}
