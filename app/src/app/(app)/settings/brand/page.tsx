'use client';
/**
 * /settings/brand — Brand identity management
 *
 * Lets the account owner set:
 *   - Brand name
 *   - Logo (PNG/JPG/SVG/WEBP — burned into video overlays)
 *   - Intro card (MP4 — prepended to every assembled video)
 *   - Outro card (MP4 — appended to every assembled video)
 *
 * Upload flow: client gets a presigned PUT URL from the API, uploads
 * directly to R2, then PATCHes the brand record with the resulting URL.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBrand } from '@/contexts/brand-context';
import {
  getBrands,
  updateBrandApi,
  uploadBrandAsset,
  type Brand,
  type BrandAssetType,
} from '@/lib/api';

// ── helpers ───────────────────────────────────────────────────────────────────

function fileExt(file: File) {
  return file.name.includes('.') ? file.name.split('.').pop()! : '';
}

function humanSize(bytes: number) {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1048576)    return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ── AssetUploader component ───────────────────────────────────────────────────

interface AssetUploaderProps {
  label:       string;
  hint:        string;
  accept:      string;
  assetType:   BrandAssetType;
  currentUrl:  string | null;
  brandId:     string;
  token:       string;
  onUploaded:  (url: string) => void;
  isVideo?:    boolean;
}

function AssetUploader({
  label, hint, accept, assetType, currentUrl, brandId, token, onUploaded, isVideo,
}: AssetUploaderProps) {
  const inputRef                  = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [error,     setError]     = useState<string | null>(null);
  const [preview,   setPreview]   = useState<string | null>(currentUrl);

  useEffect(() => { setPreview(currentUrl); }, [currentUrl]);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    setProgress(0);

    try {
      const { assetUrl } = await uploadBrandAsset(
        brandId, assetType, file, token,
        (pct) => setProgress(pct),
      );

      setPreview(isVideo ? null : URL.createObjectURL(file));
      onUploaded(assetUrl);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }, [brandId, assetType, token, onUploaded, isVideo]);

  return (
    <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="af-caption text-muted-foreground mt-0.5">{hint}</p>
      </div>

      {/* Preview */}
      {preview && !isVideo && (
        <div className="relative w-24 h-24 rounded-lg overflow-hidden border border-border bg-muted flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Brand logo" className="object-contain w-full h-full p-2" />
        </div>
      )}
      {preview && isVideo && (
        <div className="relative rounded-lg overflow-hidden border border-border bg-muted aspect-video max-w-xs">
          <video src={preview} controls className="w-full h-full object-contain" />
        </div>
      )}
      {!preview && (
        <div className="w-full max-w-xs aspect-video rounded-lg border-2 border-dashed border-border bg-muted/40 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          {isVideo ? (
            <svg className="w-8 h-8 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          ) : (
            <svg className="w-8 h-8 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M13.5 12h.008v.008H13.5V12zm0-9h-3m4.5 4.5h-6m12 9.75H3.75m16.5 0a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0018.75 4.5H5.25A2.25 2.25 0 003 6.75v10.5A2.25 2.25 0 005.25 19.5z" />
            </svg>
          )}
          <span className="af-caption">No file uploaded</span>
        </div>
      )}

      {/* Progress bar */}
      {uploading && (
        <div className="w-full max-w-xs">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="af-caption text-muted-foreground mt-1">{progress}%</p>
        </div>
      )}

      {error && <p className="af-caption text-destructive">{error}</p>}

      <div className="flex gap-2 items-center">
        <Button
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? 'Uploading…' : preview ? 'Replace' : 'Upload'}
        </Button>
        {preview && (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={uploading}
            onClick={() => { setPreview(null); onUploaded(''); }}
          >
            Remove
          </Button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {preview && (
          <span className="af-caption text-muted-foreground ml-auto truncate max-w-[12rem]">
            {isVideo ? '✓ card uploaded' : '✓ logo uploaded'}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BrandSettingsPage() {
  const { getToken } = useAuth();
  const { activeBrand, setActiveBrand, brands: ctxBrands } = useBrand();

  const [brand,    setBrand]    = useState<Brand | null>(null);
  const [name,     setName]     = useState('');
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [loadErr,  setLoadErr]  = useState<string | null>(null);
  const [noBrand,  setNoBrand]  = useState(false);
  const [token,    setToken]    = useState<string>('');

  // Load token + active brand
  useEffect(() => {
    getToken().then((t) => setToken(t ?? ''));
  }, [getToken]);

  useEffect(() => {
    if (!activeBrand) return;
    setBrand(activeBrand as Brand);
    setName(activeBrand.name);
  }, [activeBrand]);

  // Fetch fresh brand data (includes intro/outro URLs not in context)
  useEffect(() => {
    if (!token) return;
    getBrands(token)
      .then((all) => {
        if (!all || all.length === 0) { setNoBrand(true); return; }
        const match = activeBrand ? all.find((b) => b.id === activeBrand.id) ?? all[0] : all[0];
        if (match) { setBrand(match); setName(match.name); }
        else setNoBrand(true);
      })
      .catch((e) => setLoadErr(e.message));
  }, [token, activeBrand]);

  const handleAssetUploaded = useCallback(
    async (field: 'image_url' | 'intro_card_url' | 'outro_card_url', url: string) => {
      if (!brand || !token) return;
      try {
        const updated = await updateBrandApi(brand.id, { [field]: url || null }, token);
        setBrand(updated);
        if (field === 'image_url') setActiveBrand(updated);
      } catch (e: unknown) {
        console.error('Failed to save asset URL', e);
      }
    },
    [brand, token, setActiveBrand],
  );

  const handleSaveName = async () => {
    if (!brand || !token || !name.trim()) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await updateBrandApi(brand.id, { name: name.trim() }, token);
      setBrand(updated);
      setActiveBrand(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: unknown) {
      console.error('Failed to save brand name', e);
    } finally {
      setSaving(false);
    }
  };

  if (loadErr) {
    return (
      <PageShell maxWidth="3xl">
        <PageHeader title="Brand" subtitle="Manage your brand identity" />
        <p className="text-destructive af-caption">{loadErr}</p>
      </PageShell>
    );
  }

  if (noBrand) {
    return (
      <PageShell maxWidth="3xl">
        <PageHeader title="Brand" subtitle="Manage your brand identity" />
        <p className="af-caption text-muted-foreground">
          No brand profile found for your account. Contact support to set one up.
        </p>
      </PageShell>
    );
  }

  if (!brand) {
    return (
      <PageShell maxWidth="3xl">
        <PageHeader title="Brand" subtitle="Manage your brand identity" />
        <div className="flex items-center gap-2 text-muted-foreground af-caption">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading brand…
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Brand"
        subtitle="Set your brand name, logo, and video bookend cards."
      />

      <div className="flex flex-col gap-6">

        {/* ── Brand name ── */}
        <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Brand name</p>
            <p className="af-caption text-muted-foreground mt-0.5">
              Displayed on your dashboard and used as the default show name in video overlays.
            </p>
          </div>
          <div className="flex gap-3 max-w-sm">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. AuraFlux"
              maxLength={80}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
            />
            <Button
              size="sm"
              disabled={saving || name.trim() === brand.name}
              onClick={handleSaveName}
            >
              {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
            </Button>
          </div>
        </div>

        {/* ── Logo ── */}
        <AssetUploader
          label="Brand logo"
          hint="Burned into the bottom-right of every video overlay. PNG, JPG, SVG, or WEBP. Recommended: 400×400px transparent PNG."
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          assetType="logo"
          currentUrl={brand.image_url}
          brandId={brand.id}
          token={token}
          onUploaded={(url) => handleAssetUploaded('image_url', url)}
          isVideo={false}
        />

        {/* ── Intro card ── */}
        <AssetUploader
          label="Intro card"
          hint="MP4 clip prepended to the start of every assembled video. Keep it under 5 seconds. 16:9, 1920×1080 recommended."
          accept="video/mp4,video/quicktime"
          assetType="intro_card"
          currentUrl={brand.intro_card_url}
          brandId={brand.id}
          token={token}
          onUploaded={(url) => handleAssetUploaded('intro_card_url', url)}
          isVideo
        />

        {/* ── Outro card ── */}
        <AssetUploader
          label="Outro card"
          hint="MP4 clip appended to the end of every assembled video. Keep it under 10 seconds. 16:9, 1920×1080 recommended."
          accept="video/mp4,video/quicktime"
          assetType="outro_card"
          currentUrl={brand.outro_card_url}
          brandId={brand.id}
          token={token}
          onUploaded={(url) => handleAssetUploaded('outro_card_url', url)}
          isVideo
        />

        {/* ── Info strip ── */}
        <div className="rounded-lg bg-muted/50 border border-border px-4 py-3 flex gap-3">
          <svg className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
          <p className="af-caption text-muted-foreground">
            Assets are stored in R2 and applied to new jobs. Existing completed jobs are not retroactively updated.
            Intro and outro cards are applied during the assembly stage of each job.
          </p>
        </div>

      </div>
    </PageShell>
  );
}
