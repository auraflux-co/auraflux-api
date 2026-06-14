'use client';
/**
 * /support — AuraFlux Support (CPD-115)
 *
 * Tier-gated support experience:
 *   Operate (≤30 days): AI chat + Confluence guides, no escalation
 *   Operate (>30 days): Confluence guides only, upgrade prompt
 *   Guided / Managed:   AI chat + guides + SMS escalation + email last resort
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { usePlan } from '@/contexts/plan-context';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  supportChat,
  getSupportSessions,
  resolveSupportSession,
  escalateSupportSession,
  type SupportSession,
  type SupportMessage,
  getSupportSessionMessages,
} from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Handles both Unix-ms numbers/strings and ISO date strings from the DB. */
function fmtSessionDate(raw: number | string | null | undefined): string {
  if (!raw) return 'Unknown date';
  const ms = typeof raw === 'number' ? raw : Number(raw);
  const d  = !isNaN(ms) && ms > 1_000_000_000 ? new Date(ms) : new Date(raw as string);
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORT_SMS   = process.env.NEXT_PUBLIC_SUPPORT_SMS_NUMBER || '+1 571 500 1787';
const GUIDE_URL     = 'https://aurafluxco.atlassian.net/wiki/spaces/AF/pages/6684693/Customer+Guide+Using+AuraFlux';

const GUIDE_LINKS = [
  { label: 'Getting started with AuraFlux',         url: GUIDE_URL },
  { label: 'Submitting your first job',             url: GUIDE_URL + '#submitting' },
  { label: 'Understanding job statuses',            url: GUIDE_URL + '#statuses' },
  { label: 'Publishing to YouTube / TikTok',        url: GUIDE_URL + '#publish' },
  { label: 'Credits, billing & plans',              url: '/billing' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMsg { role: 'user' | 'assistant'; content: string }

// ─── Tier helpers ─────────────────────────────────────────────────────────────

function getAccountAgeDays(user: ReturnType<typeof useUser>['user']): number {
  if (!user?.createdAt) return 0; // no date = new account, give benefit of the doubt
  return Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GuidesPanel() {
  return (
    <aside className="w-full lg:w-72 shrink-0 space-y-4">
      <div className="rounded-lg border border-border p-4">
        <h2 className="af-subhead mb-3">Guides</h2>
        <ul className="space-y-1.5">
          {GUIDE_LINKS.map((g) => (
            <li key={g.label}>
              <a
                href={g.url}
                target={g.url.startsWith('http') ? '_blank' : undefined}
                rel="noopener noreferrer"
                className="flex items-start gap-2 af-body hover:text-foreground transition-colors group"
              >
                <svg className="shrink-0 mt-0.5 text-primary/60 group-hover:text-primary" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                {g.label}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-2">
        <h2 className="af-subhead">Need more help?</h2>
        <p className="af-caption text-muted-foreground">
          Use the chat on the left to describe your issue. Our team monitors all conversations and will respond directly in the thread.
        </p>
      </div>
    </aside>
  );
}

function EscalateModal({
  sessionId, userName, userEmail, plan,
  onClose, onDone,
}: {
  sessionId: string | null; userName: string; userEmail: string; plan: string;
  onClose: () => void; onDone: () => void;
}) {
  const { getToken } = useAuth();
  const [summary, setSummary]   = useState('');
  const [sending, setSending]   = useState(false);
  const [error,   setError]     = useState<string | null>(null);

  async function send() {
    if (!summary.trim()) return;
    setSending(true);
    try {
      const token = await getToken();
      await escalateSupportSession({ sessionId, summary, userName, userEmail }, token ?? undefined);
      onDone();
    } catch {
      setError('Could not send escalation. Please try SMS instead.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-6 space-y-4 mx-4">
        <h3 className="af-subhead">Email the AuraFlux team</h3>
        <p className="af-body">
          This sends your issue directly to the AuraFlux team. For a faster response, use the text support button instead.
        </p>
        <textarea
          className="w-full rounded-md border border-border bg-background text-sm p-3 resize-none h-28 focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Describe your issue in detail..."
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {error && <p className="af-caption text-destructive">{formatUserError(error)}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-border text-sm hover:bg-accent/50">Cancel</button>
          <button
            onClick={send}
            disabled={sending || !summary.trim()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send to AuraFlux team'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionHistory({
  sessions, onSelect, activeId,
}: {
  sessions: SupportSession[]; onSelect: (s: SupportSession) => void; activeId: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!sessions.length) return null;
  const displayed = showAll ? sessions : sessions.slice(0, 5);
  return (
    <div>
      <h2 className="af-subhead mb-3">Past sessions</h2>
      <div className="space-y-2">
        {displayed.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s)}
            className={cn(
              'w-full text-left rounded-lg border transition-colors p-4',
              s.id === activeId
                ? 'border-primary/40 bg-primary/5'
                : 'border-border hover:border-border/80 hover:bg-muted/30',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <p className="af-label font-medium">{fmtSessionDate(s.created_at)}</p>
                <p className="af-caption text-muted-foreground">
                  {s.message_count} message{s.message_count !== 1 ? 's' : ''}
                  {s.resolved ? ' · Resolved' : ' · Open'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {s.escalated && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 font-medium">Escalated</span>
                )}
                {s.resolved ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-500 font-medium">Resolved</span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium">Open</span>
                )}
              </div>
            </div>
            <p className="af-caption text-primary mt-2">
              {s.resolved ? 'View thread →' : 'Continue or reopen →'}
            </p>
          </button>
        ))}
      </div>
      {sessions.length > 5 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="af-caption text-primary underline underline-offset-2 mt-2 hover:no-underline"
        >
          {showAll ? 'Show fewer' : `Show all ${sessions.length} sessions`}
        </button>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SupportPage() {
  const { getToken, isLoaded } = useAuth();
  const { user }               = useUser();
  const { planTier }           = usePlan();

  const plan    = planTier || 'operate';
  const ageDays = getAccountAgeDays(user);
  const canChat = plan === 'guided' || plan === 'managed' || (plan === 'operate' && ageDays <= 30);
  const canEsc  = plan === 'guided' || plan === 'managed';

  const [messages,   setMessages]   = useState<ChatMsg[]>([
    { role: 'assistant', content: "Hi! I'm Collab. What issue are you running into today?" },
  ]);
  const [input,      setInput]      = useState('');
  const [loading,    setLoading]    = useState(false);
  const [sessionId,  setSessionId]  = useState<string | null>(null);
  const [sessions,   setSessions]   = useState<SupportSession[]>([]);
  const [showEsc,    setShowEsc]    = useState(false);
  const [escalated,  setEscalated]  = useState(false);
  const [resolved,   setResolved]   = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const userName  = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Customer';
  const userEmail = user?.emailAddresses?.[0]?.emailAddress || '';

  const loadSessions = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await getSupportSessions(token ?? undefined);
      if (r.ok) setSessions(r.sessions);
    } catch { /* non-fatal */ }
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    loadSessions();
  }, [loadSessions, isLoaded]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function handleSessionSelect(s: SupportSession) {
    try {
      const token = await getToken();
      const r = await getSupportSessionMessages(s.id, token ?? undefined);
      if (r.ok) {
        setMessages(r.messages.map((m) => ({ role: m.role, content: m.content })));
        setSessionId(s.id);
        setResolved(s.resolved);
        setEscalated(s.escalated);
      }
    } catch { /* non-fatal */ }
  }

  async function send() {
    if (!input.trim() || loading) return;
    const userMsg: ChatMsg = { role: 'user', content: input.trim() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    setInput('');
    setLoading(true);

    try {
      const token = await getToken();
      const r = await supportChat(
        newMsgs.map((m) => ({ role: m.role, content: m.content })),
        sessionId,
        token ?? undefined,
      );
      if (r.ok) {
        setMessages((prev) => [...prev, { role: 'assistant', content: r.response }]);
        if (!sessionId) { setSessionId(r.sessionId); loadSessions(); }
      }
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble responding. Please try again or use the text support button on the right.',
      }]);
    } finally {
      setLoading(false);
    }
  }

  async function handleResolve() {
    if (!sessionId) return;
    try {
      const token = await getToken();
      await resolveSupportSession(sessionId, token ?? undefined);
      setResolved(true);
      loadSessions();
    } catch { /* non-fatal */ }
  }

  const supportSubtitle = plan === 'operate' && ageDays <= 30
    ? `Support is available during your first month (${30 - ageDays} days remaining). Upgrade to Guided for ongoing support.`
    : plan === 'operate'
    ? 'Your trial support period has ended. Use the guides below or upgrade to Guided for ongoing support.'
    : 'Chat with our team or browse the guides below.';

  return (
    <PageShell maxWidth="4xl">
      <PageHeader title="Support" subtitle={supportSubtitle} />

      {/* ── Past sessions (above chat) ── */}
      {sessions.length > 0 && (
        <SessionHistory sessions={sessions} onSelect={handleSessionSelect} activeId={sessionId} />
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ── Chat panel ── */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="rounded-lg border border-border flex flex-col min-h-[300px] h-[50vh] max-h-[480px]">
            {/* Messages — scrollable */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div className={cn(
                    'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-br-sm'
                      : 'bg-muted text-foreground rounded-bl-sm',
                  )}>
                    {m.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border p-3">
              {!canChat ? (
                <div className="text-center af-body py-2">
                  Support chat is not available on your current plan.{' '}
                  <Link href="/billing" className="text-primary underline">Upgrade to Guided</Link>
                </div>
              ) : resolved ? (
                <div className="text-center af-body py-2">
                  This session is resolved.{' '}
                  <button onClick={() => { setMessages([{ role: 'assistant', content: "Hi! I'm Collab. What issue are you running into today?" }]); setSessionId(null); setResolved(false); setEscalated(false); }} className="text-primary underline">Start a new session</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
                    placeholder="Describe your issue…"
                    className="flex-1 rounded-md border border-border bg-background text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={send}
                    disabled={loading || !input.trim()}
                    className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Action row */}
          {canChat && !resolved && (
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {sessionId && (
                <button
                  onClick={handleResolve}
                  className="af-caption hover:text-foreground underline"
                >
                  Mark as resolved
                </button>
              )}
              {canEsc && !escalated && (
                <button
                  onClick={() => setShowEsc(true)}
                  className="af-caption hover:text-foreground underline ml-auto"
                >
                  Need human support?{' '}
                  <span className="text-primary">Email us →</span>
                </button>
              )}
              {escalated && (
                <span className="af-caption text-amber-500 ml-auto">↑ Escalated to team</span>
              )}
            </div>
          )}
        </div>

        {/* ── Guides + SMS panel ── */}
        <GuidesPanel />
      </div>

      {showEsc && (
        <EscalateModal
          sessionId={sessionId}
          userName={userName}
          userEmail={userEmail}
          plan={plan}
          onClose={() => setShowEsc(false)}
          onDone={() => { setShowEsc(false); setEscalated(true); }}
        />
      )}
    </PageShell>
  );
}
