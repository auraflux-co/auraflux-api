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

import { useEffect, useOptimistic, useRef, useState, useTransition, Suspense, memo } from 'react';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth, useUser } from '@/lib/clerk-compat';
import { useBrand } from '@/contexts/brand-context';
import { tierLabel, canAddManaged } from '@/lib/tier-labels';
import { formatUserError } from '@/lib/job-labels';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getCreditBalance,
  getPlans,
  getCreditPacks,
  getPaymentMethod,
  subscribeToPlan,
  subscribeManagedAddon,
  purchasePack,
  listConnectedAccounts,
  type CreditBalance,
  type Plan,
  type CreditPack,
  type Brand,
  type PaymentMethod,
} from '@/lib/api';

function cardBrandLabel(brand: string) {
  const map: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'Amex',
    discover: 'Discover',
    jcb: 'JCB',
    unionpay: 'UnionPay',
    diners: 'Diners',
  };
  return map[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

function formatBillingDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Base plan ladder only — Managed is an add-on, not a third plan. */
const TIER_ORDER = ['growth', 'operate'];

/** Fallback display prices when Stripe /plans has no row yet */
const FALLBACK_PRICE_USD: Record<string, number> = {
  growth: 299,
  operate: 999,
};

function displayPriceUsd(plan: Plan | undefined, tier: string): number | null {
  if (plan?.price_usd != null && plan.price_usd > 0) return plan.price_usd;
  return FALLBACK_PRICE_USD[tier] ?? null;
}

// Credits come from plan?.credits / entitlements — not hardcoded in highlights.
const PLAN_META: Record<string, {
  label: string; audience: string; sub: string; valueMetric: string; highlights: string[];
  cta: string; contactSales: boolean;
}> = {
  growth: {
    label:       'Creator',
    audience:    'For solo streamers',
    sub:         'Solo streamers shipping daily content.',
    valueMetric: 'Self-serve Peaks → Short → publish',
    highlights: [
      'Up to 40 hours of VOD processing / mo',
      '3 connected channels (YouTube, Twitch, Kick)',
      'Auto 9:16 framing & kinetic captions',
      'Direct dispatch to TikTok, Shorts & Reels',
    ],
    cta:          'Start Creator Plan',
    contactSales: false,
  },
  operate: {
    label:       'Studio',
    audience:    'For high volume & teams',
    sub:         'High-volume streamers, clip networks, media teams & agencies.',
    valueMetric: 'Full platform seat · priority queue · team',
    highlights: [
      'Unlimited VOD processing & peak detection',
      'Unlimited channels & social dispatch',
      'Custom caption fonts & brand templates',
      'Team workspace seats & API key access',
    ],
    cta:          'Start Studio Plan',
    contactSales: false,
  },
};

const MANAGED_ADDON = {
  label:    'Managed',
  audience: 'Add-on for Creator or Studio',
  sub:      'Our team runs production with you — attach to either plan.',
  priceUsd: 1499,
  highlights: [
    'Works on Creator or Studio',
    'Dedicated account managers',
    'Custom end-to-end workflow builds',
    'Priority support with custom SLAs',
  ],
  cta: 'Add Managed',
};

const FEATURE_COMPARISON: Array<{
  feature: string;
  growth: boolean | string;
  operate: boolean | string;
  managed: boolean | string;
}> = [
  { feature: 'Peaks → Short → publish',           growth: true,       operate: true,       managed: true             },
  { feature: 'VOD hours / mo',                    growth: '40 hrs',   operate: 'Unlimited', managed: 'Unlimited'     },
  { feature: 'Connected channels',                growth: '3',        operate: 'Unlimited', managed: 'Unlimited'     },
  { feature: 'Team seats & API keys',             growth: false,      operate: true,       managed: true             },
  { feature: 'Priority render queue',             growth: false,      operate: true,       managed: true             },
  { feature: 'Done-for-you production',           growth: false,      operate: false,      managed: true             },
  { feature: 'Support',                           growth: 'Standard', operate: 'Priority',  managed: 'Custom SLA'    },
];

// C1: skeleton while data loads
function BillingSkeleton() {
  return (
    <PageShell maxWidth="3xl">
      <PageHeader title="Subscription" subtitle="Manage your plan and credit top-ups." />
      <div className="space-y-4 animate-pulse">
        <div className="h-36 rounded-lg bg-muted" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="h-52 rounded-lg bg-muted" />
          <div className="h-52 rounded-lg bg-muted" />
        </div>
      </div>
    </PageShell>
  );
}

// C3: reusable dismissible banner
function DismissibleBanner({
  variant, children,
}: {
  variant: 'success' | 'muted' | 'destructive';
  children: React.ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const cls = {
    success:     'border border-success/40 bg-success/10 text-success',
    muted:       'border border-border bg-muted text-muted-foreground',
    destructive: 'border border-destructive/40 bg-destructive/10 text-destructive',
  }[variant];
  return (
    <div className={`rounded-lg px-4 py-3 flex items-start justify-between gap-3 ${cls}`}>
      <div className="text-sm">{children}</div>
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

type BrandRowProps = {
  brand: Brand;
  isActive: boolean;
  isSwitching: boolean;
  switchDisabled: boolean;
  planName: string;
  subtitle: string;
  onSwitch: (brand: Brand) => void;
  onManageChannels: () => void;
  onOperatePlan: () => void;
};

const BrandRow = memo(function BrandRow({
  brand,
  isActive,
  isSwitching,
  switchDisabled,
  planName,
  subtitle,
  onSwitch,
  onManageChannels,
  onOperatePlan,
}: BrandRowProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl border transition-colors',
        isActive
          ? 'border-amber-400/40 bg-amber-400/5 ring-1 ring-amber-400/20'
          : 'border-border bg-card',
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-foreground">{brand.name}</span>
          <Badge
            variant="outline"
            status={isActive ? 'published' : 'draft'}
            className="capitalize"
          >
            {planName}
          </Badge>
          {brand.is_primary && (
            <span className="text-[10px] uppercase tracking-wider text-slate-400">Primary</span>
          )}
          {isActive && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">Active</span>
          )}
        </div>
        <p className="text-xs text-slate-400">{subtitle}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {isSwitching ? (
          <Button
            size="sm"
            variant="default"
            className="h-9 font-medium gap-2"
            disabled
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Switching…
          </Button>
        ) : isActive ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-9 font-medium"
              onClick={onManageChannels}
            >
              Manage Channels
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-9 font-medium"
              onClick={onOperatePlan}
            >
              Manage Plan
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="default"
            className="h-9 font-medium"
            disabled={switchDisabled}
            onClick={() => onSwitch(brand)}
          >
            Switch to Brand
          </Button>
        )}
      </div>
    </div>
  );
});

function BillingPageInner() {
  const { getToken, isLoaded } = useAuth();
  const { user } = useUser();
  const { brands, activeBrand, setActiveBrand } = useBrand();
  const searchParams    = useSearchParams();
  const router          = useRouter();
  const [compareOpen, setCompareOpen] = useState(false);
  const [channelCount, setChannelCount] = useState<number | null>(null);
  const [brandSearch, setBrandSearch] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [brandRefreshing, setBrandRefreshing] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  // C2: distinguish in-place upgrade (?upgraded=1) from new checkout (?success=1)
  const stripeSuccess   = searchParams.get('success')       === '1';
  const stripeUpgraded  = searchParams.get('upgraded')      === '1';
  const stripeCancelled = searchParams.get('cancelled')     === '1';
  const packSuccess     = searchParams.get('pack_success')  === '1';
  const packCancelled   = searchParams.get('pack_cancelled') === '1';
  const [isPending, start] = useTransition();
  const [optimisticActiveId, setOptimisticActiveId] = useOptimistic(
    activeBrand?.id ?? null,
    (_current: string | null, nextId: string) => nextId,
  );
  const [, startOptimistic] = useTransition();
  const [redirecting, setRedirecting] = useState(false); // C8

  // U6: clear transient query params from URL so banners don't re-appear on refresh
  useEffect(() => {
    if (stripeSuccess || stripeUpgraded || stripeCancelled || packSuccess || packCancelled) {
      router.replace('/billing');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [balance, setBalance]     = useState<CreditBalance | null>(null);
  const [plans, setPlans]         = useState<Plan[]>([]);
  const [packs, setPacks]         = useState<CreditPack[]>([]);
  const [loading, setLoading]     = useState(true); // C1
  const [error, setError]         = useState<string | null>(null);

  // Initial catalog + payment method (not tied to active brand)
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const [b, p, pk, accounts, pm] = await Promise.all([
          getCreditBalance(token ?? undefined),
          getPlans(token ?? undefined),
          getCreditPacks(token ?? undefined),
          listConnectedAccounts(token ?? undefined).catch(() => ({ accounts: [] })),
          getPaymentMethod(token ?? undefined).catch(() => ({ ok: false, paymentMethod: null })),
        ]);
        if (cancelled) return;
        setBalance(b);
        setPlans(p.plans ?? []);
        setPacks(pk.packs ?? []);
        setChannelCount(accounts.accounts?.length ?? 0);
        setPaymentMethod(pm.paymentMethod ?? null);
      } catch {
        if (!cancelled) setError("Couldn't load billing info. Refresh to try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [getToken, isLoaded]);

  // Soft refresh balance + channels when active brand changes (no full-page skeleton)
  const lastBrandIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isLoaded || loading || !activeBrand?.id) return;
    if (lastBrandIdRef.current === null) {
      lastBrandIdRef.current = activeBrand.id;
      return;
    }
    if (lastBrandIdRef.current === activeBrand.id) return;
    lastBrandIdRef.current = activeBrand.id;
    let cancelled = false;
    setBrandRefreshing(true);
    // Keep prior channel/credit metrics visible — mutate keys only, no list wipe
    (async () => {
      try {
        const token = await getToken();
        const [b, accounts] = await Promise.all([
          getCreditBalance(token ?? undefined),
          listConnectedAccounts(token ?? undefined).catch(() => ({ accounts: [] })),
        ]);
        if (cancelled) return;
        setBalance(b);
        setChannelCount(accounts.accounts?.length ?? 0);
      } catch {
        // Keep prior balance visible; brand switch already applied optimistically
      } finally {
        if (!cancelled) {
          setBrandRefreshing(false);
          setPendingSwitchId(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [activeBrand?.id, getToken, isLoaded, loading]);

  async function handleUpgrade(planId: string) {
    setError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        // CPD-401: first-time subscribers (no current subscription) land on /home
        // with a welcome banner. Existing subscribers upgrading stay on /billing.
        const isFirstSubscription = (currentTier === 'growth' || currentTier === 'operate') && !balance?.stripe_subscription_id;
        const successUrl = isFirstSubscription
          ? `${origin}/home?checkout=success`
          : `${origin}/billing?success=1`;
        const res = await subscribeToPlan(
          planId,
          successUrl,
          `${origin}/billing?cancelled=1`,
          token ?? undefined,
        );
        // CPD-382: in-place upgrade → ?upgraded=1 (immediate proration copy);
        // new subscription checkout → Stripe redirects back to success URL.
        if ((res as { upgraded?: boolean }).upgraded) {
          window.location.href = `${origin}/billing?upgraded=1`;
        } else {
          setRedirecting(true);
          window.location.href = res.url;
        }
      } catch {
        setError("Couldn't start checkout. Please try again.");
      }
    });
  }

  async function handleAddManaged() {
    setError(null);
    start(async () => {
      try {
        const token = await getToken();
        const origin = window.location.origin;
        const res = await subscribeManagedAddon(
          `${origin}/billing?managed=1`,
          `${origin}/billing?cancelled=1`,
          token ?? undefined,
        );
        if (res.alreadyAttached || res.attached) {
          window.location.href = `${origin}/billing?managed=1`;
          return;
        }
        if (res.url) {
          setRedirecting(true);
          window.location.href = res.url;
          return;
        }
        setError(res.error || "Couldn't add Managed. Subscribe to Creator or Studio first.");
      } catch {
        setError("Couldn't add Managed. Please try again or contact support.");
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

  // C1: show skeleton while data loads — prevents wrong upgrade cards flashing
  if (loading) return <BillingSkeleton />;

  const currentTier  = balance?.tier ?? 'growth';
  // Legacy guided maps to Studio on the ladder; Managed is an add-on, not a ladder step.
  const ladderTier   = currentTier === 'guided' ? 'operate' : currentTier;
  const currentIdx   = TIER_ORDER.indexOf(ladderTier);
  const upgradeTiers = (currentIdx >= 0 ? TIER_ORDER.slice(currentIdx + 1) : []) as ('growth' | 'operate')[];
  const hasManagedAddon = !!(balance?.managed_addon || currentTier === 'managed');
  const showManagedAddon = canAddManaged(currentTier) && !hasManagedAddon;

  const creditUsed  = balance ? (balance.included_total - balance.included_remaining) : 0;
  const creditTotal = balance?.included_total ?? 0;
  const usagePct    = creditTotal > 0 ? Math.min((creditUsed / creditTotal) * 100, 100) : 0;

  const displayActiveId = optimisticActiveId ?? activeBrand?.id ?? null;

  function brandPlanLabel(brand: Brand) {
    const t = brand.tier || (brand.id === displayActiveId ? currentTier : null);
    return t ? (PLAN_META[t]?.label ?? tierLabel(t)) : 'No plan';
  }

  function switchToBrand(brand: Brand) {
    if (brand.id === displayActiveId) return;
    setPendingSwitchId(brand.id);
    // Optimistic ACTIVE highlight this frame; soft-refresh metrics in background (button stays Switching…)
    startOptimistic(() => {
      setOptimisticActiveId(brand.id);
    });
    setActiveBrand(brand);
  }

  function brandSubtitle(brand: Brand, isActive: boolean) {
    const creditsIncluded = isActive
      ? creditTotal
      : (brand.credits_included ?? null);
    if (!isActive) {
      return creditsIncluded != null
        ? `${creditsIncluded.toLocaleString()} credits/mo`
        : brandPlanLabel(brand);
    }
    const channelPart = channelCount != null
      ? `${channelCount} channel${channelCount === 1 ? '' : 's'} connected`
      : 'Channels…';
    const creditPart = creditsIncluded != null
      ? (brandRefreshing
        ? ` · ${creditsIncluded.toLocaleString()} credits/mo`
        : ` · ${creditUsed.toLocaleString()}/${creditsIncluded.toLocaleString()} credits used`)
      : '';
    const updating = brandRefreshing || pendingSwitchId === brand.id ? ' · updating…' : '';
    return `${channelPart}${creditPart}${updating}`;
  }

  const billingEmail =
    user?.primaryEmailAddress?.emailAddress
    ?? (user as { email?: string } | null | undefined)?.email
    ?? null;
  const nextInvoiceLabel = formatBillingDate(balance?.period_end);
  const paymentSummary = paymentMethod
    ? `${cardBrandLabel(paymentMethod.brand)} ending in ${paymentMethod.last4}`
    : 'No card on file';
  const filteredBrands = brands.filter((b) =>
    !brandSearch.trim()
      || b.name.toLowerCase().includes(brandSearch.trim().toLowerCase()),
  );

  return (
    <PageShell maxWidth="full" className="!space-y-5">
      <PageHeader
        title="Billing & Brands"
        subtitle="Active subscription, brands, and payment — plan comparison stays secondary."
      />

      {/* Billing summary — payment CTAs with card + cycle context */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="min-w-0 w-full sm:w-auto space-y-1.5">
          <p className="text-sm font-medium text-white">
            {paymentSummary}
            {nextInvoiceLabel ? ` · Next invoice ${nextInvoiceLabel}` : ''}
          </p>
          <p className="text-xs text-slate-300 leading-relaxed">
            {billingEmail
              ? `Primary billing email: ${billingEmail}`
              : 'Update payment method or download invoices anytime.'}
            {creditTotal > 0
              ? ` · ${creditUsed.toLocaleString()}/${creditTotal.toLocaleString()} credits used this period`
              : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Link
            href="/billing/payment"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'h-9 font-medium border-slate-600 bg-transparent text-slate-100 hover:bg-slate-800 hover:text-white',
            )}
          >
            Update Payment Method
          </Link>
          <Link
            href="/billing/payment"
            className={cn(
              buttonVariants({ variant: 'secondary', size: 'sm' }),
              'h-9 font-medium bg-slate-100 text-slate-900 hover:bg-white',
            )}
          >
            Download Invoices &amp; History
          </Link>
        </div>
      </div>

      {/* C8: pre-redirect state while navigating to Stripe checkout */}
      {redirecting && (
        <p className="af-body text-muted-foreground bg-muted rounded px-3 py-2 animate-pulse">
          Redirecting to Stripe secure checkout…
        </p>
      )}

      {/* C2: in-place prorated upgrade — immediate effect */}
      {stripeUpgraded && (
        <DismissibleBanner variant="success">
          <span className="font-semibold">Plan upgraded!</span>{' '}
          Your new credit allowance is active now. Stripe will charge a prorated amount for the remainder of this billing period.
        </DismissibleBanner>
      )}
      {/* C2: new subscription checkout return — tier update via webhook */}
      {stripeSuccess && (
        <DismissibleBanner variant="success">
          <span className="font-semibold">Subscription confirmed!</span>{' '}
          Your plan will be active within a minute once payment is processed.
        </DismissibleBanner>
      )}
      {stripeCancelled && (
        <DismissibleBanner variant="muted">
          Checkout cancelled — no charge was made.
        </DismissibleBanner>
      )}
      {/* C3+C4: dismissible bordered pack banners matching /credits style */}
      {packSuccess && (
        <DismissibleBanner variant="success">
          <span className="font-semibold">Credits purchased!</span>{' '}
          Your balance will update shortly as the payment is confirmed.
        </DismissibleBanner>
      )}
      {packCancelled && (
        <DismissibleBanner variant="muted">
          Pack checkout cancelled — no charge was made.
        </DismissibleBanner>
      )}
      {error && (
        <DismissibleBanner variant="destructive">{formatUserError(error)}</DismissibleBanner>
      )}

      {/* ── Your brands (above the fold) ──────────────────────────────────── */}
      {activeBrand?.is_primary && brands.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="af-subhead font-semibold">Your brands</h2>
            {brandRefreshing && (
              <span className="text-xs text-slate-400 animate-pulse">Refreshing active metrics…</span>
            )}
          </div>
          <div className="sticky top-0 z-10 -mx-1 px-1 py-2 mb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border/60">
            <div className="flex items-center justify-between gap-4">
              <Input
                placeholder={`Filter ${brands.length} brand${brands.length === 1 ? '' : 's'}…`}
                value={brandSearch}
                onChange={(e) => setBrandSearch(e.target.value)}
                className="h-9 w-full max-w-xs min-w-0"
                aria-label="Filter brands"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-9 font-medium shrink-0 self-center"
                onClick={() => router.push('/billing/add-brand')}
              >
                + Add brand
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {filteredBrands.length === 0 && (
              <p className="text-sm text-slate-400 py-6 text-center">
                No brands match “{brandSearch.trim()}”.
              </p>
            )}
            {filteredBrands.map((brand) => {
              const isActive = brand.id === displayActiveId;
              return (
                <BrandRow
                  key={brand.id}
                  brand={brand}
                  isActive={isActive}
                  isSwitching={pendingSwitchId === brand.id}
                  switchDisabled={pendingSwitchId != null && pendingSwitchId !== brand.id}
                  planName={brandPlanLabel(brand)}
                  subtitle={brandSubtitle(brand, isActive)}
                  onSwitch={switchToBrand}
                  onManageChannels={() => router.push('/settings/channels')}
                  onOperatePlan={() => {
                    document.getElementById('active-plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* ── Active plan overview ──────────────────────────────────────────── */}
      {balance && (
        <div id="active-plan" className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-5 space-y-4 scroll-mt-24">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="af-subhead text-muted-foreground">Active plan</span>
                <span className="text-[11px] font-bold uppercase tracking-wide bg-primary/15 text-primary border border-primary/30 px-2 py-0.5 rounded">
                  {PLAN_META[currentTier]?.label ?? tierLabel(currentTier)}
                </span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="af-metric text-primary">
                  {(() => {
                    const n = displayPriceUsd(plans.find(p => p.id === currentTier), currentTier);
                    return n != null ? `$${n.toLocaleString()}` : '—';
                  })()}
                </span>
                <span className="af-label text-muted-foreground">/month</span>
              </div>
              {PLAN_META[currentTier]?.sub && (
                <p className="af-caption text-muted-foreground mt-0.5">{PLAN_META[currentTier].sub}</p>
              )}
            </div>
            <div className="text-right">
              <p className="af-caption text-muted-foreground">Credits this period</p>
              <p className="text-lg font-bold tabular-nums">
                <span className={usagePct > 80 ? 'text-yellow-400' : 'text-foreground'}>{creditUsed.toLocaleString()}</span>
                <span className="text-muted-foreground font-normal text-sm"> / {creditTotal.toLocaleString()}</span>
              </p>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="w-full h-2 bg-muted/60 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', usagePct > 80 ? 'bg-yellow-500' : 'bg-primary')}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="af-caption text-muted-foreground">{Math.round(usagePct)}% used</span>
              {balance.pack_remaining > 0 && (
                <span className="af-caption text-primary/70">+{balance.pack_remaining.toLocaleString()} pack credits</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Downgrade link — Studio / Managed / legacy Guided */}
      {balance && currentTier !== 'growth' && (
        <p className="af-caption text-muted-foreground">
          Looking to change plans?{' '}
          <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">
            Contact us
          </a>{' '}
          and we&apos;ll take care of it.
        </p>
      )}

      {/* ── Upgrade options + Managed add-on ───────────────────────────────── */}
      {(upgradeTiers.length > 0 || showManagedAddon) && (
        <div id="plans" className="scroll-mt-24 space-y-6">
          {upgradeTiers.length > 0 && (
            <div>
              <h2 className="af-subhead mb-1">Upgrade your plan</h2>
              <p className="af-label mb-4 text-muted-foreground">Creator and Studio are the two plans. Managed is an add-on below.</p>
              <div className={cn('grid grid-cols-1 gap-4', upgradeTiers.length > 1 && 'sm:grid-cols-2')}>
                {upgradeTiers.map((tier) => {
                  const plan = plans.find((p) => p.id === tier);
                  const meta = PLAN_META[tier];
                  if (!meta) return null;
                  const canCheckout = !!plan?.priceConfigured;
                  return (
                    <div key={tier} className="rounded-xl border border-border bg-card flex flex-col overflow-hidden">
                      {tier === 'operate' && (
                        <div className="bg-amber-500 text-slate-950 text-[10px] font-bold px-3 py-1.5 uppercase tracking-wide text-center">
                          Most popular
                        </div>
                      )}
                      <div className="p-4 flex-1 flex flex-col gap-3">
                        <div>
                          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{meta.audience}</p>
                          <p className="text-lg font-bold text-foreground mt-1">{meta.label}</p>
                          <p className="af-caption text-muted-foreground mt-0.5">{meta.sub}</p>
                          <p className="af-caption font-medium text-primary/80 mt-1">{meta.valueMetric}</p>
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="af-metric">
                            {(() => {
                              const n = displayPriceUsd(plan, tier);
                              return n != null ? `$${n.toLocaleString()}` : '—';
                            })()}
                          </span>
                          <span className="af-caption text-muted-foreground">/mo</span>
                        </div>
                        <p className="af-caption text-muted-foreground">
                          {plan?.credits?.toLocaleString() ?? '—'} credits/month
                          <span className="text-primary/60 ml-1">· no rollover</span>
                        </p>
                        <ul className="space-y-1.5 flex-1">
                          {meta.highlights.map((h) => (
                            <li key={h} className="af-label flex gap-2">
                              <span className="text-primary shrink-0 mt-0.5">✓</span>
                              <span>{h}</span>
                            </li>
                          ))}
                        </ul>
                        {canCheckout ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full mt-1"
                            disabled={isPending}
                            onClick={() => handleUpgrade(tier)}
                          >
                            {isPending ? 'Processing…' : meta.cta}
                          </Button>
                        ) : (
                          <a
                            href="/support"
                            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'w-full text-center mt-1')}
                          >
                            {meta.cta}
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showManagedAddon && (
            <div>
              <h2 className="af-subhead mb-1">Add Managed</h2>
              <p className="af-label mb-4 text-muted-foreground">
                {`Done-for-you production — attach to your Creator or Studio subscription ($${MANAGED_ADDON.priceUsd.toLocaleString()}/mo).`}
              </p>
              <div className="rounded-xl border border-primary/40 bg-gradient-to-b from-primary/5 to-card flex flex-col overflow-hidden max-w-xl">
                <div className="bg-primary/10 border-b border-primary/20 px-4 py-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-primary">Add-on · works on either plan</span>
                </div>
                <div className="p-4 flex-1 flex flex-col gap-3">
                  <div>
                    <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{MANAGED_ADDON.audience}</p>
                    <p className="text-lg font-bold text-foreground mt-1">{MANAGED_ADDON.label}</p>
                    <p className="af-caption text-muted-foreground mt-0.5">{MANAGED_ADDON.sub}</p>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="af-metric text-primary">{`$${MANAGED_ADDON.priceUsd.toLocaleString()}`}</span>
                    <span className="af-caption text-muted-foreground">/mo add-on</span>
                  </div>
                  <ul className="space-y-1.5 flex-1">
                    {MANAGED_ADDON.highlights.map((h) => (
                      <li key={h} className="af-label flex gap-2">
                        <span className="text-primary shrink-0 mt-0.5">✓</span>
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    size="sm"
                    className="w-full mt-1"
                    disabled={isPending}
                    onClick={() => handleAddManaged()}
                  >
                    {isPending ? 'Processing…' : MANAGED_ADDON.cta}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {hasManagedAddon && currentTier !== 'managed' && (
            <p className="af-body text-muted-foreground">
              Managed add-on is active on your {tierLabel(currentTier)} plan.
            </p>
          )}

          <p className="af-caption text-muted-foreground">
            Monthly subscriptions. To change or cancel, <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">contact us</a>.
          </p>

          {/* Feature matrix — collapsed by default */}
          <div className="rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setCompareOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left bg-muted/20 hover:bg-muted/30 transition-colors"
              aria-expanded={compareOpen}
            >
              <span className="text-sm font-semibold">Compare Creator, Studio &amp; Managed add-on</span>
              <span className="text-xs text-muted-foreground">{compareOpen ? 'Hide ▲' : 'Show ▼'}</span>
            </button>
            {compareOpen && (
            <div className="overflow-x-auto border-t border-border">
            <table className="w-full af-caption border-collapse">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  <th className="text-left py-3 px-4 font-semibold text-foreground w-1/2">Feature</th>
                  <th className="text-center py-3 px-3 font-semibold text-foreground">{PLAN_META.growth.label}</th>
                  <th className="text-center py-3 px-3 font-semibold text-foreground">{PLAN_META.operate.label}</th>
                  <th className="text-center py-3 px-3 font-semibold text-primary">+ {MANAGED_ADDON.label}</th>
                </tr>
              </thead>
              <tbody>
                {FEATURE_COMPARISON.map((row, i) => (
                  <tr key={row.feature} className={cn('border-t border-border/50', i % 2 === 0 ? '' : 'bg-muted/20')}>
                    <td className="py-2.5 px-4 text-muted-foreground">{row.feature}</td>
                    {(['growth', 'operate', 'managed'] as const).map((t) => {
                      const val = row[t];
                      return (
                        <td key={t} className="text-center py-2.5 px-3">
                          {typeof val === 'string' ? (
                            <span className="text-foreground font-medium">{val}</span>
                          ) : val ? (
                            <span className="text-emerald-400 font-bold" aria-label="Included">✓</span>
                          ) : (
                            <span className="text-muted-foreground/30" aria-label="Not included">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            )}
          </div>
        </div>
      )}

      {currentTier === 'managed' && (
        <p className="af-body text-muted-foreground">
          You have Managed on your account. To discuss custom or enterprise terms, <a href="/support" className="underline underline-offset-2 hover:text-foreground transition-colors">contact us</a>.
        </p>
      )}

      {/* ── 3. Credit top-up pack ──────────────────────────────────────────────── */}
      {packs.some((p) => p.priceConfigured && p.id === 'credit_topup') && (
        <div>
          <h2 className="af-subhead mb-1">Credit top-up</h2>
          <p className="af-label mb-4 text-muted-foreground">
            Add 50 credits to keep your jobs running.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {packs.filter((p) => p.priceConfigured && p.id === 'credit_topup').map((pack) => (
              <div key={pack.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="af-body font-semibold">{pack.label}</p>
                    <p className="af-label text-muted-foreground">{pack.description}</p>
                  </div>
                  <span className="text-[11px] font-bold bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded shrink-0">
                    {pack.credits} cr
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={isPending}
                  onClick={() => handleBuyPack(pack.id)}
                >
                  {isPending ? 'Processing…' : `Buy — $${((pack.price_cents ?? 0) / 100).toFixed(0)}`}
                </Button>
                <p className="af-caption text-muted-foreground/70 text-center">Choose quantity at checkout</p>
              </div>
            ))}
          </div>
        </div>
      )}

    </PageShell>
  );
}

export default function BillingPage() {
  return (
    // C7: Suspense fallback shows skeleton while useSearchParams resolves
    <Suspense fallback={<BillingSkeleton />}>
      <BillingPageInner />
    </Suspense>
  );
}
