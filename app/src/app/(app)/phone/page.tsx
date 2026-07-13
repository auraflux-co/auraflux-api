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
  answer: () => void;
  hangup: () => void;
  muteAudio: () => void;
  unmuteAudio: () => void;
};

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
  const clientRef = useRef<TelnyxClient | null>(null);
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

  const placeCall = useCallback((destination: string, lineKey: string) => {
    const client = clientRef.current;
    const line = lines.find((l) => l.key === lineKey) || lines[0];
    if (!client || !line) return;
    const call = client.newCall({
      destinationNumber: destination,
      callerNumber: line.number,
      audio: true,
      video: false,
    });
    setActiveCall(call);
    setIncomingCall(null);
  }, [lines]);

  const connectPhone = useCallback(async () => {
    if (clientRef.current) return;
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
        setStatus('ready');
        setStatusDetail('Connected — you will receive inbound calls');
        sendPresence(true);
      });

      client.on('telnyx.error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('error');
        setStatusDetail(msg);
      });

      client.on('telnyx.notification', (...args: unknown[]) => {
        const notification = args[0] as { type?: string; call?: TelnyxCall };
        const call = notification.call;
        if (!call) return;
        if (notification.type === 'callUpdate') {
          if (call.state === 'ringing' && call.direction === 'inbound') {
            setIncomingCall(call);
          }
          if (call.state === 'active') {
            setActiveCall(call);
            setIncomingCall(null);
          }
          if (call.state === 'hangup' || call.state === 'destroy') {
            setActiveCall(null);
            setIncomingCall(null);
            setMuted(false);
            loadCallLog();
          }
        }
      });

      clientRef.current = client;
      client.connect();
    } catch (err) {
      setStatus('error');
      setStatusDetail(err instanceof Error ? err.message : 'Connect failed');
    }
  }, [authFetch, loadCallLog, sendPresence]);

  const disconnectPhone = useCallback(() => {
    const client = clientRef.current;
    if (client) {
      client.disconnect();
      clientRef.current = null;
    }
    sendPresence(false);
    setStatus('offline');
    setStatusDetail('');
    setActiveCall(null);
    setIncomingCall(null);
  }, [sendPresence]);

  useEffect(() => {
    loadLines();
    loadCallLog();
  }, [loadLines, loadCallLog]);

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
      if (clientRef.current) clientRef.current.disconnect();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      disconnectPhone();
    };
  }, [disconnectPhone]);

  if (!isLoaded || !isSuperAdmin) return null;

  const callerLineNumber = lines.find((l) => l.key === selectedLine)?.number;

  return (
    <PageShell>
      <PageHeader
        title="Phone"
        subtitle="WebRTC desk phone — inbound rings here when you are online. Use 437 or 571 caller ID for outbound."
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
              <Button size="sm" onClick={connectPhone} disabled={status === 'connecting'}>
                <Phone className="w-4 h-4 mr-1" /> Go online
              </Button>
            )}
          </div>

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
