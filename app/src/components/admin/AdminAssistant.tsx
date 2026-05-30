'use client';
/**
 * AdminAssistant — CPD-411
 *
 * Floating Gemini-powered chat panel for /admin pages.
 * Collapsed: pill button bottom-right with chat icon.
 * Expanded:  360×500px panel with message thread + input.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────────────────────

type MessageRole = 'user' | 'assistant';

interface TicketBadge {
  key: string;
}

interface Message {
  id:     string;
  role:   MessageRole;
  text:   string;
  ticket?: TicketBadge;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function msgId(): string {
  return Math.random().toString(36).slice(2);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TicketPill({ ticketKey }: { ticketKey: string }) {
  return (
    <a
      href={`https://aurafluxco.atlassian.net/browse/${ticketKey}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 mt-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300 border border-blue-700/50 hover:bg-blue-800/40 transition-colors"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
      {ticketKey} — Cursor is working on it
    </a>
  );
}

function ChatMessage({ msg }: { msg: Message }) {
  const isUser = msg.role === 'user';
  return (
    <div className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-slate-800 text-slate-100 border border-slate-700/50 rounded-bl-sm',
        )}
      >
        {msg.text}
      </div>
      {msg.ticket && <TicketPill ticketKey={msg.ticket.key} />}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start">
      <div className="bg-slate-800 border border-slate-700/50 rounded-xl rounded-bl-sm px-3 py-2">
        <span className="flex gap-1">
          {[0, 1, 2].map(i => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AdminAssistant() {
  const [open,     setOpen]     = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id:   msgId(),
      role: 'assistant',
      text: 'Hi — I can answer operational questions, explain system state, or create a Jira ticket for something that needs building. What do you need?',
    },
  ]);
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, messages.length]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setError(null);
    setMessages(prev => [...prev, { id: msgId(), role: 'user', text }]);
    setLoading(true);

    try {
      const res = await fetch('/api/admin/assistant', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();

      setMessages(prev => [
        ...prev,
        {
          id:     msgId(),
          role:   'assistant',
          text:   data.message,
          ticket: data.ticketId ? { key: data.ticketId } : undefined,
        },
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      setMessages(prev => [
        ...prev,
        { id: msgId(), role: 'assistant', text: `Something went wrong: ${msg}` },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {/* Expanded panel */}
      {open && (
        <div className="flex flex-col w-[360px] h-[500px] rounded-2xl border border-slate-700/60 bg-slate-900/95 backdrop-blur-sm shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50 bg-slate-800/60">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-sm font-semibold text-slate-100">Admin Assistant</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700/40 font-medium">
                Gemini
              </span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-slate-700/50"
              aria-label="Close assistant"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
              </svg>
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
            {messages.map(msg => (
              <ChatMessage key={msg.id} msg={msg} />
            ))}
            {loading && <TypingIndicator />}
            <div ref={bottomRef} />
          </div>

          {/* Error bar */}
          {error && (
            <div className="px-4 py-2 bg-red-950/60 border-t border-red-800/50 text-red-300 text-xs">
              {error}
            </div>
          )}

          {/* Input */}
          <div className="px-3 py-3 border-t border-slate-700/50 bg-slate-800/40 flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything or request a ticket…"
              disabled={loading}
              className={cn(
                'flex-1 bg-slate-700/50 border border-slate-600/50 rounded-xl px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500',
                'focus:outline-none focus:ring-1 focus:ring-blue-500/50 focus:border-blue-500/50 transition-colors',
                loading && 'opacity-50 cursor-not-allowed',
              )}
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              className={cn(
                'p-2 rounded-xl bg-blue-600 text-white transition-all hover:bg-blue-500 active:scale-95',
                (!input.trim() || loading) && 'opacity-40 cursor-not-allowed',
              )}
              aria-label="Send"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M14 8L2 2l2 6-2 6 12-6z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg transition-all duration-200',
          'border font-medium text-sm',
          open
            ? 'bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-600'
            : 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500 active:scale-95',
        )}
        aria-label="Toggle Admin Assistant"
      >
        {open ? (
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
            </svg>
            Close
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1C4.13 1 1 3.91 1 7.5c0 1.77.76 3.37 1.99 4.54L2 14l2.22-.87C5.27 13.67 6.6 14 8 14c3.87 0 7-2.91 7-6.5S11.87 1 8 1z" fill="currentColor"/>
            </svg>
            Assistant
          </>
        )}
      </button>
    </div>
  );
}
