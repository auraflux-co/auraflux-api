'use client';
/**
 * /credits — Credit balance, usage history, and pack purchase (CPD-99)
 */

import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getCreditBalance,
  getCreditHistory,
  getCreditPacks,
  type CreditBalance,
  type CreditLedgerEntry,
  type CreditPack,
} from '@/lib/api';

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
        className="af-caption capitalize shrink-0"
      >
        {entry.type}
      </Badge>
      <span className="af-caption flex-1 truncate">
        {entry.description || entry.job_id || '—'}
      </span>
      <span className={cn('af-caption font-mono shrink-0', isDebit ? 'text-destructive' : 'text-success')}>
        {isDebit ? '-' : '+'}{Math.abs(entry.credits)}
      </span>
      <span className="af-caption shrink-0">
        {new Date(entry.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function CreditsPage() {
  const { getToken } = useAuth();
  const [balance, setBalance]   = useState<CreditBalance | null>(null);
  const [history, setHistory]   = useState<CreditLedgerEntry[]>([]);
  const [packs, setPacks]       = useState<CreditPack[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
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
  }, [getToken]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (error)   return <p className="text-sm text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>;
  if (!balance) return <p className="text-sm text-muted-foreground">No active plan found.</p>;

  const totalUsed = balance.included_total - balance.included_remaining;
  const usagePct  = balance.included_total > 0 ? (totalUsed / balance.included_total) * 100 : 0;
  const isWarning = usagePct >= 75;

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Credits & Usage"
        subtitle={<span className="capitalize">Plan: <span className="text-foreground font-medium">{balance.tier}</span> · Period: {new Date(balance.period_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – {new Date(balance.period_end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
      />

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
            <p className="af-metric">{balance.overage_used}</p>
            {balance.overage_cap != null && (
              <p className="af-caption">cap: {balance.overage_cap}</p>
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {packs.map((pack) => (
              <Card key={pack.id} className="hover:border-border/80 transition-colors">
                <CardContent className="pt-4 space-y-1">
                  <p className="af-label font-semibold">{pack.label}</p>
                  <p className="af-caption">{pack.credits} credits</p>
                  <p className="af-caption">${pack.price_usd}</p>
                  <a
                    href={`/checkout?pack=${pack.id}`}
                    className={cn(buttonVariants({ size: 'sm', variant: 'outline' }), 'w-full mt-2 text-xs')}
                  >
                    Buy
                  </a>
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
