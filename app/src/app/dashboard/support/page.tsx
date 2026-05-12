'use client';
/**
 * /dashboard/support — AuraFlux Support (CPD-115)
 *
 * Tier-gated support experience:
 *   Operate (≤30 days): AI chat + Confluence guides, no escalation
 *   Operate (>30 days): Confluence guides only, upgrade prompt
 *   Guided / Managed:   AI chat + guides + SMS escalation + email last resort
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  supportChat,
  getSupportSessions,
  resolveSupportSession,
  escalateSupportSession,
  type SupportSession,
  type SupportMessage,
  getSupportSessionMessages,
} from '@/lib/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORT_SMS   = process.env.NEXT_PUBLIC_SUPPORT_SMS_NUMBER || '+1 571 500 1787';
const GUIDE_URL     = 'https://robertsworkspace-18914505.atlassian.net/wiki/spaces/AF/pages/6684693/Customer+Guide+Using+AuraFlux';

const GUIDE_LINKS = [
  { label: 'Getting started with AuraFlux',         url: GUIDE_URL },
  { label: 'Submitting your first job',             url: GUIDE_URL + '#submitting' },
  { label: 'Understanding job statuses',            url: GUIDE_URL + '#statuses' },
  { label: 'Publishing to YouTube / TikTok',        url: GUIDE_URL + '#publish' },
  { label: 'Credits, billing & plans',              url: '/dashboard/billing' },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMsg { role: 'user' | 'assistant'; content: string }

// ─── Tier helpers ─────────────────────────────────────────────────────────────

function getPlanTier(user: ReturnType<typeof useUser>['user']): string {
  return (user?.publicMetadata?.planTier as string) || 'diy';
}

function getAccountAgeDays(user: ReturnType<typeof useUser>['user']): number {
  if (!user?.createdAt) return 0; // no date = new account, give benefit of the doubt
  return Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function GuidesPanel() {
  return (
    <aside className="w-full lg:w-72 shrink-0 space-y-4">
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Guides</h2>
        <ul className="space-y-1.5">
          {GUIDE_LINKS.map((g) => (
            <li key={g.label}>
              <a
                href={g.url}
                target={g.url.startsWith('http') ? '_blank' : undefined}
                rel="noopener noreferrer"
                className="flex items-start gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors group"
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
        <h2 className="text-sm font-semibold">SMS Support</h2>
        <p className="text-xs text-muted-foreground">Text us directly — your conversation will appear in your support history here.</p>
        <a
          href={`sms:${SUPPORT_SMS.replace(/\s/g, '')}`}
          className="flex items-center gap-2 mt-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium w-full justify-center hover:bg-primary/90 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          Text {SUPPORT_SMS}
        </a>
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
        <h3 className="text-base font-semibold">Email the AuraFlux team</h3>
        <p className="text-sm text-muted-foreground">
          This is the last resort. We recommend texting <strong>{SUPPORT_SMS}</strong> for a faster response.
        </p>
        <textarea
          className="w-full rounded-md border border-border bg-background text-sm p-3 resize-none h-28 focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="Describe your issue in detail..."
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-border text-sm hover:bg-accent/50">Cancel</button>
          <button
            onClick={send}
            disabled={sending || !summary.trim()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send to robert@auraflux.co'}
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
  if (!sessions.length) return null;
  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold mb-2">Past sessions</h2>
      <div className="space-y-1">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s)}
            className={cn(
              'w-full text-left px-3 py-2 rounded-md text-xs transition-colors flex items-center justify-between gap-2',
              s.id === activeId ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-muted-foreground',
            )}
          >
            <span>{new Date(s.created_at).toLocaleDateString()} — {s.message_count} message{s.message_count !== 1 ? 's' : ''}</span>
            <span className="flex items-center gap-1">
              {s.escalated && <span className="text-amber-500">↑ escalated</span>}
              {s.resolved  && <span className="text-emerald-500">✓ resolved</span>}
              {s.phone_number && <span title="SMS thread">📱</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SupportPage() {
  const { getToken, isLoaded } = useAuth();
  const { user }               = useUser();

  const plan    = getPlanTier(user);
  const ageDays = getAccountAgeDays(user);
  const canChat = plan === 'dwy' || plan === 'dfy' || (plan === 'diy' && ageDays <= 30);
  const canEsc  = plan === 'dwy' || plan === 'dfy';

  const [messages,   setMessages]   = useState<ChatMsg[]>([
    { role: 'assistant', content: "Hi! I'm AuraFlux Support. What issue are you running into today?" },
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
        content: 'Sorry, I had trouble responding. Please try again or text us at ' + SUPPORT_SMS,
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

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Support</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {plan === 'diy' && ageDays <= 30
            ? `AI support is available during your first month (${30 - ageDays} days remaining). Upgrade to Guided for ongoing support.`
            : plan === 'diy'
            ? 'Your trial support period has ended. Use the guides below or upgrade to Guided for ongoing AI support and SMS escalation.'
            : 'AI support + SMS escalation included with your plan.'}
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* ── Chat panel ── */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="rounded-lg border border-border flex flex-col" style={{ height: 520 }}>
            {/* Messages */}
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
                  <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-muted-foreground">
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border p-3">
              {!canChat ? (
                <div className="text-center text-sm text-muted-foreground py-2">
                  AI support chat is not available on your current plan.{' '}
                  <Link href="/dashboard/billing" className="text-primary underline">Upgrade to Guided</Link>
                </div>
              ) : resolved ? (
                <div className="text-center text-sm text-muted-foreground py-2">
                  This session is resolved.{' '}
                  <button onClick={() => { setMessages([{ role: 'assistant', content: "Hi! I'm AuraFlux Support. What issue are you running into today?" }]); setSessionId(null); setResolved(false); setEscalated(false); }} className="text-primary underline">Start a new session</button>
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
              <button
                onClick={handleResolve}
                className="text-xs text-muted-foreground hover:text-foreground underline"
              >
                Mark as resolved
              </button>
              {canEsc && !escalated && (
                <button
                  onClick={() => setShowEsc(true)}
                  className="text-xs text-muted-foreground hover:text-destructive underline ml-auto"
                >
                  Escalate via email (last resort)
                </button>
              )}
              {escalated && (
                <span className="text-xs text-amber-500 ml-auto">↑ Escalated to team</span>
              )}
            </div>
          )}

          <SessionHistory sessions={sessions} onSelect={handleSessionSelect} activeId={sessionId} />
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
    </div>
  );
}
