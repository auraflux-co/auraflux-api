'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { YouTubeIcon } from '@/components/icons/brand-icons';
import { CheckCircle2, RefreshCw } from 'lucide-react';

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

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/admin/brand-oauth-status`);
      const data = await res.json();
      if (data.ok) setStatus(data.brands ?? {});
    } catch {
      // non-fatal
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    // Also pick up ?social_connected or ?social_error from OAuth callback redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get('social_connected') || params.get('social_error')) {
      // Strip query params without reloading
      window.history.replaceState({}, '', '/admin/connect-brands');
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

      // Poll until popup closes, then refresh status
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          setConnecting(null);
          setRefreshing(true);
          fetchStatus();
        }
      }, 800);
    } catch (err) {
      console.error('Connect error:', err);
      alert('Failed to start OAuth flow. See console for details.');
      setConnecting(null);
    }
  }

  const connectedCount = Object.values(status).filter((s) => s.connected).length;

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

      <div className="space-y-2">
        {BRANDS.map((brand) => {
          const s = status[brand.id];
          const isConnected = s?.connected;
          return (
            <Card key={brand.id} className={isConnected ? 'border-green-500/40 bg-green-500/5' : ''}>
              <CardContent className="flex items-center gap-4 py-3 px-4">
                <div className="shrink-0">
                  <YouTubeIcon size={32} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="af-h4">{brand.name}</div>
                  <div className="af-label text-muted-foreground">
                    {isConnected
                      ? `Connected${s.handle ? ` · ${s.handle}` : ''}`
                      : `Brand ID: ${brand.id.slice(0, 8)}...`}
                  </div>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {isConnected && (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
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

      <div className="mt-6 rounded-md bg-muted/50 p-4 af-body text-sm">
        <strong>Instructions:</strong>
        <ol className="list-decimal list-inside mt-2 space-y-1">
          <li>Click &ldquo;Connect YouTube&rdquo; for each brand</li>
          <li>Sign in with the correct YouTube account when Google prompts</li>
          <li>Click &ldquo;Allow&rdquo; to grant permissions</li>
          <li>Status updates automatically when the popup closes</li>
        </ol>
      </div>
    </PageShell>
  );
}
