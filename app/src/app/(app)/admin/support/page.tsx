'use client';
/**
 * /admin/support — Operator Support Inbox (CPD-310)
 *
 * Visible to operator and admin roles only. Shows all support sessions
 * across all customers. Operators can read the full thread and reply.
 * Replies route to SMS (if session came via SMS) or web.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth, useUser } from '@/lib/clerk-compat';
import { useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  listAllSupportSessions,
  getOperatorSessionMessages,
  sendOperatorReply,
  resolveSupportSession,
  type SupportSession,
  type SupportMessage,
} from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relTime(ts: number | null): string {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function channelBadge(session: SupportSession) {
  if (session.phone_number) return { label: 'SMS', color: 'bg-blue-500/15 text-blue-400' };
  if (session.escalated)    return { label: 'Escalated', color: 'bg-amber-500/15 text-amber-400' };
  return { label: 'Web', color: 'bg-muted text-muted-foreground' };
}

// ─── Session list item ────────────────────────────────────────────────────────

function SessionItem({
  session, active, onClick,
}: {
  session: SupportSession; active: boolean; onClick: () => void;
}) {
  const badge = channelBadge(session);
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-3 rounded-lg border transition-colors flex flex-col gap-1',
        active
          ? 'border-primary/50 bg-primary/5'
          : 'border-border hover:border-border/80 hover:bg-accent/30',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground truncate">{session.user_name ?? session.user_id.slice(0, 12) + '…'}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', badge.color)}>{badge.label}</span>
          {session.human_took_over && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">Taken over</span>
          )}
          {session.resolved && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Resolved</span>
          )}
        </div>
      </div>
      {session.last_message_preview && (
        <p className="text-xs text-muted-foreground line-clamp-1">{session.last_message_preview}</p>
      )}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
        <span>{session.message_count} msg{session.message_count !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span>{relTime(session.last_message_at || session.created_at)}</span>
      </div>
    </button>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: SupportMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
        isUser
          ? 'bg-primary text-primary-foreground rounded-br-sm'
          : 'bg-muted text-foreground rounded-bl-sm',
      )}>
        <p>{msg.content}</p>
        <p className={cn(
          'text-[10px] mt-1',
          isUser ? 'text-primary-foreground/60' : 'text-muted-foreground',
        )}>
          {msg.channel === 'sms' ? '📱 SMS · ' : ''}{relTime(msg.created_at)}
        </p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function OperatorSupportInbox() {
  const { getToken } = useAuth();
  const { user }     = useUser();
  const role         = (user?.publicMetadata?.role as string | undefined) ?? null;
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Gate: superadmin/operator/admin only
  useEffect(() => {
    if (role && role !== 'superadmin' && role !== 'operator' && role !== 'admin') {
      router.replace('/home');
    }
  }, [role, router]);

  const [sessions,        setSessions]        = useState<SupportSession[]>([]);
  const [activeSession,   setActiveSession]   = useState<SupportSession | null>(null);
  const [messages,        setMessages]        = useState<SupportMessage[]>([]);
  const [reply,           setReply]           = useState('');
  const [sending,         setSending]         = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [showOpenOnly,    setShowOpenOnly]    = useState(true);
  const [error,           setError]           = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load session list
  const loadSessions = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await listAllSupportSessions({ open: showOpenOnly }, token ?? undefined);
      if (r.ok) setSessions(r.sessions);
    } catch { /* non-fatal */ }
  }, [getToken, showOpenOnly]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Auto-select session from URL query param
  useEffect(() => {
    const sessionId = searchParams.get('session');
    if (sessionId && sessions.length) {
      const s = sessions.find((x) => x.id === sessionId);
      if (s) handleSelectSession(s);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, searchParams]);

  // Poll active session for new messages every 15s
  useEffect(() => {
    if (!activeSession) return;
    const id = setInterval(() => loadSessionMessages(activeSession.id), 15_000);
    return () => clearInterval(id);
  }, [activeSession]); // eslint-disable-line

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function loadSessionMessages(sessionId: string) {
    setLoading(true);
    try {
      const token = await getToken();
      const r = await getOperatorSessionMessages(sessionId, token ?? undefined);
      if (r.ok) {
        setMessages(r.messages);
        setActiveSession(r.session);
      }
    } catch { /* non-fatal */ } finally {
      setLoading(false);
    }
  }

  async function handleSelectSession(session: SupportSession) {
    setActiveSession(session);
    setMessages([]);
    setReply('');
    setError(null);
    await loadSessionMessages(session.id);
  }

  async function handleSendReply() {
    if (!reply.trim() || !activeSession || sending) return;
    setSending(true);
    setError(null);
    try {
      const token = await getToken();
      const r = await sendOperatorReply(activeSession.id, reply.trim(), token ?? undefined);
      if (r.ok) {
        setReply('');
        await loadSessionMessages(activeSession.id);
        await loadSessions();
      } else {
        setError('Failed to send reply. Try again.');
      }
    } catch {
      setError('Failed to send reply. Try again.');
    } finally {
      setSending(false);
    }
  }

  async function handleResolve() {
    if (!activeSession) return;
    try {
      const token = await getToken();
      await resolveSupportSession(activeSession.id, token ?? undefined);
      await loadSessions();
      setActiveSession((s) => s ? { ...s, resolved: true } : s);
    } catch { /* non-fatal */ }
  }

  const openCount   = sessions.filter((s) => !s.resolved).length;
  const humanCount  = sessions.filter((s) => s.human_took_over).length;
  const smsCount    = sessions.filter((s) => !!s.phone_number).length;

  if (role && role !== 'superadmin' && role !== 'operator' && role !== 'admin') return null;

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Support Inbox</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {openCount} open · {smsCount} via SMS · {humanCount} taken over
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showOpenOnly}
            onChange={(e) => setShowOpenOnly(e.target.checked)}
            className="rounded"
          />
          Open only
        </label>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-4 min-h-0" style={{ height: 'calc(100vh - 160px)' }}>
        {/* ── Session list ── */}
        <aside className="w-72 shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">
          {sessions.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No sessions found.</p>
          )}
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={activeSession?.id === s.id}
              onClick={() => handleSelectSession(s)}
            />
          ))}
        </aside>

        {/* ── Thread + reply ── */}
        <div className="flex-1 flex flex-col min-h-0 border border-border rounded-lg overflow-hidden">
          {!activeSession ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a session to view the conversation.
            </div>
          ) : (
            <>
              {/* Session meta bar */}
              <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-3 bg-muted/20 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-xs text-muted-foreground">{activeSession.user_name ?? activeSession.user_id}</span>
                  {activeSession.phone_number && (
                    <span className="text-xs text-muted-foreground">📱 {activeSession.phone_number}</span>
                  )}
                  {activeSession.human_took_over && (
                    <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">Human active</span>
                  )}
                  {activeSession.resolved && (
                    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">Resolved</span>
                  )}
                </div>
                {!activeSession.resolved && (
                  <button
                    onClick={handleResolve}
                    className="text-xs text-muted-foreground hover:text-foreground underline"
                  >
                    Mark resolved
                  </button>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {loading && messages.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
                )}
                {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
                <div ref={bottomRef} />
              </div>

              {/* Reply box */}
              <div className="border-t border-border p-3 flex flex-col gap-2">
                {activeSession.resolved ? (
                  <p className="text-xs text-muted-foreground text-center py-1">Session resolved — reopen to reply.</p>
                ) : (
                  <>
                    {activeSession.phone_number && (
                      <p className="text-xs text-muted-foreground">
                        Reply will be sent as SMS to {activeSession.phone_number}
                      </p>
                    )}
                    {error && <p className="text-xs text-destructive">{error}</p>}
                    <div className="flex gap-2">
                      <textarea
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendReply(); }
                        }}
                        placeholder={activeSession.phone_number ? 'Type SMS reply…' : 'Type reply…'}
                        rows={2}
                        className="flex-1 rounded-md border border-border bg-background text-sm px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        onClick={handleSendReply}
                        disabled={sending || !reply.trim()}
                        className="px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 self-end py-2"
                      >
                        {sending ? 'Sending…' : activeSession.phone_number ? 'Send SMS' : 'Send'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
