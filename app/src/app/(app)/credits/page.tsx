'use client';
/**
 * /credits — Credit balance, usage history, and pack purchase (CPD-99)
 * CPD-364: fix dead /checkout link + $undefined price
 * CPD-366: add overage cost warning UI
 * CPD-367: show PAUSED state when credits exhausted
 * CPD-368: amber banner at 25% remaining
 * CPD-369: auto top-up toggle
 */

import { useEffect, useState, useTransition, Suspense } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { useSearchParams, useRouter } from 'next/navigation';
import { useBrand } from '@/contexts/brand-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getCreditBalance,
  getCreditHistory,
  getCreditPacks,
  purchasePack,
  getAutoTopup,
  setAutoTopup,
  type CreditBalance,
  type CreditLedgerEntry,
  type CreditPack,
  type AutoTopupSettings,
} from '@/lib/api';
import { creditTypeLabel, formatUserError } from '@/lib/job-labels';
import { tierLabel } from '@/lib/tier-labels';
import { cn } from '@/lib/utils';

// ─── Progress bar ──────────────────────────────────────────────────────────────

function UsageBar({ used, total, warn, critical }: { used: number; total: number; warn?: boolean; critical?: boolean }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
      <div
        className={cn(
          'h-full rounded-full transition-all',
          critical ? 'bg-destructive' : warn ? 'bg-yellow-500' : 'bg-primary'
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Ledger entry row ──────────────────────────────────────────────────────────

function LedgerRow({ entry }: { entry: CreditLedgerEntry }) {
  const isDebit = entry.type !== 'refund';
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <Badge
        variant={entry.type === 'overage' ? 'destructive' : entry.type === 'refund' ? 'default' : 'outline'}
        className="af-caption shrink-0"
      >
        {creditTypeLabel(entry.type)}
      </Badge>
      <span className="af-caption flex-1 truncate">
        {entry.description || (entry.job_id ? 'Job usage' : '—')}
      </span>
      <span className={cn('af-caption tabular-nums shrink-0', isDebit ? 'text-destructive' : 'text-success')}>
        {isDebit ? '-' : '+'}{Math.abs(Number(entry.credits) || 0)}
      </span>
      <span className="af-caption shrink-0">
        {new Date(entry.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </div>
  );
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function CreditsSkeleton() {
  return (
    <PageShell maxWidth="3xl">
      <PageHeader title="Credits" subtitle="Your balance, usage history, and top-up options." />
      <div className="space-y-4 animate-pulse">
        <div className="h-32 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-48 rounded-lg bg-muted" />
      </div>
    </PageShell>
  );
}

// ─── C3: reusable dismissible banner for credits page ──────────────────────────

function DismissiblePackBanner({
  variant, children,
}: {
  variant: 'success' | 'muted';
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const cls = variant === 'success'
    ? 'border-success/40 bg-success/10 text-success'
    : 'border-border bg-muted text-muted-foreground';
  return (
    <div className={`rounded-lg border px-4 py-3 flex items-start justify-between gap-3 ${cls}`}>
      <p className="text-sm">{children}</p>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity text-sm leading-none mt-0.5"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

function CreditsPageInner() {
  const { getToken, isLoaded } = useAuth();
  const { activeBrand }        = useBrand();
  const activeBrandId          = activeBrand?.id;
  const searchParams   = useSearchParams();
  const router         = useRouter();
  const packSuccess    = searchParams.get('pack_success')   === '1';
  const packCancelled  = searchParams.get('pack_cancelled') === '1'; // U7
  const [balance, setBalance]         = useState<CreditBalance | null>(null);
  const [history, setHistory]         = useState<CreditLedgerEntry[]>([]);
  const [packs, setPacks]             = useState<CreditPack[]>([]);
  const [autoTopup, setAutoTopupState] = useState<AutoTopupSettings | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [isPending, start]            = useTransition();
  const [packError, setPackError]     = useState<string | null>(null);
  const [topupMsg, setTopupMsg]       = useState<string | null>(null);

  // U6: clear transient query params so banners don't reappear on refresh
  useEffect(() => {
    if (packSuccess || packCancelled) {
      router.replace('/credits');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const [bal, hist, pks, atSettings] = await Promise.all([
          getCreditBalance(token ?? undefined),
          getCreditHistory(20, 0, token ?? undefined).catch(() => ({ ok: false, entries: [], total: 0 })),
          getCreditPacks(token ?? undefined).catch(() => ({ ok: false, packs: [] })),
          getAutoTopup(token ?? undefined).catch(() => null),
        ]);
        setBalance(bal);
        setHistory(hist.entries ?? []);
        setPacks(pks.packs ?? []);
        setAutoTopupState(atSettings);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load credits');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isLoaded, activeBrandId]);

  async function handleBuyPack(packId: string) {
    setPackError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        const res = await purchasePack(
          packId,
          `${origin}/credits?pack_success=1`,
          `${origin}/credits?pack_cancelled=1`,
          token ?? undefined,
        );
        window.location.href = res.checkoutUrl;
      } catch {
        setPackError("Couldn't start checkout. Please try again.");
      }
    });
  }

  async function handleAutoTopupToggle(enabled: boolean) {
    setTopupMsg(null);
    start(async () => {
      try {
        const token = await getToken();
        await setAutoTopup(enabled, token ?? undefined);
        setAutoTopupState((prev) => prev ? { ...prev, enabled } : prev);
        setTopupMsg(enabled
          ? 'Auto top-up enabled — your card will be charged when credits run out.'
          : 'Auto top-up disabled.');
      } catch {
        setTopupMsg('Could not update auto top-up. Try again.');
      }
    });
  }

  if (loading) return <CreditsSkeleton />;
  if (error)   return (
    <PageShell maxWidth="3xl">
      <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>
    </PageShell>
  );
  if (!balance) return (
    <PageShell maxWidth="3xl">
      <p className="text-sm text-muted-foreground">No active plan found.</p>
    </PageShell>
  );

  const totalUsed      = balance.included_total - balance.included_remaining;
  const usagePct       = balance.included_total > 0 ? (totalUsed / balance.included_total) * 100 : 0;
  const remainingPct   = 100 - usagePct;
  const isExhausted    = balance.included_remaining <= 0 && balance.pack_remaining <= 0;
  const isCritical     = balance.included_remaining <= 0;
  const isLow          = remainingPct <= 25 && !isCritical;
  const isWarning      = usagePct >= 50;

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Credits & Usage"
        subtitle={<span>Plan: <span className="text-foreground font-medium">{tierLabel(balance.tier)}</span> · Period: {new Date(balance.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – {new Date(balance.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
      />

      {/* C3+C4: dismissible pack banners in consistent bordered card style */}
      {packSuccess && <DismissiblePackBanner variant="success">
        <span className="font-semibold">Credits purchased!</span>{' '}
        Your credit balance will update shortly as the payment is confirmed.
      </DismissiblePackBanner>}
      {packCancelled && <DismissiblePackBanner variant="muted">
        Pack checkout cancelled — no charge was made.
      </DismissiblePackBanner>}

      {/* Jobs paused banner */}
      {isExhausted && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive px-4 py-3 flex items-center justify-between mb-4">
          <span className="text-sm font-medium">Your credits are exhausted — production is paused.</span>
          <a href="#buy-credits" className="text-sm font-semibold underline ml-4">Buy credits →</a>
        </div>
      )}

      {/* Low credit warning (≤ 25% remaining, not yet exhausted) */}
      {isLow && !isExhausted && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 space-y-1">
          <p className="text-sm font-medium text-yellow-400">
            Credits running low — {balance.included_remaining} of {balance.included_total} remaining
          </p>
          <p className="text-xs text-yellow-400/80">
            <a href="#buy-credits" className="underline font-medium">Buy a Credit Top-Up pack</a>{' '}
            or enable auto top-up so your jobs don&apos;t pause.
          </p>
        </div>
      )}

      {/* Usage summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="af-caption">Included remaining</CardTitle></CardHeader>
          <CardContent>
            <p className={cn('af-metric', isCritical ? 'text-destructive' : isLow ? 'text-yellow-400' : '')}>
              {balance.included_remaining}
            </p>
            <p className="af-caption">of {balance.included_total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="af-caption">Pack credits</CardTitle></CardHeader>
          <CardContent>
            <p className="af-metric">{balance.pack_remaining}</p>
            <p className="af-caption">purchased</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="af-caption">Status</CardTitle></CardHeader>
          <CardContent>
            <p className={cn('af-metric text-sm', isExhausted ? 'text-destructive' : 'text-success')}>
              {isExhausted ? 'Paused' : 'Active'}
            </p>
            <p className="af-caption">{isExhausted ? 'No credits left' : 'Jobs running'}</p>
          </CardContent>
        </Card>
      </div>

      {/* Usage progress */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="af-label">Monthly usage</CardTitle>
            {isWarning && (
              <Badge variant={isCritical ? 'destructive' : 'secondary'} className="af-caption">
                {usagePct >= 100 ? 'Exhausted' : `${Math.round(usagePct)}% used`}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <UsageBar used={totalUsed} total={balance.included_total} warn={isLow} critical={isCritical} />
          <p className="af-caption">
            {totalUsed} / {balance.included_total} credits used this period
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* Auto top-up toggle (CPD-369) */}
      {autoTopup !== null && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="af-label">Auto top-up</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="auto-topup-switch" className="af-body">
                  Automatically buy credits when balance hits zero
                </Label>
                <p className="af-caption text-muted-foreground">
                  Charges your saved card for a <strong>Credit Top-Up (50 credits)</strong> to keep jobs running.{' '}
                  <a href="/billing/payment" className="underline hover:text-foreground transition-colors">
                    Manage payment method
                  </a>
                </p>
              </div>
              <Switch
                id="auto-topup-switch"
                checked={autoTopup.enabled}
                disabled={isPending}
                onCheckedChange={handleAutoTopupToggle}
              />
            </div>
            {topupMsg && (
              <p className="text-xs text-muted-foreground">{topupMsg}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Credit top-up pack — always render the anchor so warning banner links don't break */}
      <div className="space-y-2" id="buy-credits">
        <h2 className="af-subhead">Buy credits</h2>
        {!packs.some((p) => p.id === 'credit_topup') ? (
          <p className="af-body text-muted-foreground">
            Credit top-up packs are not currently available.{' '}
            <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">Contact us</a>.
          </p>
        ) : (
          <>
          {packError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{packError}</p>
          )}
          {packs.filter((p) => p.id === 'credit_topup').map((pack) => (
            <Card key={pack.id} className={cn(
              'hover:border-border/80 transition-colors',
              isExhausted ? 'border-primary/40 ring-1 ring-primary/20' : '',
            )}>
              <CardContent className="pt-4 space-y-1">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="af-label font-semibold">{pack.label}</p>
                    <p className="af-caption text-muted-foreground">{pack.credits} credits / pack</p>
                    <p className="af-caption font-medium mt-1">
                      {pack.price_cents
                        ? formatCurrency(pack.price_cents)
                        : pack.price_usd != null ? `$${pack.price_usd}` : '—'}
                      <span className="text-muted-foreground"> / pack · choose qty at checkout</span>
                    </p>
                  </div>
                  <div className="pt-1">
                    <Button
                      size="sm"
                      variant={isExhausted ? 'default' : 'outline'}
                      disabled={isPending || pack.priceConfigured === false}
                      onClick={() => handleBuyPack(pack.id)}
                    >
                      {isPending ? 'Processing…' : 'Buy'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          </>
        )}
      </div>

      {/* History */}
      <div className="space-y-2">
        <h2 className="af-subhead">Usage history</h2>
        <Card>
          <CardContent className="pt-4 p-0 px-4">
            {history.length === 0 ? (
              <p className="af-body py-4">No usage recorded yet.</p>
            ) : (
              history.map((entry) => <LedgerRow key={entry.id} entry={entry} />)
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

// U4: useSearchParams requires a Suspense boundary in Next.js 13+ app router
export default function CreditsPage() {
  return (
    <Suspense fallback={<CreditsSkeleton />}>
      <CreditsPageInner />
    </Suspense>
  );
}
