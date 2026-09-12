'use client';
/**
 * /support — AuraFlux Support (CPD-115 / CPD-57)
 *
 * Tier-gated support:
 *   Creator (growth, ≤30 days): Assist chat trial + guides
 *   Creator (>30 days): Guides + upgrade to Studio
 *   Studio (operate + legacy guided) / Managed: Assist chat + guides + escalation
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth, useUser } from '@/lib/clerk-compat';
import Link from 'next/link';
import { usePlan } from '@/contexts/plan-context';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import {
  supportChat,
  getSupportSessions,
  resolveSupportSession,
  escalateSupportSession,
  type SupportSession,
  getSupportSessionMessages,
} from '@/lib/api';

function fmtSessionDate(raw: number | string | null | undefined): string {
  if (!raw) return 'Unknown date';
  const ms = typeof raw === 'number' ? raw : Number(raw);
  const d = !isNaN(ms) && ms > 1_000_000_000 ? new Date(ms) : new Date(raw as string);
  if (isNaN(d.getTime())) return 'Unknown date';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const GUIDE_URL =
  'https://aurafluxco.atlassian.net/wiki/spaces/AF/pages/6684693/Customer+Guide+Using+AuraFlux';

const GUIDE_LINKS = [
  { label: 'Getting started with AuraFlux', url: GUIDE_URL },
  { label: 'Submitting your first job', url: GUIDE_URL + '#submitting' },
  { label: 'Understanding job statuses', url: GUIDE_URL + '#statuses' },
  { label: 'Publishing to YouTube / TikTok', url: GUIDE_URL + '#publish' },
  { label: 'Credits, billing & plans', url: '/billing' },
];

interface ChatMsg { role: 'user' | 'assistant'; content: string }

function getAccountAgeDays(user: ReturnType<typeof useUser>['user']): number {
  if (!user?.createdAt) return 0;
  return Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000);
}

function GuidesPanel() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 id="guides" className="text-sm font-semibold text-white mb-3 scroll-mt-24">
          Documentation &amp; Guides
        </h2>
        <ul className="space-y-2">
          {GUIDE_LINKS.map((g) => (
            <li key={g.label}>
              <a
                href={g.url}
                target={g.url.startsWith('http') ? '_blank' : undefined}
                rel="noopener noreferrer"
                className="flex items-start gap-2 text-sm text-slate-300 hover:text-white transition-colors group"
              >
                <svg className="shrink-0 mt-0.5 text-amber-400/70 group-hover:text-amber-400" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                {g.label}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-2">
        <h2 className="text-sm font-semibold text-white">Need more help?</h2>
        <p className="text-sm text-slate-400">
          Need direct assistance? Submit a ticket above or upgrade to Studio for ongoing Assist chat. You can also add Managed to Creator or Studio.
        </p>
      </div>
    </div>
  );
}

function EscalateModal({
  sessionId, userName, userEmail, onClose, onDone,
}: {
  sessionId: string | null; userName: string; userEmail: string;
  onClose: () => void; onDone: () => void;
}) {
  const { getToken } = useAuth();
  const [summary, setSummary] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!summary.trim()) return;
    setSending(true);
    try {
      const token = await getToken();
      await escalateSupportSession({ sessionId, summary, userName, userEmail }, token ?? undefined);
      onDone();
    } catch {
      setError('Could not send escalation. Please email support@auraflux.co instead.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-6 space-y-4 mx-4">
        <h3 className="af-subhead">Email the AuraFlux team</h3>
        <p className="af-body text-muted-foreground">
          This sends your issue to the AuraFlux team. You can also submit a ticket from Self-serve help.
        </p>
        <textarea
          className="w-full rounded-md border border-border bg-background text-sm p-3 resize-none h-28 focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Describe your issue in detail..."
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {error && <p className="af-caption text-destructive">{formatUserError(error)}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={send} disabled={sending || !summary.trim()}>
            {sending ? 'Sending…' : 'Send to AuraFlux team'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SessionHistory({
  sessions, onOpen, activeId,
}: {
  sessions: SupportSession[];
  onOpen: (s: SupportSession) => void;
  activeId: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!sessions.length) return null;
  const displayed = showAll ? sessions : sessions.slice(0, 5);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h2 className="text-sm font-semibold text-white mb-3">Past sessions</h2>
      <div className="space-y-2">
        {displayed.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onOpen(s)}
            className={cn(
              'w-full text-left rounded-lg border transition-all p-4',
              s.id === activeId
                ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-slate-800 hover:border-amber-500/40 hover:bg-slate-900',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5 min-w-0">
                <p className="text-sm font-medium text-white">{fmtSessionDate(s.created_at)}</p>
                <p className="text-xs text-slate-400 whitespace-nowrap">
                  {s.message_count} {Number(s.message_count) === 1 ? 'message' : 'messages'}
                  {s.resolved ? ' · Resolved' : ' · Open'}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {s.escalated && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium whitespace-nowrap">Escalated</span>
                )}
                {s.resolved ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium whitespace-nowrap">Resolved</span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium whitespace-nowrap">Open</span>
                )}
              </div>
            </div>
            <p className="text-xs text-amber-400 mt-2">
              {s.resolved ? 'View thread →' : 'Continue or reopen →'}
            </p>
          </button>
        ))}
      </div>
      {sessions.length > 5 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs text-amber-400 underline underline-offset-2 mt-3 hover:no-underline"
        >
          {showAll ? 'Show fewer' : `Show all ${sessions.length} sessions`}
        </button>
      )}
    </div>
  );
}

function ThreadDrawer({
  open,
  onClose,
  session,
  messages,
  loading,
  reply,
  setReply,
  onSend,
  canReply,
  sending,
}: {
  open: boolean;
  onClose: () => void;
  session: SupportSession | null;
  messages: ChatMsg[];
  loading: boolean;
  reply: string;
  setReply: (v: string) => void;
  onSend: () => void;
  canReply: boolean;
  sending: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title={session ? fmtSessionDate(session.created_at) : 'Support thread'}
      description={
        session
          ? `${session.resolved ? 'Resolved' : 'Open'} · ${session.message_count} messages`
          : undefined
      }
      className="max-w-lg"
      footer={
        canReply ? (
          <div className="flex gap-2">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && onSend()}
              placeholder="Reply in this thread…"
              className="flex-1 rounded-md border border-slate-700 bg-slate-900 text-sm text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
            />
            <Button size="sm" className="h-9" disabled={sending || !reply.trim()} onClick={onSend}>
              {sending ? '…' : 'Send'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-slate-400 text-center">
            This session is resolved. Start a new chat from Support to continue.
          </p>
        )
      }
    >
      {loading ? (
        <p className="text-sm text-slate-400">Loading thread…</p>
      ) : (
        <div className="space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-slate-800 text-slate-100 rounded-bl-sm',
                )}
              >
                {m.content}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </Sheet>
  );
}

export default function SupportPage() {
  const { getToken, isLoaded } = useAuth();
  const { user } = useUser();
  const { planTier } = usePlan();

  const plan = planTier || 'operate';
  const ageDays = getAccountAgeDays(user);
  // Studio (operate + legacy guided) and Managed get chat; Creator (growth) does not — Studio first-month trial kept for operate.
  const canChat = plan === 'guided' || plan === 'managed' || plan === 'operate' || (plan === 'growth' && ageDays <= 30);
  const canEsc = plan === 'guided' || plan === 'managed' || plan === 'operate';

  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: "Hi! I'm Assist. What issue are you running into today?" },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SupportSession[]>([]);
  const [showEsc, setShowEsc] = useState(false);
  const [escalated, setEscalated] = useState(false);
  const [resolved, setResolved] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Thread drawer (past sessions — no full-page navigation)
  const [drawerSession, setDrawerSession] = useState<SupportSession | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMessages, setDrawerMessages] = useState<ChatMsg[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerReply, setDrawerReply] = useState('');
  const [drawerSending, setDrawerSending] = useState(false);

  const userName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Customer';
  const userEmail =
    user?.primaryEmailAddress?.emailAddress
    ?? user?.emailAddresses?.[0]?.emailAddress
    ?? '';

  const loadSessions = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await getSupportSessions(token ?? undefined);
      if (r.ok) setSessions(r.sessions);
    } catch { /* non-fatal */ }
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    void loadSessions();
  }, [loadSessions, isLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function openSessionDrawer(s: SupportSession) {
    setDrawerSession(s);
    setDrawerOpen(true);
    setDrawerLoading(true);
    setDrawerReply('');
    try {
      const token = await getToken();
      const r = await getSupportSessionMessages(s.id, token ?? undefined);
      if (r.ok) {
        setDrawerMessages(r.messages.map((m) => ({ role: m.role, content: m.content })));
      }
    } catch { /* non-fatal */ }
    finally {
      setDrawerLoading(false);
    }
  }

  async function sendDrawerReply() {
    if (!drawerSession || !drawerReply.trim() || drawerSending || drawerSession.resolved) return;
    const userMsg: ChatMsg = { role: 'user', content: drawerReply.trim() };
    const next = [...drawerMessages, userMsg];
    setDrawerMessages(next);
    setDrawerReply('');
    setDrawerSending(true);
    try {
      const token = await getToken();
      const r = await supportChat(
        next.map((m) => ({ role: m.role, content: m.content })),
        drawerSession.id,
        token ?? undefined,
      );
      if (r.ok) {
        setDrawerMessages((prev) => [...prev, { role: 'assistant', content: r.response }]);
        void loadSessions();
      }
    } catch {
      setDrawerMessages((prev) => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble responding. Please try again or submit a ticket.',
      }]);
    } finally {
      setDrawerSending(false);
    }
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
        if (!sessionId) {
          setSessionId(r.sessionId);
          void loadSessions();
        }
      }
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble responding. Please try again or submit a ticket from Self-serve help.',
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
      void loadSessions();
    } catch { /* non-fatal */ }
  }

  const supportSubtitle = plan === 'growth' && ageDays <= 30
    ? `Support chat is available during your first month (${30 - ageDays} days remaining). Upgrade to Studio for ongoing Assist chat, or add Managed to either plan.`
    : plan === 'growth'
      ? 'Browse guides below, or upgrade to Studio for ongoing Assist chat. Managed can be added to Creator or Studio.'
      : 'Chat with Assist or browse the guides.';

  const selfServe = (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-5">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-white">Self-serve help</h2>
        <p className="text-sm text-slate-400">
          Live Assist chat is not on your current plan. Browse documentation, submit a ticket, or upgrade to Studio for chat. Managed is an add-on for Creator or Studio.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/billing#plans"
          className={cn(buttonVariants({ variant: 'default' }), 'h-10 font-medium')}
        >
          Upgrade to Studio
        </Link>
        <a
          href="#guides"
          className={cn(buttonVariants({ variant: 'outline' }), 'h-10 font-medium border-slate-700')}
        >
          Browse Documentation
        </a>
        <a
          href="mailto:support@auraflux.co?subject=AuraFlux%20support%20request"
          className={cn(buttonVariants({ variant: 'outline' }), 'h-10 font-medium border-slate-700')}
        >
          Submit Ticket
        </a>
      </div>
    </div>
  );

  return (
    <PageShell maxWidth="6xl" className="mx-auto">
      <PageHeader title="Support" subtitle={supportSubtitle} />

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left — sessions + chat / self-serve */}
        <div className="lg:col-span-2 space-y-5">
          {sessions.length > 0 && (
            <SessionHistory
              sessions={sessions}
              onOpen={openSessionDrawer}
              activeId={drawerSession?.id ?? null}
            />
          )}

          {!canChat ? selfServe : (
            <div className="rounded-xl border border-slate-800 bg-slate-900 flex flex-col min-h-[300px] h-[50vh] max-h-[480px]">
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((m, i) => (
                  <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn(
                      'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-br-sm'
                        : 'bg-slate-800 text-slate-100 rounded-bl-sm',
                    )}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <div className="border-t border-slate-800 p-3">
                {resolved ? (
                  <div className="text-center text-sm text-slate-400 py-2">
                    This session is resolved.{' '}
                    <button
                      type="button"
                      onClick={() => {
                        setMessages([{ role: 'assistant', content: "Hi! I'm Assist. What issue are you running into today?" }]);
                        setSessionId(null);
                        setResolved(false);
                        setEscalated(false);
                      }}
                      className="text-amber-400 underline"
                    >
                      Start a new session
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
                      placeholder="Describe your issue…"
                      className="flex-1 rounded-md border border-slate-700 bg-slate-950 text-sm text-white px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                    />
                    <Button onClick={send} disabled={loading || !input.trim()} className="h-10">
                      Send
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {canChat && !resolved && (
            <div className="flex items-center gap-3 flex-wrap">
              {sessionId && (
                <button type="button" onClick={handleResolve} className="text-xs text-slate-400 hover:text-white underline">
                  Mark as resolved
                </button>
              )}
              {canEsc && !escalated && (
                <button
                  type="button"
                  onClick={() => setShowEsc(true)}
                  className="text-xs text-slate-400 hover:text-white underline ml-auto"
                >
                  Need human support? <span className="text-amber-400">Email us →</span>
                </button>
              )}
              {escalated && (
                <span className="text-xs text-amber-400 ml-auto">↑ Escalated to team</span>
              )}
            </div>
          )}

          {/* Self-serve actions also available when chat is on */}
          {canChat && (
            <div className="flex flex-wrap gap-2">
              <a href="#guides" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-slate-700')}>
                Browse Documentation
              </a>
              <a
                href="mailto:support@auraflux.co?subject=AuraFlux%20support%20request"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-slate-700')}
              >
                Submit Ticket
              </a>
              <Link href="/billing#plans" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'border-slate-700')}>
                View plans
              </Link>
            </div>
          )}
        </div>

        {/* Right — guides + need more help */}
        <div className="lg:col-span-1">
          <GuidesPanel />
        </div>
      </div>

      <ThreadDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        session={drawerSession}
        messages={drawerMessages}
        loading={drawerLoading}
        reply={drawerReply}
        setReply={setDrawerReply}
        onSend={sendDrawerReply}
        canReply={!!drawerSession && !drawerSession.resolved && canChat}
        sending={drawerSending}
      />

      {showEsc && (
        <EscalateModal
          sessionId={sessionId}
          userName={userName}
          userEmail={userEmail}
          onClose={() => setShowEsc(false)}
          onDone={() => { setShowEsc(false); setEscalated(true); }}
        />
      )}
    </PageShell>
  );
}
