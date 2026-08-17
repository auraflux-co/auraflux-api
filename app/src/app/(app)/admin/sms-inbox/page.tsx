'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, Copy, MessageSquare, Send } from 'lucide-react';

interface SmsMessage {
  id: string;
  brand_id: string;
  brand_name: string;
  telnyx_number: string;
  from_number: string;
  body: string;
  received_at: string;
  read_at: string | null;
}

const API = process.env.NEXT_PUBLIC_API_BASE || 'https://auraflux-api.onrender.com';
const POLL_MS = 8000;

function extractCode(body: string): string | null {
  const m = body.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export default function SmsInboxPage() {
  const { getToken } = useAuth();
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const [newCount, setNewCount] = useState(0);

  const [line, setLine] = useState<'437' | '571'>('571');
  const [toNumber, setToNumber] = useState('');
  const [smsBody, setSmsBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendOk, setSendOk] = useState('');

  const fetchMessages = useCallback(async (silent = false) => {
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/sms-inbox?t=${Date.now()}`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Inbox fetch failed (${res.status})`);
      }
      if (Array.isArray(data.messages)) {
        const incoming: SmsMessage[] = data.messages;
        if (seenIds.current.size > 0) {
          const fresh = incoming.filter(m => !seenIds.current.has(m.id));
          if (fresh.length > 0) setNewCount(n => n + fresh.length);
        }
        incoming.forEach(m => seenIds.current.add(m.id));
        setMessages(incoming);
        setLastRefresh(new Date());
      }
    } catch {
      // keep existing list; Last timestamp only updates on success
    } finally {
      if (!silent) setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    if (liveMode) {
      timerRef.current = setInterval(() => fetchMessages(true), POLL_MS);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [liveMode, fetchMessages]);

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  async function sendSms() {
    setSendError('');
    setSendOk('');
    setSending(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/sms-send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ line, to: toNumber, body: smsBody }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Send failed (${res.status})`);
      }
      setSendOk(`Sent from ${data.line} → ${data.to}`);
      setSmsBody('');
      fetchMessages(true);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  const unread = messages.filter(m => !m.read_at).length;
  const canSend = toNumber.trim().length >= 8 && smsBody.trim().length > 0 && !sending;

  if (loading) {
    return (
      <PageShell maxWidth="3xl">
        <PageHeader title="SMS Inbox" subtitle="Loading..." />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="SMS Inbox"
        subtitle={`All brand numbers · ${messages.length} messages${unread > 0 ? ` · ${unread} unread` : ''}`}
      />

      <section className="rounded-md border border-border bg-card p-4 mb-6 space-y-3">
        <h2 className="text-sm font-semibold">Send SMS</h2>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">From line</label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={line === '437' ? 'default' : 'outline'}
              onClick={() => setLine('437')}
            >
              CA 437
            </Button>
            <Button
              type="button"
              size="sm"
              variant={line === '571' ? 'default' : 'outline'}
              onClick={() => setLine('571')}
            >
              US 571
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="sms-to">To</label>
          <input
            id="sms-to"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            placeholder="+1 555 123 4567"
            value={toNumber}
            onChange={(e) => setToNumber(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="sms-body">Message</label>
          <textarea
            id="sms-body"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[88px]"
            placeholder="Type your message…"
            maxLength={1600}
            value={smsBody}
            onChange={(e) => setSmsBody(e.target.value)}
          />
          <div className="text-xs text-muted-foreground text-right">{smsBody.length}/1600</div>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!canSend} onClick={sendSms}>
            <Send className="h-3.5 w-3.5 mr-1" />
            {sending ? 'Sending…' : 'Send'}
          </Button>
          {sendOk && <span className="text-xs text-green-400">{sendOk}</span>}
          {sendError && <span className="text-xs text-destructive">{sendError}</span>}
        </div>
      </section>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setLiveMode(l => !l); setNewCount(0); }}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors ${
              liveMode
                ? 'bg-green-500/15 border-green-500/40 text-green-400'
                : 'bg-muted border-border text-muted-foreground'
            }`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${liveMode ? 'bg-green-400 animate-pulse' : 'bg-muted-foreground'}`} />
            {liveMode ? `Live — refreshes every ${POLL_MS / 1000}s` : 'Paused'}
          </button>
          {newCount > 0 && (
            <Badge variant="destructive" className="text-xs">{newCount} new</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {lastRefresh && `Last: ${timeAgo(lastRefresh.toISOString())}`}
          <Button variant="ghost" size="sm" onClick={() => { fetchMessages(); setNewCount(0); }}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-10 text-center text-muted-foreground text-sm">
          <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-30" />
          No messages yet. Codes will appear here within {POLL_MS / 1000} seconds of arrival.
        </div>
      ) : (
        <div className="space-y-2">
          {messages.map((msg) => {
            const code = extractCode(msg.body);
            const isNew = !msg.read_at;
            const isRecent = (Date.now() - new Date(msg.received_at).getTime()) < 5 * 60 * 1000;

            return (
              <div
                key={msg.id}
                className={`rounded-md border px-4 py-3 flex items-start gap-4 transition-colors ${
                  isRecent && code
                    ? 'border-green-500/50 bg-green-500/5'
                    : isNew
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border bg-card'
                }`}
              >
                <div className="shrink-0 min-w-[160px]">
                  <div className="font-medium text-sm">{msg.brand_name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{msg.telnyx_number}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">from {msg.from_number}</div>
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-sm break-words">{msg.body}</div>
                </div>

                <div className="shrink-0 text-right">
                  {code && (
                    <div className="flex items-center justify-end gap-1.5 mb-1">
                      <span className={`font-mono font-bold text-lg tracking-widest ${isRecent ? 'text-green-400' : 'text-foreground'}`}>
                        {code}
                      </span>
                      <button onClick={() => copy(code)} className="text-muted-foreground hover:text-foreground" title="Copy code">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      {copied === code && <span className="text-xs text-green-400">Copied!</span>}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">{timeAgo(msg.received_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
