'use client';
/**
 * /dashboard/billing — Billing & subscription management (CPD-111).
 *
 * Sections:
 *  - Current plan + upgrade cards
 *  - Credit pack add-ons (wired, not launch)
 *  - Payment method (via Stripe subscribe flow)
 */

import { useEffect, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  getCreditBalance,
  getPlans,
  getCreditPacks,
  subscribeToPlan,
  getBillingPortalUrl,
  getCreditHistory,
  purchasePack,
  type CreditBalance,
  type Plan,
  type CreditPack,
  type CreditLedgerEntry,
} from '@/lib/api';

const PLAN_META: Record<string, { label: string; sub: string; price: string; highlights: string[] }> = {
  diy: {
    label:  'AuraFlux Operate',
    sub:    'Run your content system',
    price:  '$999',
    highlights: [
      '400 credits / month (no rollover)',
      '1 brand',
      'Full platform — script, TTS, WAN T2V, thumbnails, publish',
      'AuraFlux Copilot — guide confirmation mode',
      'Confluence self-serve guides',
    ],
  },
  dwy: {
    label:  'AuraFlux Guided',
    sub:    'Build and optimize with us',
    price:  '$2,499',
    highlights: [
      '1,200 credits / month (no rollover)',
      'Up to 3 brands',
      'Everything in Operate',
      'Full AuraFlux Copilot — guidance, estimates, all features',
      'SMS + chat support escalation',
    ],
  },
  dfy: {
    label:  'AuraFlux Managed',
    sub:    'Full content operation, handled for you',
    price:  '$4,499',
    highlights: [
      '2,000 credits / month (no rollover)',
      'Up to 5 brands',
      'Everything in Guided',
      'Dedicated account manager',
      'Full Copilot + priority support',
    ],
  },
};

function typeLabel(type: string) {
  if (type === 'job')  return 'Job';
  if (type === 'pack') return 'Pack purchase';
  if (type === 'refund') return 'Refund';
  return type;
}

