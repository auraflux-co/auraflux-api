'use client';
/**
 * /billing/add-brand — Add a new brand to the account (CPD-333)
 *
 * Step 1: Enter brand name
 * Step 2: Choose plan (Operate / Guided / Managed)
 * Step 3: Confirm → Stripe Checkout
 */

import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createBrandApi, subscribeToPlan } from '@/lib/api';
import { useBrand } from '@/contexts/brand-context';

const PLAN_META: Record<string, { label: string; sub: string; price: string; image: string }> = {
  operate: {
    label: 'AuraFlux Operate',
    sub:   'API access — developer plan',
    price: '$999/mo',
    image: '/brand/plans/operate.png',
  },
  guided: {
    label: 'AuraFlux Guided',
    sub:   'Done-with-you plan',
    price: '$1,999/mo',
    image: '/brand/plans/guided.png',
  },
  managed: {
    label: 'AuraFlux Managed',
    sub:   'Full done-for-you',
    price: '$4,999/mo',
    image: '/brand/plans/managed.png',
  },
};

const PLANS = ['operate', 'guided', 'managed'] as const;
type PlanId = typeof PLANS[number];

export default function AddBrandPage() {
  const { getToken }         = useAuth();
  const router               = useRouter();
  const { refresh }          = useBrand();

  const [step, setStep]       = useState<1 | 2>(1);
  const [name, setName]       = useState('');
  const [planId, setPlanId]   = useState<PlanId>('guided');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  async function handleSubscribe() {
    if (!name.trim()) { setError('Please enter a brand name.'); return; }
    setLoading(true);
    setError(null);
    try {
      const token  = await getToken();
      // 1. Create brand record
      const brand  = await createBrandApi(name.trim(), token ?? undefined);
      // 2. Start Stripe checkout for this brand
      const origin = window.location.origin;
      const result = await subscribeToPlan(
        planId,
        `${origin}/billing/add-brand/success?brand_id=${brand.id}`,
        `${origin}/billing/add-brand?cancelled=1`,
        token ?? undefined,
        brand.id,
      );
      // Refresh brand list in context (new brand exists, no subscription yet)
      await refresh();
      // Navigate to Stripe checkout
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
            </CardHeader>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3 max-w-3xl">
            {PLANS.map((p) => {
              const meta = PLAN_META[p];
              const selected = planId === p;
              return (
                <button
                  key={p}
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

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep(1)} size="sm">Back</Button>
            <Button onClick={handleSubscribe} disabled={loading} size="sm">
              {loading ? 'Setting up…' : `Subscribe — ${PLAN_META[planId].label}`}
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}
