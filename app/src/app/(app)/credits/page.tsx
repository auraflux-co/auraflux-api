'use client';
/**
 * /credits — Credit balance, usage history, and pack purchase (CPD-99)
 * CPD-364: fix dead /checkout link + $undefined price
 * CPD-366: add overage cost warning UI
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getCreditBalance,
  getCreditHistory,
  getCreditPacks,
  purchasePack,
  type CreditBalance,
  type CreditLedgerEntry,
  type CreditPack,
} from '@/lib/api';
import { creditTypeLabel, formatUserError } from '@/lib/job-labels';
import { tierLabel } from '@/lib/tier-labels';
import { cn } from '@/lib/utils';

// ─── Progress bar ──────────────────────────────────────────────────────────────

function UsageBar({ used, total, warn }: { used: number; total: number; warn?: boolean }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  return (
    <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all', warn ? 'bg-yellow-500' : 'bg-primary')}
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

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CreditsPage() {
  const { getToken, isLoaded } = useAuth();
  const [balance, setBalance]   = useState<CreditBalance | null>(null);
  const [history, setHistory]   = useState<CreditLedgerEntry[]>([]);
  const [packs, setPacks]       = useState<CreditPack[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [isPending, start]      = useTransition();
  const [packError, setPackError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const [bal, hist, pks] = await Promise.all([
          getCreditBalance(token ?? undefined),
          getCreditHistory(20, 0, token ?? undefined).catch(() => ({ ok: false, entries: [], total: 0 })),
          getCreditPacks(token ?? undefined).catch(() => ({ ok: false, packs: [] })),
        ]);
        setBalance(bal);
        setHistory(hist.entries ?? []);
        setPacks(pks.packs ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load credits');
      } finally {
        setLoading(false);
      }
    })();
  }, [getToken, isLoaded]);

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

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (error)   return <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{formatUserError(error)}</p>;
  if (!balance) return <p className="text-sm text-muted-foreground">No active plan found.</p>;

  const totalUsed = balance.included_total - balance.included_remaining;
  const usagePct  = balance.included_total > 0 ? (totalUsed / balance.included_total) * 100 : 0;
  const isWarning = usagePct >= 75;
  const overageUsed = balance.overage_used ?? 0;
  const overagePriceCents = balance.overage_price_cents ?? 0;
  const overageCost = overageUsed * overagePriceCents;

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Credits & Usage"
        subtitle={<span>Plan: <span className="text-foreground font-medium">{tierLabel(balance.tier)}</span> · Period: {new Date(balance.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – {new Date(balance.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
      />

      {/* Overage warning */}
      {overageUsed > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 space-y-1">
          <p className="text-sm font-medium text-yellow-400">
            Overage usage this period: {overageUsed} credit{overageUsed !== 1 ? 's' : ''}
          </p>
          <p className="text-xs text-yellow-400/80">
            Estimated extra charge: <span className="font-semibold">{formatCurrency(overageCost)}</span>
            {overagePriceCents > 0 && <> · Rate: {formatCurrency(overagePriceCents)} per credit</>}
          </p>
          <p className="text-xs text-muted-foreground">Overage is billed at the end of your billing period.</p>
        </div>
      )}

      {/* Usage summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="af-caption">Included remaining</CardTitle></CardHeader>
          <CardContent>
            <p className="af-metric">{balance.included_remaining}</p>
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
          <CardHeader className="pb-1"><CardTitle className="af-caption">Overage used</CardTitle></CardHeader>
          <CardContent>
            <p className={cn('af-metric', overageUsed > 0 ? 'text-yellow-400' : '')}>{overageUsed}</p>
            {overagePriceCents > 0 && overageUsed > 0 ? (
              <p className="af-caption text-yellow-400/70">{formatCurrency(overageCost)} est.</p>
            ) : (
              balance.overage_cap != null && <p className="af-caption">cap: {balance.overage_cap}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Usage progress */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="af-label">Monthly usage</CardTitle>
            {isWarning && (
              <Badge variant="secondary" className="af-caption">
                {usagePct >= 100 ? 'Limit reached' : `${Math.round(usagePct)}% used`}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <UsageBar used={totalUsed} total={balance.included_total} warn={isWarning} />
          <p className="af-caption">
            {totalUsed} / {balance.included_total} credits used this period
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* Credit packs */}
      {packs.length > 0 && (
        <div className="space-y-2">
          <h2 className="af-subhead">Buy credits</h2>
          {packError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{packError}</p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {packs.map((pack) => (
              <Card key={pack.id} className="hover:border-border/80 transition-colors">
                <CardContent className="pt-4 space-y-1">
                  <p className="af-label font-semibold">{pack.label}</p>
                  <p className="af-caption">{pack.credits} credits</p>
                  <p className="af-caption font-medium">
                    {pack.price_cents
                      ? formatCurrency(pack.price_cents)
                      : pack.price_usd != null ? `$${pack.price_usd}` : '—'}
                  </p>
                  {pack.priceConfigured !== false ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full mt-2 text-xs"
                      disabled={isPending}
                      onClick={() => handleBuyPack(pack.id)}
                    >
                      Buy
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-2">Contact us</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

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
