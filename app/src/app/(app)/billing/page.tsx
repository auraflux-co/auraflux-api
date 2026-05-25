'use client';
/**
 * /billing — Subscription management (CPD-111).
 *
 * Sections:
 *  1. Current plan summary + credit bar
 *  2. Upgrade options  (only plans above current tier — downgrade via contact)
 *  3. Credit top-up packs  (auto-shown when ≥1 pack has priceConfigured: true)
 *
 * Usage history: lives on /credits page.
 * Payment method & invoices: /billing/payment page.
 */

import { useEffect, useState, useTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { tierLabel } from '@/lib/tier-labels';
import { formatUserError } from '@/lib/job-labels';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getCreditBalance,
  getPlans,
  getCreditPacks,
  subscribeToPlan,
  purchasePack,
  type CreditBalance,
  type Plan,
  type CreditPack,
} from '@/lib/api';

/** Tier ordering — lower index = lower tier */
const TIER_ORDER = ['operate', 'guided', 'managed'];

const PLAN_META: Record<string, { label: string; sub: string; price: string; highlights: string[] }> = {
  operate: {
    label:  'AuraFlux Operate',
    sub:    'API access — developer plan',
    price:  '$999',
    highlights: [
      '400 credits / month',
      'Full API access',
      'Self-serve knowledge base',
    ],
  },
  guided: {
    label:  'AuraFlux Guided',
    sub:    'Done-with-you — full platform',
    price:  '$2,499',
    highlights: [
      '1,200 credits / month',
      'Full platform — script, AI video, thumbnails, publish',
      'Guided setup & monitoring',
      'Chat support escalation',
    ],
  },
  managed: {
    label:  'AuraFlux Managed',
    sub:    'Full done-for-you content operation',
    price:  '$4,499',
    highlights: [
      '2,000 credits / month',
      'AI avatars (HeyGen)',
      'Dedicated account manager',
      'Priority support',
      'Operator runs everything',
    ],
  },
};

