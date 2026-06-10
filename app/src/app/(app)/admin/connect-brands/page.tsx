'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { YouTubeIcon } from '@/components/icons/brand-icons';
import { CheckCircle2, RefreshCw, ExternalLink, Phone, Copy, MessageSquare } from 'lucide-react';

interface BrandStatus {
  connected: boolean;
  handle?: string;
  connectedAt?: string;
}

interface PhoneInfo {
  telnyx_number: string | null;
  last_sms: string | null;
  last_sms_from: string | null;
  last_sms_at: string | null;
}

interface Brand {
  id: string;
  name: string;
}

const BRANDS: Brand[] = [
  { id: 'e561b5bc-d10e-4045-8aa8-1162d636c50a', name: 'natashaughey' },
  { id: '310c354b-b04e-4554-b77e-2538ae849d0f', name: 'martinezofwonkru' },
  { id: 'bbe31325-659c-4c39-8c19-c32a63fc6f47', name: 'thevarietygurl' },
  { id: '76a24965-7036-46df-9f41-96ff750a9901', name: 'millkberry' },
  { id: '4032fadd-ecdf-46bc-9432-c53c7eaf64e0', name: 'lettucek' },
  { id: 'ac338165-9680-4eef-ae1d-61c7e496d3e7', name: 'fuzzyness' },
  { id: '7bb7fa9f-e514-4dfc-bb5b-e31fdcda28e4', name: 'hana' },
  { id: 'e2bbdd10-5c16-4b72-86fa-94b648012be3', name: 'wanderbot' },
  { id: '62cb5199-7d44-414f-b710-878944e5421b', name: 'somarcus' },
  { id: '69026a46-84d3-4063-ab4d-c8c02e671dc6', name: 'rockleesmile' },
  { id: 'f0a87d3f-805f-42fc-a370-b03c00ff467b', name: 'clintus' },
  { id: 'ff734c6d-3ef9-4570-98f8-1b6e99c4a74a', name: 'ninuschk' },
  { id: 'dab14ea6-ec0a-47b0-b22f-8d4bb6b9e601', name: 'alluux' },
  { id: '610e5d06-5e90-49db-9bf4-3fbb103eb3af', name: 'patterrz' },
  { id: 'a9db4f44-962f-4bd5-a302-686ee1e5729d', name: 'supermcgamer' },
  { id: '077b4356-6be6-41f1-ae17-6ed1a1714ae2', name: 't10nat' },
  { id: '02771263-927c-4f27-9d40-31a36af2f9ba', name: 'guhrl' },
  { id: '79064ec5-d232-4d21-9fd4-32a8dc6052ec', name: 'tenshi' },
  { id: '6a45ab1e-9ba5-45a0-be7a-14eeb12daf17', name: 'bogur' },
  { id: 'f3689caa-27a2-491a-b427-7dbf3c99cf9', name: 'nixstah' },
];

const API = 'https://auraflux-api.onrender.com';

function formatSmsAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Extract likely verification code from SMS body
function extractCode(body: string): string | null {
  const m = body.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

export default function AdminConnectBrands() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<Record<string, BrandStatus>>({});
  const [phoneInfo, setPhoneInfo] = useState<Record<string, PhoneInfo>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'youtube' | 'phone'>('phone');
  const smsPollerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/brand-oauth-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (data.ok) setStatus(data.brands ?? {});
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [getToken]);

  const fetchPhoneInfo = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/admin/brand-numbers`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.brands)) {
        const byId: Record<string, PhoneInfo> = {};
        for (const b of data.brands) {
          byId[b.id] = {
            telnyx_number: b.telnyx_number || null,
            last_sms: b.last_sms || null,
            last_sms_from: b.last_sms_from || null,
            last_sms_at: b.last_sms_at || null,
          };
        }
        setPhoneInfo(byId);
      }
    } catch {
      // non-fatal
    }
  }, [getToken]);

  useEffect(() => {
    fetchStatus();
    fetchPhoneInfo();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('social_connected');
    const error = params.get('social_error');
    if (connected || error) {
      window.history.replaceState({}, '', '/admin/connect-brands');
      if (window.opener) {
        try {
          window.opener.postMessage({ type: 'oauth_complete', platform: connected || 'unknown', error: error || null }, '*');
        } catch (_e) { /* cross-origin */ }
        window.close();
      } else if (error) {
        setOauthError(decodeURIComponent(error));
      }
    }
  }, [fetchStatus, fetchPhoneInfo]);

  // Auto-refresh SMS codes every 15s when on phone tab
  useEffect(() => {
    if (activeTab === 'phone') {
      smsPollerRef.current = setInterval(fetchPhoneInfo, 15000);
    }
    return () => {
      if (smsPollerRef.current) clearInterval(smsPollerRef.current);
    };
  }, [activeTab, fetchPhoneInfo]);

  async function handleConnect(brandId: string, brandName: string) {
    setConnecting(brandId);
    try {
      const token = await getToken();
      if (!token) { alert('Not authenticated. Please refresh.'); return; }

      const params = new URLSearchParams({ token, brandId });
      const oauthUrl = `${API}/social/connect/youtube?${params}`;
      const popup = window.open(oauthUrl, `connect_${brandName}`, 'width=520,height=680,scrollbars=yes,resizable=yes');

      if (!popup) { window.open(oauthUrl, '_blank'); return; }

      const finish = () => { setConnecting(null); setRefreshing(true); fetchStatus(); };

      const onMessage = (e: MessageEvent) => {
        if (e.data?.type === 'oauth_complete') {
          window.removeEventListener('message', onMessage);
          clearInterval(timer);
          if (e.data?.error) {
            setOauthError(`OAuth failed: ${e.data.error}. Click Allow on the Google consent screen.`);
          }
          finish();
        }
      };
      window.addEventListener('message', onMessage);

      const timer = setInterval(() => {
        if (popup.closed) { clearInterval(timer); window.removeEventListener('message', onMessage); finish(); }
      }, 800);
    } catch (err) {
      console.error('Connect error:', err);
      alert('Failed to start OAuth flow.');
      setConnecting(null);
    }
  }

  async function handleProvision() {
    const secret = prompt('Enter ADMIN_SECRET to provision Telnyx numbers:');
    if (!secret) return;
    setProvisioning(true);
    setProvisionResult(null);
    try {
      const res = await fetch(`${API}/api/admin/provision-brand-numbers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      if (data.ok) {
        const msg = data.provisioned?.length
          ? `Provisioned ${data.provisioned.length} numbers: ${data.provisioned.map((p: { brand: string; number: string }) => `${p.brand} → ${p.number}`).join(', ')}`
          : data.message || 'Done';
        setProvisionResult(msg);
        fetchPhoneInfo();
      } else {
        setProvisionResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setProvisionResult(`Request failed: ${String(err)}`);
    } finally {
      setProvisioning(false);
    }
  }

  function copyNumber(num: string) {
    navigator.clipboard.writeText(num).catch(() => {});
    setCopied(num);
    setTimeout(() => setCopied(null), 2000);
  }

  const connectedCount = Object.values(status).filter((s) => s.connected).length;
  const numbersCount = Object.values(phoneInfo).filter((p) => p.telnyx_number).length;

  const handleCount: Record<string, number> = {};
  Object.values(status).forEach((s) => {
    if (s.connected && s.handle) handleCount[s.handle] = (handleCount[s.handle] || 0) + 1;
  });
  const duplicateHandles = new Set(Object.entries(handleCount).filter(([, c]) => c > 1).map(([h]) => h));

  if (loading) {
    return (
      <PageShell maxWidth="4xl">
        <PageHeader title="Brand Setup" subtitle="Loading..." />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Brand Setup"
        subtitle={`${connectedCount} / ${BRANDS.length} YouTube connected · ${numbersCount} / ${BRANDS.length} phone numbers assigned`}
      />

      {/* Tab switcher */}
      <div className="flex gap-2 mb-4 border-b border-border pb-2">
        <button
          className={`px-4 py-1.5 text-sm rounded-t font-medium transition-colors ${activeTab === 'phone' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('phone')}
        >
          <Phone className="h-3.5 w-3.5 inline mr-1.5" />
          Phone Numbers ({numbersCount}/{BRANDS.length})
        </button>
        <button
          className={`px-4 py-1.5 text-sm rounded-t font-medium transition-colors ${activeTab === 'youtube' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setActiveTab('youtube')}
        >
          <YouTubeIcon size={14} />
          <span className="ml-1.5">YouTube ({connectedCount}/{BRANDS.length})</span>
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between mb-3">
        {activeTab === 'phone' ? (
          <Button
            size="sm"
            variant="default"
            onClick={handleProvision}
            disabled={provisioning || numbersCount >= BRANDS.length}
          >
            <Phone className="h-3.5 w-3.5 mr-1.5" />
            {provisioning ? 'Provisioning...' : numbersCount >= BRANDS.length ? 'All numbers assigned' : `Provision ${BRANDS.length - numbersCount} numbers`}
          </Button>
        ) : <div />}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setRefreshing(true); fetchStatus(); fetchPhoneInfo(); }}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Notifications */}
      {oauthError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/8 px-4 py-3 text-sm text-red-400 mb-3 flex items-start justify-between gap-3">
          <span><strong>Connection error:</strong> {oauthError}</span>
          <button onClick={() => setOauthError(null)} className="shrink-0 text-red-400/60 hover:text-red-400">✕</button>
        </div>
      )}
      {provisionResult && (
        <div className="rounded-md border border-blue-500/40 bg-blue-500/8 px-4 py-3 text-sm text-blue-300 mb-3 flex items-start justify-between gap-3">
          <span>{provisionResult}</span>
          <button onClick={() => setProvisionResult(null)} className="shrink-0 text-blue-400/60 hover:text-blue-400">✕</button>
        </div>
      )}
      {activeTab === 'youtube' && duplicateHandles.size > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/8 px-4 py-3 text-sm text-amber-400 mb-3">
          <strong>Duplicate channels:</strong> {[...duplicateHandles].join(', ')} — each brand needs its own channel.
        </div>
      )}

      {/* ── Phone Numbers Tab ────────────────────────────────────────────── */}
      {activeTab === 'phone' && (
        <>
          <div className="space-y-2">
            {BRANDS.map((brand) => {
              const phone = phoneInfo[brand.id];
              const num = phone?.telnyx_number;
              const lastSms = phone?.last_sms;
              const lastSmsAt = phone?.last_sms_at;
              const code = lastSms ? extractCode(lastSms) : null;
              const isRecent = lastSmsAt ? (Date.now() - new Date(lastSmsAt).getTime()) < 10 * 60 * 1000 : false;

              return (
                <Card
                  key={brand.id}
                  className={
                    isRecent && code ? 'border-green-500/50 bg-green-500/5' :
                    num ? 'border-border' : 'border-dashed border-border/50'
                  }
                >
                  <CardContent className="flex items-center gap-4 py-3 px-4">
                    <div className="shrink-0 text-muted-foreground">
                      <Phone className="h-5 w-5" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="af-h4">{brand.name}</div>
                      {num ? (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="af-label font-mono text-foreground">{num}</span>
                          <button
                            onClick={() => copyNumber(num)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Copy"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          {copied === num && <span className="text-xs text-green-400">Copied!</span>}
                        </div>
                      ) : (
                        <div className="af-label text-muted-foreground">No number assigned yet</div>
                      )}
                    </div>

                    {/* Latest SMS / verification code */}
                    {lastSms && (
                      <div className={`shrink-0 max-w-xs text-right ${isRecent ? 'text-green-400' : 'text-muted-foreground'}`}>
                        {code && (
                          <div className="flex items-center justify-end gap-1.5 mb-0.5">
                            <MessageSquare className="h-3.5 w-3.5" />
                            <span className="font-mono text-base font-bold tracking-widest">{code}</span>
                            <button
                              onClick={() => copyNumber(code)}
                              className="text-muted-foreground hover:text-foreground"
                              title="Copy code"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                        <div className="text-xs truncate max-w-[200px]" title={lastSms}>{lastSms}</div>
                        <div className="text-xs opacity-60">{formatSmsAge(lastSmsAt!)}</div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="mt-6 rounded-md bg-muted/50 p-4 text-sm space-y-2">
            <strong>How to use these numbers:</strong>
            <ol className="list-decimal list-inside mt-2 space-y-1 text-muted-foreground">
              <li>Click <strong>Provision numbers</strong> above to buy a Telnyx number for each brand</li>
              <li>When creating a TikTok or Instagram account, use the brand&apos;s assigned number as the phone</li>
              <li>The verification code SMS will appear here automatically (auto-refreshes every 15s)</li>
              <li>Copy the 4–8 digit code and paste it into TikTok/Instagram to verify</li>
            </ol>
          </div>
        </>
      )}

      {/* ── YouTube Tab ─────────────────────────────────────────────────── */}
      {activeTab === 'youtube' && (
        <>
          <div className="space-y-2">
            {BRANDS.map((brand) => {
              const s = status[brand.id];
              const isConnected = s?.connected;
              const isDuplicate = isConnected && s.handle && duplicateHandles.has(s.handle);
              return (
                <Card key={brand.id} className={isDuplicate ? 'border-amber-500/40 bg-amber-500/5' : isConnected ? 'border-green-500/40 bg-green-500/5' : ''}>
                  <CardContent className="flex items-center gap-4 py-3 px-4">
                    <div className="shrink-0">
                      <YouTubeIcon size={32} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="af-h4">{brand.name}</div>
                      <div className={`af-label ${isDuplicate ? 'text-amber-400' : 'text-muted-foreground'}`}>
                        {isConnected
                          ? <>Connected{s.handle ? <> · <span className="font-medium">{s.handle}</span></> : ''}{isDuplicate ? ' ⚠ duplicate channel' : ''}</>
                          : 'Not connected'}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {isConnected && !isDuplicate && <CheckCircle2 className="h-5 w-5 text-green-500" />}
                      {isConnected && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="View social settings as this brand"
                          onClick={() => {
                            localStorage.setItem('auraflux_active_brand_id', brand.id);
                            window.open('/settings/social', '_blank');
                          }}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={isConnected ? 'outline' : 'default'}
                        onClick={() => handleConnect(brand.id, brand.name)}
                        disabled={connecting === brand.id}
                      >
                        {connecting === brand.id ? 'Opening...' : isConnected ? 'Reconnect' : 'Connect YouTube'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <div className="mt-6 rounded-md bg-muted/50 p-4 text-sm space-y-2">
            <strong>Instructions:</strong>
            <ol className="list-decimal list-inside mt-2 space-y-1">
              <li>Click <strong>Connect YouTube</strong> for each brand</li>
              <li>In the popup, sign in with the <strong>correct Google account</strong> for that brand&apos;s channel</li>
              <li>If Google shows the wrong account, click <strong>&ldquo;Use a different account&rdquo;</strong></li>
              <li>Click <strong>Allow</strong> and the popup closes automatically</li>
            </ol>
          </div>
        </>
      )}
    </PageShell>
  );
}
