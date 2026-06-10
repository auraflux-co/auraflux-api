'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { YouTubeIcon } from '@/components/icons/brand-icons';
import { CheckCircle2, RefreshCw, ExternalLink } from 'lucide-react';

interface BrandStatus {
  connected: boolean;
  handle?: string;
  connectedAt?: string;
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

export default function AdminConnectBrands() {
  const { getToken } = useAuth();
  const [status, setStatus] = useState<Record<string, BrandStatus>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

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

  useEffect(() => {
    fetchStatus();
    // Pick up ?social_connected or ?social_error injected by OAuth callback redirect.
    // If we're running inside a popup (window.opener is set), close this window so the
    // parent page's popup.closed timer fires and it refreshes status automatically.
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('social_connected');
    const error = params.get('social_error');
    if (connected || error) {
      window.history.replaceState({}, '', '/admin/connect-brands');
      if (window.opener) {
        // Running as a popup — signal success/error back to the opener then close.
        try {
          window.opener.postMessage({ type: 'oauth_complete', platform: connected || 'unknown', error: error || null }, '*');
        } catch (_e) { /* cross-origin — ignore, popup.closed timer will catch it */ }
        window.close();
      } else if (error) {
        // Opened in main tab (not a popup) — show the error inline
        setOauthError(decodeURIComponent(error));
      }
    }
  }, [fetchStatus]);

  async function handleConnect(brandId: string, brandName: string) {
    setConnecting(brandId);
    try {
      const token = await getToken();
      if (!token) {
        alert('Not authenticated. Please refresh and try again.');
        return;
      }

      const params = new URLSearchParams({ token, brandId });
      const oauthUrl = `${API}/social/connect/youtube?${params}`;

      const popup = window.open(
        oauthUrl,
        `connect_${brandName}`,
        'width=520,height=680,scrollbars=yes,resizable=yes'
      );

      if (!popup) {
        window.open(oauthUrl, '_blank');
        return;
      }

      const finish = () => {
        setConnecting(null);
        setRefreshing(true);
        fetchStatus();
      };

      // Primary: listen for the postMessage the popup sends on OAuth completion.
      // This fires as soon as the popup calls window.close(), before the interval fires.
      const onMessage = (e: MessageEvent) => {
        if (e.data?.type === 'oauth_complete') {
          window.removeEventListener('message', onMessage);
          clearInterval(timer);
          if (e.data?.error) {
            setOauthError(`OAuth failed: ${e.data.error}. Make sure to click Allow on the Google consent screen.`);
          }
          finish();
        }
      };
      window.addEventListener('message', onMessage);

      // Fallback: poll popup.closed in case postMessage was blocked (cross-origin or popup blocker)
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          window.removeEventListener('message', onMessage);
          finish();
        }
      }, 800);
    } catch (err) {
      console.error('Connect error:', err);
      alert('Failed to start OAuth flow. See console for details.');
      setConnecting(null);
    }
  }

  const connectedCount = Object.values(status).filter((s) => s.connected).length;

  // Detect duplicate handles — same YouTube channel connected to multiple brands
  const handleCount: Record<string, number> = {};
  Object.values(status).forEach((s) => {
    if (s.connected && s.handle) {
      handleCount[s.handle] = (handleCount[s.handle] || 0) + 1;
    }
  });
  const duplicateHandles = new Set(Object.entries(handleCount).filter(([, c]) => c > 1).map(([h]) => h));

  if (loading) {
    return (
      <PageShell maxWidth="4xl">
        <PageHeader title="Connect YouTube Channels" subtitle="Loading status..." />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Connect YouTube Channels"
        subtitle={`${connectedCount} / ${BRANDS.length} brands connected`}
      />

      <div className="flex items-center justify-end mb-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setRefreshing(true); fetchStatus(); }}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-1.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {oauthError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/8 px-4 py-3 text-sm text-red-400 mb-3 flex items-start justify-between gap-3">
          <span><strong>Connection error:</strong> {oauthError}</span>
          <button onClick={() => setOauthError(null)} className="shrink-0 text-red-400/60 hover:text-red-400">✕</button>
        </div>
      )}

      {duplicateHandles.size > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/8 px-4 py-3 text-sm text-amber-400 mb-3">
          <strong>Duplicate channels detected:</strong> {[...duplicateHandles].join(', ')} is connected to more than one brand.
          Each brand needs its own YouTube channel. Sign in with a different Google account when connecting each brand.
        </div>
      )}

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
                      : `Not connected`}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {isConnected && !isDuplicate && (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  )}
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
                    {connecting === brand.id
                      ? 'Opening...'
                      : isConnected
                      ? 'Reconnect'
                      : 'Connect YouTube'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 rounded-md bg-muted/50 p-4 af-body text-sm space-y-2">
        <strong>Instructions:</strong>
        <ol className="list-decimal list-inside mt-2 space-y-1">
          <li>Click <strong>Connect YouTube</strong> for each brand</li>
          <li>In the popup, sign in with the <strong>correct Google account</strong> for that brand&apos;s YouTube channel</li>
          <li>If Google shows the wrong account, click <strong>&ldquo;Use a different account&rdquo;</strong> and log in with the right one</li>
          <li>Click <strong>Allow</strong> to grant permissions</li>
          <li>The popup closes automatically and status updates immediately</li>
        </ol>
        <p className="text-muted-foreground mt-2">
          <strong>Important:</strong> Each brand must connect to its own unique YouTube channel.
          If you see a &ldquo;duplicate channel&rdquo; warning, reconnect that brand using the correct Google account.
        </p>
      </div>
    </PageShell>
  );
}
