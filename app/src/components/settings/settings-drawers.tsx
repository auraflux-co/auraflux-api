'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { formatUserError } from '@/lib/job-labels';
import { YouTubeIcon, TikTokIcon, InstagramIcon } from '@/components/icons/brand-icons';
import {
  apiFetch,
  disconnectPlatform,
  getActiveBrandId,
  getBrands,
  getChannelConnections,
  getSocialConnectUrl,
  getSourceChannels,
  listConnectedAccounts,
  updateBrandApi,
  uploadBrandAsset,
  type Brand,
  type BrandAssetType,
  type ConnectedAccount,
  type SocialPlatform,
  type SourceChannels,
} from '@/lib/api';

type DrawerKey = 'brand' | 'channels' | 'social' | 'team' | null;

type SettingsDrawersProps = {
  open: DrawerKey;
  onOpenChange: (open: DrawerKey) => void;
  onStatusChange?: () => void;
};

type MemberRole = 'admin' | 'member' | 'billing';

const INVITE_ROLE_OPTIONS: Array<{ value: MemberRole; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Editor' },
  { value: 'billing', label: 'Viewer' },
];

function tokenStatus(account: ConnectedAccount): 'Active' | 'Token Expired' | 'Reconnect soon' {
  if (!account.tokenExpiry) return 'Active';
  const exp = new Date(account.tokenExpiry).getTime();
  if (Number.isNaN(exp)) return 'Active';
  if (exp < Date.now() && !account.hasRefreshToken) return 'Token Expired';
  if (exp - Date.now() < 7 * 24 * 60 * 60 * 1000 && !account.hasRefreshToken) return 'Reconnect soon';
  return 'Active';
}

function MiniUploader({
  label,
  accept,
  assetType,
  currentUrl,
  brandId,
  token,
  isVideo,
  onUploaded,
}: {
  label: string;
  accept: string;
  assetType: BrandAssetType;
  currentUrl: string | null;
  brandId: string;
  token: string;
  isVideo?: boolean;
  onUploaded: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    setUploading(true);
    try {
      const { assetUrl } = await uploadBrandAsset(brandId, assetType, file, token);
      onUploaded(assetUrl);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-white">{label}</p>
        <Badge
          variant="outline"
          className={cn(
            'text-[10px]',
            currentUrl
              ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
              : 'text-slate-400 border-slate-700',
          )}
        >
          {currentUrl ? 'Uploaded' : 'Missing'}
        </Badge>
      </div>
      {currentUrl && !isVideo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={currentUrl} alt="" className="h-14 w-14 rounded object-contain bg-slate-800" />
      )}
      {currentUrl && isVideo && (
        <video src={currentUrl} className="h-16 w-full rounded bg-slate-800 object-cover" controls />
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 w-full border-slate-700 text-slate-200"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? 'Uploading…' : currentUrl ? 'Replace file' : 'Upload file'}
      </Button>
      {error && <p className="text-xs text-destructive">{formatUserError(error)}</p>}
    </div>
  );
}

function BrandDrawer({
  open,
  onClose,
  onStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  onStatusChange?: () => void;
}) {
  const { getToken } = useAuth();
  const { activeBrand, setActiveBrand } = useBrand();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [token, setToken] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      const t = (await getToken()) ?? '';
      setToken(t);
      try {
        const all = await getBrands(t || undefined);
        const match = all.find((b) => b.id === activeBrand?.id) ?? all[0] ?? activeBrand;
        setBrand(match ?? null);
      } catch {
        setBrand(activeBrand);
      }
    })();
  }, [open, getToken, activeBrand]);

  const saveAsset = useCallback(
    async (field: 'image_url' | 'intro_card_url' | 'outro_card_url', url: string) => {
      if (!brand || !token) return;
      const updated = await updateBrandApi(brand.id, { [field]: url }, token);
      setBrand(updated);
      if (field === 'image_url') setActiveBrand(updated);
      onStatusChange?.();
    },
    [brand, token, setActiveBrand, onStatusChange],
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Brand assets"
      description="Logo, intro, and outro applied to assembled videos."
      footer={
        <Link href="/settings/brand" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}>
          Open full Brand settings →
        </Link>
      }
    >
      {!brand || !token ? (
        <p className="text-sm text-slate-400">Loading brand…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-slate-300 font-medium">{brand.name}</p>
          <MiniUploader
            label="Logo"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            assetType="logo"
            currentUrl={brand.image_url}
            brandId={brand.id}
            token={token}
            onUploaded={(url) => void saveAsset('image_url', url)}
          />
          <MiniUploader
            label="Intro card"
            accept="video/mp4,video/webm"
            assetType="intro_card"
            currentUrl={brand.intro_card_url}
            brandId={brand.id}
            token={token}
            isVideo
            onUploaded={(url) => void saveAsset('intro_card_url', url)}
          />
          <MiniUploader
            label="Outro card"
            accept="video/mp4,video/webm"
            assetType="outro_card"
            currentUrl={brand.outro_card_url}
            brandId={brand.id}
            token={token}
            isVideo
            onUploaded={(url) => void saveAsset('outro_card_url', url)}
          />
        </div>
      )}
    </Sheet>
  );
}

