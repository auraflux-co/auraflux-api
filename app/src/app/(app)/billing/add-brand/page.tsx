'use client';
/**
 * /billing/add-brand — Add a new brand to the account (CPD-333)
 *
 * Step 1: Enter brand name
 * Step 2: Choose plan (Creator / Studio) + optional Managed add-on
 * Step 3: Confirm → Stripe Checkout (Managed add-on → contact)
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createBrandApi, subscribeToPlan, type Brand } from '@/lib/api';
import { useBrand } from '@/contexts/brand-context';
import Link from 'next/link';

const PLAN_META: Record<string, { label: string; sub: string; price: string; image: string }> = {
  growth: {
    label: 'Creator',
    sub:   'Solo streamers shipping daily content',
    price: '$299/mo',
    image: '/brand/plans/operate.png',
  },
  operate: {
    label: 'Studio',
    sub:   'High volume & teams — full platform seat',
    price: '$999/mo',
    image: '/brand/plans/operate.png',
  },
};

const PLANS = ['growth', 'operate'] as const;
type PlanId = typeof PLANS[number];

function AddBrandInner() {
  const { getToken }           = useAuth();
  const router                 = useRouter();
  const searchParams           = useSearchParams();
  const { brands, refresh }    = useBrand();

  const [step, setStep]         = useState<1 | 2>(1);
  const [name, setName]         = useState('');
  const [planId, setPlanId]     = useState<PlanId>('operate');
  const [wantManaged, setWantManaged] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [draftBrand, setDraftBrand] = useState<Brand | null>(null);

  // Show cancelled banner when returning from Stripe without completing
  const wasCancelled = searchParams.get('cancelled') === '1';

  // Detect existing incomplete brand (has no subscription yet) to avoid duplication on retry
  useEffect(() => {
    const incomplete = brands.find((b) => !b.stripe_subscription_id && b.active);
    if (incomplete) setDraftBrand(incomplete);
  }, [brands]);

  async function handleSubscribe() {
    if (!name.trim()) { setError('Please enter a brand name.'); return; }
    // Managed is sales-led — send them to Support with context; they can subscribe to base plan first if needed
    if (wantManaged) {
      router.push(`/support?topic=managed&plan=${planId}&brand=${encodeURIComponent(name.trim())}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token  = await getToken();

      // Re-use existing draft brand if name matches (prevents duplication on retry)
      let brand = draftBrand?.name === name.trim() ? draftBrand : null;
      if (!brand) {
        brand = await createBrandApi(name.trim(), token ?? undefined);
        await refresh();
      }

      const origin = window.location.origin;
      const result = await subscribeToPlan(
        planId,
        `${origin}/billing/add-brand/success?brand_id=${brand.id}`,
        `${origin}/billing/add-brand?cancelled=1`,
        token ?? undefined,
        brand.id,
      );
      window.location.href = result.url;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setLoading(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Add a brand"
        subtitle="Each brand has its own plan subscription, channels, credits, and job history."
      />

      {/* Cancelled checkout banner */}
      {wasCancelled && (
        <div className="max-w-lg rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          Your checkout was cancelled. No charge was made. You can try again below.
          {draftBrand && (
            <span className="ml-1">Brand &ldquo;{draftBrand.name}&rdquo; was saved — pick a plan to complete setup.</span>
          )}
        </div>
      )}

      {/* Step 1: Name */}
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">
            <span className={cn('mr-2 inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border', step === 1 ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted text-muted-foreground border-border')}>1</span>
            Brand name
          </CardTitle>
          <CardDescription>What do you want to call this brand?</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gaming Channel, Main Brand"
            maxLength={80}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            onClick={() => { if (name.trim()) setStep(2); }}
            disabled={!name.trim()}
            size="sm"
          >
            Continue
          </Button>
        </CardContent>
      </Card>

      {/* Step 2: Plan */}
      {step === 2 && (
        <div className="space-y-4">
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle className="text-base">
                <span className="mr-2 inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold border bg-primary text-primary-foreground border-primary">2</span>
                Choose a plan for <em className="not-italic font-semibold">{name}</em>
              </CardTitle>
              <CardDescription>Two plans: Creator or Studio. Optionally add Managed (done-for-you) next.</CardDescription>
            </CardHeader>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
            {PLANS.map((p) => {
              const meta = PLAN_META[p];
              const selected = planId === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlanId(p)}
                  className={cn(
                    'text-left rounded-lg border overflow-hidden transition-all',
                    selected ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-muted-foreground/40',
                  )}
                >
                  {meta.image && (
                    <div className="w-full aspect-[4/3] overflow-hidden bg-muted">
                      <img src={meta.image} alt={meta.label} className="w-full h-full object-cover object-top" />
                    </div>
                  )}
                  <div className="p-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm">{meta.label}</span>
                      {selected && (
                        <span className="text-[10px] font-bold text-primary uppercase tracking-wide">Selected</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{meta.sub}</p>
                    <p className="text-sm font-medium">{meta.price}</p>
                  </div>
                </button>
              );
            })}
          </div>

          <label className={cn(
            'flex items-start gap-3 max-w-2xl rounded-lg border p-4 cursor-pointer transition-colors',
            wantManaged ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40',
          )}>
            <input
              type="checkbox"
              checked={wantManaged}
              onChange={(e) => setWantManaged(e.target.checked)}
              className="mt-1"
            />
            <span className="space-y-1">
              <span className="block font-semibold text-sm">Add Managed</span>
              <span className="block text-xs text-muted-foreground">
                Done-for-you production on {PLAN_META[planId].label}. We&apos;ll follow up to attach Managed — no self-serve checkout for the add-on yet.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-3 flex-wrap">
            <Button variant="outline" onClick={() => setStep(1)} size="sm">Back</Button>
            <Button onClick={handleSubscribe} disabled={loading} size="sm">
              {loading
                ? 'Setting up…'
                : wantManaged
                  ? `Contact us — ${PLAN_META[planId].label} + Managed`
                  : `Subscribe — ${PLAN_META[planId].label}`}
            </Button>
            {wantManaged && (
              <Link
                href="/billing"
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'text-muted-foreground')}
              >
                Or subscribe to {PLAN_META[planId].label} only first
              </Link>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}

export default function AddBrandPage() {
  return (
    <Suspense>
      <AddBrandInner />
    </Suspense>
  );
}
