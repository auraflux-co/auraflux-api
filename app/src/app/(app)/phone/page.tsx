'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRole } from '@/hooks/use-role';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Phone, PhoneOff, PhoneIncoming, Mic, MicOff } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_BASE || 'https://auraflux-api.onrender.com';
const HEARTBEAT_MS = 15_000;
const PREFER_ONLINE_KEY = 'auraflux.phone.preferOnline';

function readPreferOnline(): boolean {
  try {
    const v = localStorage.getItem(PREFER_ONLINE_KEY);
    // Default true — landing on /phone should go online unless user explicitly went offline
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

function writePreferOnline(online: boolean) {
  try {
    localStorage.setItem(PREFER_ONLINE_KEY, online ? '1' : '0');
  } catch {
    /* ignore */
  }
}

type Line = { key: string; label: string; number: string };
type CallLogRow = {
  id: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  aura_line: string | null;
  status: string;
  started_at: string;
};

type TelnyxCall = {
  id: string;
  state: string;
  direction?: string;
  remoteCallerNumber?: string;
  remoteCallerName?: string;
  cause?: string;
  causeCode?: number | string;
  sipCode?: number | string;
  sipReason?: string;
  answer: () => void;
  hangup: () => void;
  muteAudio: () => void;
  unmuteAudio: () => void;
};

function normalizeDialNumber(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) {
    const digits = raw.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8) return `+${digits}`;
  return raw;
}

function callEndReason(call: TelnyxCall): string {
  const parts = [
    call.cause,
    call.sipReason,
    call.sipCode != null ? `SIP ${call.sipCode}` : null,
    call.causeCode != null ? `code ${call.causeCode}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Call ended';
}

function formatUnknownError(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const nested = o.error;
    if (typeof nested === 'string') return nested;
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>;
      if (typeof n.message === 'string') return n.message;
      if (typeof n.error === 'string') return n.error;
    }
    if (typeof o.message === 'string') return o.message;
    if (typeof o.reason === 'string') return o.reason;
    if (typeof o.code === 'string' || typeof o.code === 'number') {
      const base = typeof o.message === 'string' ? o.message : 'Telnyx error';
      return `${base} (${o.code})`;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json.slice(0, 300);
    } catch { /* ignore */ }
  }
  return 'Connection error';
}

type TelnyxClient = {
  connect: () => void;
  disconnect: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  off: (event: string, cb: (...args: unknown[]) => void) => void;
  newCall: (opts: Record<string, unknown>) => TelnyxCall;
  calls: TelnyxCall[];
  remoteElement: string;
  localElement: string;
};

export default function PhonePage() {
  return (
    <Suspense fallback={null}>
      <PhonePageInner />
    </Suspense>
  );
}

function PhonePageInner() {
  const { getToken } = useAuth();
  const { isSuperAdmin, isLoaded } = useRole();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [lines, setLines] = useState<Line[]>([]);
  const [selectedLine, setSelectedLine] = useState('437');
  const [dialInput, setDialInput] = useState('');
  const [status, setStatus] = useState<'offline' | 'connecting' | 'ready' | 'error'>('offline');
  const [statusDetail, setStatusDetail] = useState('');
  const [activeCall, setActiveCall] = useState<TelnyxCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<TelnyxCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [callLog, setCallLog] = useState<CallLogRow[]>([]);
  const [callState, setCallState] = useState('');
  const [lastError, setLastError] = useState('');
  const clientRef = useRef<TelnyxClient | null>(null);
  const connectLockRef = useRef(false);
  const pendingDialRef = useRef<{ dial: string; line: string } | null>(null);
  const autoDialDone = useRef(false);

  useEffect(() => {
    if (isLoaded && !isSuperAdmin) router.replace('/home');
  }, [isLoaded, isSuperAdmin, router]);

  const authFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getToken();
    return fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  }, [getToken]);

  const loadLines = useCallback(async () => {
    const res = await authFetch('/api/phone/lines');
    const data = await res.json();
    if (data.ok) setLines(data.lines);
  }, [authFetch]);

  const loadCallLog = useCallback(async () => {
    const res = await authFetch('/api/phone/calls?limit=25');
    const data = await res.json();
    if (data.ok) setCallLog(data.calls);
  }, [authFetch]);

  const sendPresence = useCallback(async (online: boolean) => {
    await authFetch('/api/phone/presence', {
      method: 'POST',
      body: JSON.stringify({ status: online ? 'online' : 'offline' }),
    }).catch(() => {});
  }, [authFetch]);

  const placeCall = useCallback(async (destination: string, lineKey: string) => {
    const client = clientRef.current;
    const line = lines.find((l) => l.key === lineKey) || lines[0];
    if (!client || !line) return;
    const to = normalizeDialNumber(destination);
    if (!to) {
      setLastError('Enter a valid phone number');
      return;
    }
    setLastError('');
    setCallState('dialing');
    try {
      // Ensure mic before INVITE — getUserMedia failure often drops the call instantly
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const call = client.newCall({
        destinationNumber: to,
        callerNumber: line.number,
        audio: true,
        video: false,
      });
      setActiveCall(call);
      setIncomingCall(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Dial failed';
      setLastError(msg.includes('Permission') || msg.includes('NotAllowed')
        ? 'Microphone permission denied — allow mic for this site and try again'
        : msg);
      setCallState('');
      setActiveCall(null);
    }
  }, [lines]);

  const connectPhone = useCallback(async () => {
    if (connectLockRef.current || clientRef.current) return;
    connectLockRef.current = true;
    setStatus('connecting');
    setStatusDetail('Fetching token…');

    try {
      const tokenRes = await authFetch('/api/phone/token');
      const tokenData = await tokenRes.json();
      if (!tokenData.ok) throw new Error(tokenData.error || 'Token failed');

      const { TelnyxRTC } = await import('@telnyx/webrtc');
      const client = new TelnyxRTC({
        login_token: tokenData.token,
        ringtoneFile: undefined,
        ringbackFile: undefined,
      }) as unknown as TelnyxClient;

      client.remoteElement = 'telnyx-remote-audio';
      client.localElement = 'telnyx-local-audio';

      client.on('telnyx.ready', () => {
        writePreferOnline(true);
        setStatus('ready');
        setStatusDetail('Connected — you will receive inbound calls');
        sendPresence(true);
      });

      client.on('telnyx.error', (...args: unknown[]) => {
        const msg = formatUnknownError(args[0] ?? args);
        connectLockRef.current = false;
        // Soft error — stay able to reconnect; don't leave client half-dead
        try { client.disconnect(); } catch { /* ignore */ }
        clientRef.current = null;
        setStatus('error');
        setStatusDetail(msg);
      });

      client.on('telnyx.notification', (...args: unknown[]) => {
        const notification = args[0] as { type?: string; call?: TelnyxCall };
        const call = notification.call;
        if (!call) return;
        if (notification.type === 'callUpdate') {
          setCallState(call.state || '');
          const direction = String(call.direction || '').toLowerCase();
          const isInbound = direction === 'inbound' || direction === 'incoming';
          // Inbound invite from Call Control → SIP
          if (isInbound && (call.state === 'ringing' || call.state === 'new' || call.state === 'requesting')) {
            setIncomingCall(call);
            setLastError('');
          }
          if (call.state === 'active') {
            setActiveCall(call);
            setIncomingCall(null);
          } else if (!isInbound && (call.state === 'trying' || call.state === 'new' || call.state === 'ringing')) {
            setActiveCall(call);
          }
          if (call.state === 'hangup' || call.state === 'destroy') {
            const reason = callEndReason(call);
            if (reason && reason !== 'NORMAL_CLEARING' && reason !== 'normal' && reason !== 'Call ended') {
              setLastError(reason);
            } else if (call.cause && String(call.cause).toLowerCase() !== 'normal_clearing') {
              setLastError(String(call.cause));
            }
            setActiveCall(null);
            setIncomingCall(null);
            setMuted(false);
            setCallState('');
            loadCallLog();
          }
        }
      });

      clientRef.current = client;
      client.connect();
    } catch (err) {
      connectLockRef.current = false;
      setStatus('error');
      setStatusDetail(formatUnknownError(err));
    }
  }, [authFetch, loadCallLog, sendPresence]);

  const disconnectPhone = useCallback(() => {
    writePreferOnline(false);
    connectLockRef.current = false;
    const client = clientRef.current;
    if (client) {
      client.disconnect();
      clientRef.current = null;
    }
    sendPresence(false);
    setStatus('offline');
    setStatusDetail('Offline — click Go online to take calls');
    setActiveCall(null);
    setIncomingCall(null);
  }, [sendPresence]);

  const goOnline = useCallback(() => {
    writePreferOnline(true);
    return connectPhone();
  }, [connectPhone]);

  useEffect(() => {
    loadLines();
    loadCallLog();
  }, [loadLines, loadCallLog]);

  // Auto-reconnect on refresh / first visit when user prefers online
  useEffect(() => {
    if (!isLoaded || !isSuperAdmin) return;
    if (!readPreferOnline()) return;
    if (clientRef.current) return;
    if (status !== 'offline') return;
    void connectPhone();
  }, [isLoaded, isSuperAdmin, status, connectPhone]);

  useEffect(() => {
    const dial = searchParams.get('dial');
    const line = searchParams.get('line') || '437';
    if (dial) {
      setDialInput(dial);
      setSelectedLine(line);
      pendingDialRef.current = { dial, line };
    }
  }, [searchParams]);

  useEffect(() => {
    if (status !== 'ready' || !pendingDialRef.current || autoDialDone.current) return;
    if (!lines.length) return;
    autoDialDone.current = true;
    const { dial, line } = pendingDialRef.current;
    placeCall(dial, line);
    pendingDialRef.current = null;
  }, [status, lines, placeCall]);

  useEffect(() => {
    if (status !== 'ready') return;
    const id = setInterval(() => sendPresence(true), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [status, sendPresence]);

  useEffect(() => {
    const onUnload = () => {
      try { clientRef.current?.disconnect(); } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onUnload);
    // Only disconnect on true page unmount — NOT when callback identities change.
    // Re-running this effect mid-call was hanging up after a few seconds.
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      onUnload();
      clientRef.current = null;
      connectLockRef.current = false;
    };
  }, []);

  if (!isLoaded || !isSuperAdmin) return null;

  const callerLineNumber = lines.find((l) => l.key === selectedLine)?.number;

  return (
    <PageShell>
      <PageHeader
        title="Phone"
        subtitle="Stays online across refresh. Go offline only when you want to stop receiving calls."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Badge variant={status === 'ready' ? 'default' : 'secondary'}>
                {status === 'ready' ? 'Online' : status}
              </Badge>
              {statusDetail && (
                <span className="text-sm text-muted-foreground truncate">{statusDetail}</span>
              )}
            </div>
            {status === 'ready' ? (
              <Button variant="outline" size="sm" onClick={disconnectPhone}>Go offline</Button>
            ) : (
              <Button size="sm" onClick={goOnline} disabled={status === 'connecting'}>
                <Phone className="w-4 h-4 mr-1" /> Go online
              </Button>
            )}
          </div>

          {(callState || lastError) && (
            <div className="text-sm space-y-1">
              {callState && (
                <p className="text-muted-foreground">Call status: <span className="text-foreground">{callState}</span></p>
              )}
              {lastError && (
                <p className="text-destructive">{lastError}</p>
              )}
            </div>
          )}

          <audio id="telnyx-remote-audio" autoPlay />
          <audio id="telnyx-local-audio" autoPlay muted />

          {incomingCall && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PhoneIncoming className="w-5 h-5 text-amber-600" />
                <span>
                  Incoming from {incomingCall.remoteCallerNumber || 'unknown'}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => incomingCall.answer()}>Answer</Button>
                <Button size="sm" variant="outline" onClick={() => incomingCall.hangup()}>Decline</Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Caller ID line</label>
            <div className="flex gap-2">
              {lines.map((line) => (
                <Button
                  key={line.key}
                  type="button"
                  size="sm"
                  variant={selectedLine === line.key ? 'default' : 'outline'}
                  onClick={() => setSelectedLine(line.key)}
                >
                  {line.label}
                </Button>
              ))}
            </div>
            {callerLineNumber && (
              <p className="text-xs text-muted-foreground">{callerLineNumber}</p>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dial">Dial number</label>
            <input
              id="dial"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="+1 555 123 4567"
              value={dialInput}
              onChange={(e) => setDialInput(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={status !== 'ready' || !!activeCall || !dialInput.trim()}
              onClick={() => placeCall(dialInput.trim(), selectedLine)}
            >
              <Phone className="w-4 h-4 mr-1" /> Call
            </Button>
            {activeCall && (
              <>
                <Button variant="destructive" onClick={() => activeCall.hangup()}>
                  <PhoneOff className="w-4 h-4 mr-1" /> Hang up
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (muted) {
                      activeCall.unmuteAudio();
                      setMuted(false);
                    } else {
                      activeCall.muteAudio();
                      setMuted(true);
                    }
                  }}
                >
                  {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </Button>
              </>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold mb-3">Recent calls</h2>
          <ul className="space-y-2 text-sm max-h-[420px] overflow-y-auto">
            {callLog.length === 0 && (
              <li className="text-muted-foreground">No calls logged yet.</li>
            )}
            {callLog.map((row) => (
              <li key={row.id} className="flex justify-between gap-2 border-b border-border/50 pb-2">
                <span>
                  <Badge variant="outline" className="mr-2 text-[10px]">{row.direction}</Badge>
                  {row.from_number || '?'} → {row.to_number || '?'}
                  {row.aura_line && <span className="text-muted-foreground"> ({row.aura_line})</span>}
                </span>
                <span className="text-muted-foreground shrink-0">{row.status}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
