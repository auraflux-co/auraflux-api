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
  type CreditBalance,
  type Plan,
  type CreditPack,
  type CreditLedgerEntry,
} from '@/lib/api';

const PLAN_HIGHLIGHTS: Record<string, string[]> = {
  diy: [
    'Full AuraFlux platform access',
    'Script generation, TTS, WAN video',
    'VectCut composition + Gemini ranking',
    'Direct YouTube publishing',
    'Self-managed — no operator support',
  ],
  dwy: [
    'Everything in DIY',
    'Operator monitors your queue daily',
    'Operator guidance + queue management',
    'Priority Slack alert channel',
  ],
  dfy: [
    'Everything in DWY',
    'Operator runs production end-to-end',
    'HeyGen AI avatar presenter',
    'Imagen 3 AI-generated thumbnails',
    'Direct TikTok + Instagram publishing',
  ],
};

const PLAN_PRICES: Record<string, string> = {
  diy: '$1,500',
  dwy: '$2,000',
  dfy: '$3,000',
};

function typeLabel(type: string) {
  if (type === 'job')  return 'Job';
  if (type === 'pack') return 'Pack purchase';
  if (type === 'refund') return 'Refund';
  return type;
}

export default function BillingPage() {
  const { getToken, isLoaded } = useAuth();
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

  const currentTier = balance?.tier ?? 'diy';

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Manage your plan, credits, and payment</p>
      </div>

      {error && (
        <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {/* Current plan summary */}
      {balance && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">Current plan</CardTitle>
              <Badge className="capitalize">{currentTier.toUpperCase()}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold">{PLAN_PRICES[currentTier] ?? '—'}</span>
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
                    <CardTitle className="text-sm uppercase tracking-wide">{tier}</CardTitle>
                    {isCurrent && <Badge variant="secondary" className="text-[10px]">Current</Badge>}
                  </div>
                  <div className="flex items-end gap-1 mt-1">
                    <span className="text-2xl font-bold">{PLAN_PRICES[tier]}</span>
                    <span className="text-xs text-muted-foreground mb-0.5">/mo</span>
                  </div>
                  <CardDescription className="text-xs mt-1">
                    {plan?.credits?.toLocaleString() ?? '—'} credits/month
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col gap-3">
                  <ul className="space-y-1.5 flex-1">
                    {(PLAN_HIGHLIGHTS[tier] ?? []).map((h) => (
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
                    {isCurrent ? 'Current plan' : `Upgrade to ${tier.toUpperCase()}`}
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

      {/* Credit pack add-ons — wired, not launch */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Credit Packs</h2>
          <Badge variant="outline" className="text-[10px]">Coming soon</Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {packs.length > 0 ? packs.map((pack) => (
            <Card key={pack.id} className="opacity-60">
              <CardContent className="pt-4 space-y-2">
                <p className="text-sm font-medium">{pack.label}</p>
                <p className="text-xs text-muted-foreground">{pack.credits.toLocaleString()} credits</p>
                <p className="text-lg font-bold">${pack.price_usd}</p>
                <Button size="sm" variant="outline" className="w-full" disabled>
                  Buy pack
                </Button>
              </CardContent>
            </Card>
          )) : (
            <p className="col-span-3 text-sm text-muted-foreground">Credit packs will be available at launch.</p>
          )}
        </div>
      </div>
    </div>
  );
}
