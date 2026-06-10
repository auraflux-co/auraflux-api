'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { YouTubeIcon } from '@/components/icons/brand-icons';

interface Brand {
  id: string;
  name: string;
  youtubeConnected?: boolean;
}

export default function AdminConnectBrands() {
  const { getToken } = useAuth();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);

  // Hardcoded list of 20 brands
  const brandsList = [
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

  useEffect(() => {
    setBrands(brandsList);
    setLoading(false);
  }, []);

  async function handleConnect(brandId: string, brandName: string) {
    setConnecting(brandId);
    try {
      // Get fresh JWT token
      const token = await getToken();
      if (!token) {
        alert('Not authenticated. Please refresh and try again.');
        return;
      }

      // Build OAuth URL with fresh token
      const params = new URLSearchParams({
        token,
        brandId,
      });
      const oauthUrl = `https://auraflux-api.onrender.com/social/connect/youtube?${params}`;

      // Open in popup
      const popup = window.open(
        oauthUrl,
        `connect_${brandName}`,
        'width=520,height=680,scrollbars=yes,resizable=yes'
      );

      if (!popup) {
        // Fallback to new tab
        window.open(oauthUrl, '_blank');
      }

      // TODO: Listen for popup close and refresh connection status
      // For now, user will need to manually refresh the page
    } catch (err) {
      console.error('Connect error:', err);
      alert('Failed to start OAuth flow. See console for details.');
    } finally {
      setConnecting(null);
    }
  }

  if (loading) {
    return (
      <PageShell maxWidth="4xl">
        <PageHeader title="Connect YouTube Channels" subtitle="Loading brands..." />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="Connect YouTube Channels"
        subtitle="Connect YouTube OAuth for all 20 brand accounts"
      />

      <div className="space-y-2">
        {brands.map((brand) => (
          <Card key={brand.id}>
            <CardContent className="flex items-center gap-4 py-3 px-4">
              <div className="shrink-0">
                <YouTubeIcon size={32} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="af-h4">{brand.name}</div>
                <div className="af-label text-muted-foreground">
                  Brand ID: {brand.id.slice(0, 8)}...
                </div>
              </div>

              <div className="shrink-0">
                <Button
                  size="sm"
                  onClick={() => handleConnect(brand.id, brand.name)}
                  disabled={connecting === brand.id}
                >
                  {connecting === brand.id ? 'Opening...' : 'Connect YouTube'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 rounded-md bg-muted/50 p-4 af-body text-sm">
        <strong>Instructions:</strong>
        <ol className="list-decimal list-inside mt-2 space-y-1">
          <li>Click "Connect YouTube" for each brand</li>
          <li>Sign in with robert@auraflux.co when Google prompts</li>
          <li>Click "Allow" to grant YouTube permissions</li>
          <li>Popup will close automatically when complete</li>
          <li>Refresh this page to see updated status (coming soon)</li>
        </ol>
      </div>
    </PageShell>
  );
}