export default function BillingPage() {
  const { getToken, isLoaded } = useAuth();
  const searchParams = useSearchParams();
  const stripeSuccess = searchParams.get('success') === '1' || searchParams.get('pack_success') === '1';
  const stripeCancelled = searchParams.get('cancelled') === '1' || searchParams.get('pack_cancelled') === '1';
  const [isPending, start] = useTransition();

  const [balance, setBalance]     = useState<CreditBalance | null>(null);
  const [plans, setPlans]         = useState<Plan[]>([]);
  const [packs, setPacks]         = useState<CreditPack[]>([]);
  const [history, setHistory]     = useState<CreditLedgerEntry[]>([]);
  const [histTotal, setHistTotal] = useState(0);
  const [error, setError]         = useState<string | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    async function load() {
      try {
        const token = await getToken();
        const [b, p, pk, h] = await Promise.all([
          getCreditBalance(token ?? undefined),
          getPlans(token ?? undefined),
          getCreditPacks(token ?? undefined),
          getCreditHistory(50, 0, token ?? undefined),
        ]);
        setBalance(b);
        setPlans(p.plans ?? []);
        setPacks(pk.packs ?? []);
        setHistory(h.entries ?? []);
        setHistTotal(h.total ?? 0);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load billing info');
      }
    }
    load();
  }, [getToken, isLoaded]);

  async function handleManagePayment() {
    setPortalError(null);
    start(async () => {
      try {
        const token = await getToken();
        const returnUrl = `${window.location.origin}/dashboard/billing`;
        const res = await getBillingPortalUrl(returnUrl, token ?? undefined);
        window.location.href = res.url;
      } catch (e: unknown) {
        setPortalError(e instanceof Error ? e.message : 'Failed to open billing portal');
      }
    });
  }

  async function handleUpgrade(planId: string) {
    setError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        const res = await subscribeToPlan(
          planId,
          `${origin}/dashboard/billing?success=1`,
          `${origin}/dashboard/billing?cancelled=1`,
          token ?? undefined,
        );
        window.location.href = res.url;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to start checkout');
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
          `${origin}/dashboard/billing?pack_success=1`,
          `${origin}/dashboard/billing?pack_cancelled=1`,
          token ?? undefined,
        );
        window.location.href = res.checkoutUrl;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to start pack checkout');
      }
    });
  }

  const currentTier = balance?.tier ?? 'diy';

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your plan, credits, and payment</p>
      </div>

      {stripeSuccess && (
        <p className="text-sm text-emerald-600 bg-emerald-500/10 rounded px-3 py-2">Payment successful — your credits will appear shortly.</p>
      )}
      {stripeCancelled && (
        <p className="text-sm text-muted-foreground bg-muted rounded px-3 py-2">Checkout cancelled — no charge was made.</p>
      )}
      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

          {/* Current plan summary */}
      {balance && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Current plan</CardTitle>
              <Badge className="capitalize">{PLAN_META[currentTier]?.label ?? currentTier.toUpperCase()}</Badge>
            </div>
            {PLAN_META[currentTier]?.sub && (
              <p className="text-xs text-muted-foreground mt-0.5">{PLAN_META[currentTier].sub}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">{PLAN_META[currentTier]?.price ?? '—'}</span>
              <span className="text-sm text-muted-foreground mb-1">/month</span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Credits used</span>
                <span className="font-medium tabular-nums">
                  {(balance.included_total - balance.included_remaining).toLocaleString()} / {balance.included_total.toLocaleString()}
                </span>
              </div>
              <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(((balance.included_total - balance.included_remaining) / balance.included_total) * 100, 100)}%` }}
                />
              </div>
              {balance.pack_remaining > 0 && (
                <p className="text-xs text-muted-foreground">{balance.pack_remaining.toLocaleString()} pack credits also available</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Separator />

      {/* Plan cards */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">Plans — monthly retainer</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(['diy', 'dwy', 'dfy'] as const).map((tier) => {
            const isCurrent = tier === currentTier;
            const plan = plans.find((p) => p.id === tier);
            const meta = PLAN_META[tier];
            return (
              <Card
                key={tier}
                className={cn(
                  'relative flex flex-col',
                  isCurrent && 'border-primary',
                  tier === 'dwy' && 'ring-1 ring-primary/30',
                )}
              >
                {tier === 'dwy' && (
                  <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                    <Badge className="text-[10px] px-2">Most popular</Badge>
                  </div>
                )}
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold">{meta.label}</CardTitle>
                    {isCurrent && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{meta.sub}</p>
                  <div className="flex items-end gap-1 mt-2">
                    <span className="text-2xl font-bold">{meta.price}</span>
                    <span className="text-xs text-muted-foreground mb-0.5">/mo</span>
                  </div>
                  <CardDescription className="text-xs mt-1">
                    {plan?.credits?.toLocaleString() ?? '—'} credits/month · no rollover
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col gap-3">
                  <ul className="space-y-1.5 flex-1">
                    {meta.highlights.map((h) => (
                      <li key={h} className="text-xs text-muted-foreground flex gap-1.5">
                        <span className="text-primary mt-0.5">✓</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                  <Button
                    size="sm"
                    variant={isCurrent ? 'outline' : 'default'}
                    disabled={isCurrent || isPending || !plan?.priceConfigured}
                    className="w-full mt-2"
                    onClick={() => !isCurrent && handleUpgrade(tier)}
                  >
                    {isCurrent ? 'Current plan' : `Upgrade to ${meta.label}`}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          All plans are monthly retainers. Contact us to discuss annual pricing or custom enterprise terms.
        </p>
      </div>

      <Separator />

      {/* Payment method */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">Payment method</h2>
        <Card>
          <CardContent className="pt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Manage your payment method and invoices</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Opens the Stripe Customer Portal — update your card, download invoices, or cancel your subscription.
              </p>
              {portalError && (
                <p className="text-xs text-destructive mt-1">{portalError}</p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={isPending}
              onClick={handleManagePayment}
            >
              Manage payment
            </Button>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* Usage history */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Usage history</h2>
          {histTotal > 0 && (
            <span className="text-xs text-muted-foreground">{histTotal} entries</span>
          )}
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credit usage yet.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Type</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Job</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Credits</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.map((entry) => (
                  <tr key={entry.id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(entry.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{typeLabel(entry.type)}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground hidden sm:table-cell font-mono truncate max-w-[140px]">
                      {entry.job_id ? (
                        <a href={`/dashboard/jobs/${entry.job_id}`} className="hover:text-foreground transition-colors">
                          {entry.job_id.slice(0, 8)}…
                        </a>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-right font-medium tabular-nums">
                      {entry.credits > 0 ? (
                        <span className="text-foreground">−{entry.credits}</span>
                      ) : (
                        <span className="text-emerald-500">+{Math.abs(entry.credits)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Separator />

      {/* Credit top-up packs */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Credit Top-Up Packs</h2>

        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Add capacity for specific AI features beyond your plan credits. AuraFlux Copilot will prompt you when you need more.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { id: 'narration',     label: 'Clip Narration Pack',   feature: 'TTS narration',         rate: '1 cr/min',  price: '$20', credits: 10,   mins: 10 },
            { id: 'text_to_video', label: 'Text to Video Pack',    feature: 'WAN T2V generation',    rate: '6 cr/min',  price: '$120', credits: 60,  mins: 10 },
            { id: 'avatar',        label: 'Avatar Pack',           feature: 'HeyGen Avatar IV',      rate: '120 cr/min', price: '$450', credits: 1200, mins: 10 },
            { id: 'shoppable',     label: 'Shoppable Pack',        feature: 'FFmpeg CTA + platform tagging', rate: '2 cr/min', price: '$40', credits: 20,  mins: 10 },
          ].map((pack) => (
            <Card key={pack.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold">{pack.label}</p>
                    <p className="text-xs text-muted-foreground">{pack.feature}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{pack.rate}</Badge>
                </div>
                <div className="flex items-end gap-1.5">
                  <span className="text-xl font-bold">{pack.price}</span>
                  <span className="text-xs text-muted-foreground mb-0.5">{pack.credits.toLocaleString()} cr · {pack.mins} min</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={isPending}
                  onClick={() => handleBuyPack(pack.id)}
                >
                  Buy pack
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