function BillingPageInner() {
  const { getToken, isLoaded } = useAuth();
  const searchParams = useSearchParams();
  const stripeSuccess  = searchParams.get('success') === '1';
  const stripeCancelled = searchParams.get('cancelled') === '1';
  const [isPending, start] = useTransition();

  const [balance, setBalance]     = useState<CreditBalance | null>(null);
  const [plans, setPlans]         = useState<Plan[]>([]);
  const [packs, setPacks]         = useState<CreditPack[]>([]);
  const [error, setError]         = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const [b, p, pk] = await Promise.all([
          getCreditBalance(token ?? undefined),
          getPlans(token ?? undefined),
          getCreditPacks(token ?? undefined),
        ]);
        setBalance(b);
        setPlans(p.plans ?? []);
        setPacks(pk.packs ?? []);
      } catch {
        setError("Couldn't load billing info. Refresh to try again.");
      }
    })();
  }, [getToken, isLoaded]);

  async function handleUpgrade(planId: string) {
    setError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        const res = await subscribeToPlan(
          planId,
          `${origin}/billing?success=1`,
          `${origin}/billing?cancelled=1`,
          token ?? undefined,
        );
        window.location.href = res.url;
      } catch {
        setError("Couldn't start checkout. Please try again.");
      }
    });
  }

  async function handleBuyPack(packId: string) {
    setError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        const res = await purchasePack(
          packId,
          `${origin}/billing?pack_success=1`,
          `${origin}/billing?pack_cancelled=1`,
          token ?? undefined,
        );
        window.location.href = res.checkoutUrl;
      } catch {
        setError("Couldn't start pack checkout. Please try again.");
      }
    });
  }

  const currentTier  = balance?.tier ?? 'operate';
  const currentIdx   = TIER_ORDER.indexOf(currentTier);
  const upgradeTiers = TIER_ORDER.slice(currentIdx + 1) as ('operate' | 'guided' | 'managed')[];

  const creditUsed  = balance ? (balance.included_total - balance.included_remaining) : 0;
  const creditTotal = balance?.included_total ?? 0;
  const usagePct    = creditTotal > 0 ? Math.min((creditUsed / creditTotal) * 100, 100) : 0;

  return (
    <PageShell maxWidth="3xl">
      <PageHeader title="Subscription" subtitle="Your plan, upgrade options, and payment." />

      {stripeSuccess && (
        <p className="af-body text-success bg-success/10 rounded px-3 py-2">Payment successful — your credits will appear shortly.</p>
      )}
      {stripeCancelled && (
        <p className="af-body text-muted-foreground bg-muted rounded px-3 py-2">Checkout cancelled — no charge was made.</p>
      )}
      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
      )}

      {/* ── 1. Current plan summary ─────────────────────────────────────────── */}
      {balance && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="af-h3">Current plan</CardTitle>
              <Badge>{PLAN_META[currentTier]?.label ?? tierLabel(currentTier)}</Badge>
            </div>
            {PLAN_META[currentTier]?.sub && (
              <p className="af-label mt-0.5 text-muted-foreground">{PLAN_META[currentTier].sub}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-2">
              <span className="af-metric">{PLAN_META[currentTier]?.price ?? '—'}</span>
              <span className="af-label mb-1 text-muted-foreground">/month</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between af-body">
                <span className="text-muted-foreground">Credits used this period</span>
                <span className="font-medium tabular-nums">
                  {creditUsed.toLocaleString()} / {creditTotal.toLocaleString()}
                </span>
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${usagePct}%` }}
                />
              </div>
              {balance.pack_remaining > 0 && (
                <p className="af-caption">{balance.pack_remaining.toLocaleString()} pack credits also available</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 2. Upgrade options ──────────────────────────────────────────────── */}
      {upgradeTiers.length > 0 && (
        <div>
          <h2 className="af-subhead mb-4">Plans — monthly subscription</h2>
          <div className={cn('grid grid-cols-1 gap-4', upgradeTiers.length > 1 && 'sm:grid-cols-2')}>
            {upgradeTiers.map((tier) => {
              const plan = plans.find((p) => p.id === tier);
              const meta = PLAN_META[tier];
              const canCheckout = !!plan?.priceConfigured;
              return (
                <Card key={tier} className="flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-semibold">{meta.label}</CardTitle>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{meta.sub}</p>
                    <div className="flex items-end gap-1 mt-2">
                      <span className="af-metric">{meta.price}</span>
                      <span className="af-caption mb-1">/mo</span>
                    </div>
                    <CardDescription className="af-label mt-1">
                      {plan?.credits?.toLocaleString() ?? '—'} credits/month · no rollover
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col gap-3">
                    <ul className="space-y-1.5 flex-1">
                      {meta.highlights.map((h) => (
                        <li key={h} className="af-label flex gap-1.5">
                          <span className="text-primary mt-0.5">✓</span>
                          {h}
                        </li>
                      ))}
                    </ul>
                    {canCheckout ? (
                      <Button
                        size="sm"
                        className="w-full mt-2"
                        disabled={isPending}
                        onClick={() => handleUpgrade(tier)}
                      >
                        Upgrade to {meta.label}
                      </Button>
                    ) : (
                      <a
                        href="/support"
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full mt-2 text-center')}
                      >
                        Contact us to upgrade
                      </a>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="af-caption mt-3 text-muted-foreground">
            Monthly subscriptions. To change or cancel your plan, <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">contact us</a>.
          </p>
        </div>
      )}

      {currentTier === 'managed' && (
        <p className="af-body text-muted-foreground">
          You&apos;re on our highest plan. To discuss custom or enterprise terms, <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">contact us</a>.
        </p>
      )}

      {/* ── 3. Credit top-up packs (auto-shown when ≥1 pack has a Stripe price) */}
      {packs.some((p) => p.priceConfigured) && (
        <div>
          <h2 className="af-subhead mb-1">Credit top-up packs</h2>
          <p className="af-label mb-4 text-muted-foreground">
            Add credits for specific features beyond your plan allowance.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {packs.filter((p) => p.priceConfigured).map((pack) => (
              <Card key={pack.id}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="af-body font-semibold">{pack.label}</p>
                      <p className="af-label text-muted-foreground">{pack.description}</p>
                    </div>
                    <Badge variant="secondary" className="af-caption shrink-0">
                      {pack.credits} cr
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    disabled={isPending}
                    onClick={() => handleBuyPack(pack.id)}
                  >
                    Buy — ${((pack.price_cents ?? 0) / 100).toFixed(0)}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Payment method lives at /billing/payment */}
      <p className="af-caption text-muted-foreground">
        To update your card or download invoices, visit{' '}
        <a href="/billing/payment" className="underline underline-offset-2 hover:text-foreground transition-colors">
          Payment method &amp; invoices
        </a>.
      </p>
    </PageShell>
  );
}

export default function BillingPage() {
  return (
    <Suspense>
      <BillingPageInner />
    </Suspense>
  );
}
