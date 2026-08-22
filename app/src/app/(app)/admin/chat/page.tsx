'use client';
/**
 * /admin/chat — Public Chat Inbox (CPD-421)
 *
 * Superadmin view of all auraflux.co and in-app pre-sales chat sessions
 * powered by Gemini. Shows live (polling every 15s) and historical threads.
 * Read-only — Gemini handles replies; operator can mark sessions resolved.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth, useUser }    from '@/lib/clerk-compat';
import { useRouter }           from 'next/navigation';
import { cn }                  from '@/lib/utils';
import {
  listPublicChatSessions,
  getPublicChatSession,
  resolvePublicChatSession,
  type PublicChatSession,
  type PublicChatMessage,
} from '@/lib/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)        return 'just now';
  if (s < 3600)      return `${Math.floor(s / 60)}m ago`;
  if (s < 86400)     return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function originBadge(session: PublicChatSession) {
  if (session.origin === 'app') return { label: 'App', color: 'bg-purple-500/15 text-purple-400' };
  return { label: 'Site', color: 'bg-sky-500/15 text-sky-400' };
}

// ─── Session list item ────────────────────────────────────────────────────────

function SessionItem({
  session, active, onClick,
}: {
  session: PublicChatSession; active: boolean; onClick: () => void;
}) {
  const badge = originBadge(session);
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
        <span className="font-mono text-[11px] text-muted-foreground truncate">{session.id}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', badge.color)}>
            {badge.label}
          </span>
          {session.escalated && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
              Escalated
            </span>
          )}
          {session.resolved && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Resolved
            </span>
          )}
        </div>
      </div>
      {session.last_preview && (
        <p className="text-xs text-muted-foreground line-clamp-1">{session.last_preview}</p>
      )}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
        <span>{session.message_count} msg{session.message_count !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span>{relTime(session.last_message_at)}</span>
        {session.visitor_ip && (
          <>
            <span>·</span>
            <span className="font-mono">{session.visitor_ip}</span>
          </>
        )}
      </div>
    </button>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: PublicChatMessage }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn(
        'max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
        isUser
          ? 'bg-primary text-primary-foreground rounded-br-sm'
          : 'bg-muted text-foreground rounded-bl-sm',
      )}>
        <p className="whitespace-pre-wrap">{msg.content}</p>
        <p className={cn(
          'text-[10px] mt-1',
          isUser ? 'text-primary-foreground/60' : 'text-muted-foreground',
        )}>
          {isUser ? 'Visitor' : 'Collab Assistant'} · {relTime(msg.created_at)}
        </p>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PublicChatInbox() {
  const { getToken }  = useAuth();
  const { user }      = useUser();
  const role          = (user?.publicMetadata?.role as string | undefined) ?? null;
  const router        = useRouter();

  useEffect(() => {
    if (role && role !== 'superadmin') router.replace('/home');
  }, [role, router]);

  const [sessions,      setSessions]      = useState<PublicChatSession[]>([]);
  const [total,         setTotal]         = useState(0);
  const [activeSession, setActiveSession] = useState<PublicChatSession | null>(null);
  const [messages,      setMessages]      = useState<PublicChatMessage[]>([]);
  const [loading,       setLoading]       = useState(false);
  const [originFilter,  setOriginFilter]  = useState<'all' | 'marketing' | 'app'>('all');
  const [showResolved,  setShowResolved]  = useState(false);
  const [escalatedOnly, setEscalatedOnly] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const token = await getToken();
      const r = await listPublicChatSessions(
        {
          origin:    originFilter === 'all' ? undefined : originFilter,
          resolved:  showResolved  ? undefined : false,
          escalated: escalatedOnly ? true      : undefined,
          limit:     200,
        },
        token ?? undefined,
      );
      if (r.ok) { setSessions(r.sessions); setTotal(r.total); }
    } catch { /* non-fatal */ }
  }, [getToken, originFilter, showResolved, escalatedOnly]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  // Poll session list every 15s to catch new conversations
  useEffect(() => {
    const id = setInterval(loadSessions, 15_000);
    return () => clearInterval(id);
  }, [loadSessions]);

  // Poll active thread every 15s for new messages
  useEffect(() => {
    if (!activeSession) return;
    const id = setInterval(() => loadMessages(activeSession.id), 15_000);
    return () => clearInterval(id);
  }, [activeSession]); // eslint-disable-line

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function loadMessages(sessionId: string) {
    setLoading(true);
    try {
      const token = await getToken();
      const r = await getPublicChatSession(sessionId, token ?? undefined);
      if (r.ok) {
        setMessages(r.messages);
        setActiveSession(r.session);
      }
    } catch { /* non-fatal */ } finally { setLoading(false); }
  }

  async function handleSelect(session: PublicChatSession) {
    setActiveSession(session);
    setMessages([]);
    await loadMessages(session.id);
  }

  async function handleResolve() {
    if (!activeSession) return;
    try {
      const token = await getToken();
      await resolvePublicChatSession(activeSession.id, token ?? undefined);
      setActiveSession((s) => s ? { ...s, resolved: true } : s);
      await loadSessions();
    } catch { /* non-fatal */ }
  }

  const openCount = sessions.filter((s) => !s.resolved).length;
  const escCount  = sessions.filter((s) => s.escalated).length;

  if (role && role !== 'superadmin') return null;

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Chat Inbox</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {openCount} open · {escCount} escalated · {total} total
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap text-sm text-muted-foreground">
          {/* Origin toggle */}
          <div className="flex rounded-md overflow-hidden border border-border text-xs">
            {(['all', 'marketing', 'app'] as const).map((o) => (
              <button
                key={o}
                onClick={() => setOriginFilter(o)}
                className={cn(
                  'px-3 py-1.5 capitalize transition-colors',
                  originFilter === o
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'hover:bg-accent/40',
                )}
              >
                {o === 'all' ? 'All' : o === 'marketing' ? 'Site' : 'App'}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="rounded"
            />
            Show resolved
          </label>

          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={escalatedOnly}
              onChange={(e) => setEscalatedOnly(e.target.checked)}
              className="rounded"
            />
            Escalated only
          </label>
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-4 min-h-0" style={{ height: 'calc(100vh - 168px)' }}>
        {/* Session list */}
        <aside className="w-72 shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">
          {sessions.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No sessions found.</p>
          )}
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={activeSession?.id === s.id}
              onClick={() => handleSelect(s)}
            />
          ))}
        </aside>

        {/* Thread */}
        <div className="flex-1 flex flex-col min-h-0 border border-border rounded-lg overflow-hidden">
          {!activeSession ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a session to read the conversation.
            </div>
          ) : (
            <>
              {/* Meta bar */}
              <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-3 bg-muted/20 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                  <span className={cn(
                    'px-2 py-0.5 rounded font-medium text-[10px]',
                    originBadge(activeSession).color,
                  )}>
                    {originBadge(activeSession).label}
                  </span>
                  <span className="font-mono">{activeSession.id}</span>
                  {activeSession.visitor_ip && <span>IP: {activeSession.visitor_ip}</span>}
                  <span>Started: {relTime(activeSession.started_at)}</span>
                  {activeSession.escalated && (
                    <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium text-[10px]">
                      Escalated
                    </span>
                  )}
                  {activeSession.resolved && (
                    <span className="px-2 py-0.5 rounded bg-muted text-muted-foreground text-[10px]">
                      Resolved
                    </span>
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

              {/* Read-only footer */}
              <div className="border-t border-border px-4 py-3 bg-muted/10">
                <p className="text-xs text-muted-foreground text-center">
                  Read-only — Collab Assistant handles replies. Polling for new messages every 15s.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