function SocialDrawer({
  open,
  onClose,
  onStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  onStatusChange?: () => void;
}) {
  const { getToken } = useAuth();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [busy, setBusy] = useState<SocialPlatform | null>(null);
  const [error, setError] = useState<string | null>(null);

  const platforms: Array<{ id: SocialPlatform; label: string; icon: ReactNode }> = [
    { id: 'youtube', label: 'YouTube', icon: <YouTubeIcon size={28} /> },
    { id: 'tiktok', label: 'TikTok', icon: <TikTokIcon size={28} /> },
    { id: 'instagram', label: 'Instagram', icon: <InstagramIcon size={28} /> },
  ];

  async function refresh() {
    const token = await getToken();
    const res = await listConnectedAccounts(token ?? undefined);
    setAccounts(res.accounts ?? []);
    onStatusChange?.();
  }

  useEffect(() => {
    if (!open) return;
    refresh().catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(platform: SocialPlatform) {
    const token = await getToken();
    const url = new URL(getSocialConnectUrl(platform));
    if (token) url.searchParams.set('token', token);
    const brandId = getActiveBrandId();
    if (brandId) url.searchParams.set('brandId', brandId);
    window.open(url.toString(), 'auraflux_social_connect', 'width=520,height=680');
    setTimeout(() => { void refresh(); }, 1500);
  }

  async function disconnect(platform: SocialPlatform) {
    setBusy(platform);
    setError(null);
    try {
      const token = await getToken();
      await disconnectPlatform(platform, token ?? undefined);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Disconnect failed');
    } finally {
      setBusy(null);
    }
  }

  const map = Object.fromEntries(accounts.map((a) => [a.platform, a]));

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Social accounts"
      description="Connect or disconnect publish destinations."
      footer={
        <Link href="/settings/social" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}>
          Open full Social settings →
        </Link>
      }
    >
      {error && <p className="mb-3 text-xs text-destructive">{formatUserError(error)}</p>}
      <div className="space-y-3">
        {platforms.map((p) => {
          const acct = map[p.id] as ConnectedAccount | undefined;
          const status = acct ? tokenStatus(acct) : null;
          return (
            <div key={p.id} className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="shrink-0">{p.icon}</div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">{p.label}</p>
                <p className="truncate text-xs text-slate-400">
                  {acct ? (acct.handle || acct.platformUserId || 'Connected') : 'Not connected'}
                </p>
              </div>
              {status && (
                <Badge
                  variant="outline"
                  className={cn(
                    'shrink-0 text-[10px]',
                    status === 'Active'
                      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                      : status === 'Token Expired'
                        ? 'text-red-400 border-red-500/30 bg-red-500/10'
                        : 'text-amber-400 border-amber-500/30 bg-amber-500/10',
                  )}
                >
                  {status}
                </Badge>
              )}
              {acct ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-slate-300"
                  disabled={busy === p.id}
                  onClick={() => void disconnect(p.id)}
                >
                  {busy === p.id ? '…' : 'Disconnect'}
                </Button>
              ) : (
                <Button size="sm" className="h-8" onClick={() => void connect(p.id)}>
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

function TeamDrawer({
  open,
  onClose,
  onStatusChange,
}: {
  open: boolean;
  onClose: () => void;
  onStatusChange?: () => void;
}) {
  const { getToken } = useAuth();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [inviting, setInviting] = useState(false);
  const [result, setResult] = useState<{ url?: string; error?: string } | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const token = await getToken();
        const data = await apiFetch<{ members: unknown[] }>('/team', { token: token ?? undefined });
        setMemberCount(data.members?.length ?? 0);
      } catch {
        setMemberCount(null);
      }
    })();
  }, [open, getToken]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setResult(null);
    try {
      const token = await getToken();
      const res = await apiFetch<{ ok: boolean; inviteUrl?: string; error?: string }>(
        '/team/invite',
        {
          method: 'POST',
          body: JSON.stringify({ email, role }),
          token: token ?? undefined,
        },
      );
      if (res.ok) {
        setResult({ url: res.inviteUrl });
        setEmail('');
        onStatusChange?.();
        setMemberCount((n) => (n == null ? 1 : n + 1));
      } else {
        setResult({ error: res.error || 'Invite failed' });
      }
    } catch (err: unknown) {
      setResult({ error: err instanceof Error ? err.message : 'Invite failed' });
    } finally {
      setInviting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Team invite"
      description={memberCount != null ? `${memberCount} member${memberCount === 1 ? '' : 's'} on this account.` : 'Quick-invite a collaborator.'}
      footer={
        <Link href="/settings/team" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}>
          Open full Team settings →
        </Link>
      }
    >
      <form onSubmit={invite} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email" className="text-slate-300">Email</Label>
          <Input
            id="invite-email"
            type="email"
            required
            placeholder="teammate@studio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9 bg-slate-900 border-slate-700 text-white"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-role" className="text-slate-300">Role</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as MemberRole)}
            className="flex h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-3 text-sm text-white"
          >
            {INVITE_ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <Button type="submit" className="w-full" disabled={inviting || !email.trim()}>
          {inviting ? 'Sending…' : 'Send invite'}
        </Button>
        {result?.url && (
          <p className="break-all text-xs text-slate-400">Invite link: {result.url}</p>
        )}
        {result?.error && (
          <p className="text-xs text-destructive">{formatUserError(result.error)}</p>
        )}
      </form>
    </Sheet>
  );
}

function ChannelsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const [sources, setSources] = useState<SourceChannels>({});
  const [oauthCount, setOauthCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const token = await getToken();
        const [ch, conn] = await Promise.all([
          getSourceChannels(token ?? undefined),
          getChannelConnections(token ?? undefined).catch(() => ({ connections: [] as unknown[] })),
        ]);
        setSources(ch.sourceChannels ?? {});
        setOauthCount((conn as { connections?: unknown[] }).connections?.length ?? 0);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, getToken]);

  const rows = [
    { label: 'Twitch', value: sources.twitchLogin },
    { label: 'Kick', value: sources.kickUsername },
    { label: 'YouTube', value: sources.youtubeHandle },
  ];

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => !v && onClose()}
      title="Source channels"
      description="Default channels for the Peaks source picker."
      footer={
        <Link href="/settings/channels" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full')}>
          Open full Channels settings →
        </Link>
      }
    >
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">{oauthCount} OAuth connection{oauthCount === 1 ? '' : 's'}</p>
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5">
              <span className="text-sm text-white">{r.label}</span>
              <span className="text-xs text-slate-400 truncate max-w-[55%]">
                {r.value || 'Not set'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

export function SettingsDrawers({ open, onOpenChange, onStatusChange }: SettingsDrawersProps) {
  return (
    <>
      <BrandDrawer open={open === 'brand'} onClose={() => onOpenChange(null)} onStatusChange={onStatusChange} />
      <ChannelsDrawer open={open === 'channels'} onClose={() => onOpenChange(null)} />
      <SocialDrawer open={open === 'social'} onClose={() => onOpenChange(null)} onStatusChange={onStatusChange} />
      <TeamDrawer open={open === 'team'} onClose={() => onOpenChange(null)} onStatusChange={onStatusChange} />
    </>
  );
}

export type { DrawerKey };
