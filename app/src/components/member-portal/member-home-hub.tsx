'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  BarChart3,
  Clapperboard,
  CreditCard,
  FolderOpen,
  Radio,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '@/lib/clerk-compat';
import { PortalQuadrant } from '@/components/member-portal/portal-quadrant';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { CheckoutWelcomeBanner } from '@/components/dashboard/checkout-welcome-banner';
import { Suspense } from 'react';
import { tierLabel } from '@/lib/tier-labels';
import { isReviewQueueJob } from '@/lib/job-labels';
import {
  listJobs,
  listConnectedAccounts,
  getCreditBalance,
  getBrands,
} from '@/lib/api';

const CORNER_LINK =
  'text-xs font-semibold text-slate-400 hover:text-amber-400 transition-colors';
const SECONDARY_BTN =
  'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 font-semibold px-4 py-2 rounded-xl text-xs transition-colors inline-flex items-center justify-center';
const PRIMARY_BTN =
  'w-full bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3 rounded-xl transition-all text-sm text-center block';

function StatBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-400">
      {children}
    </span>
  );
}

type HubStats = {
  pendingReview: number | null;
  activeJobs: number | null;
  accountsLinked: number | null;
  creditsRemaining: number | null;
  brandCount: number | null;
};

type Props = {
  firstName: string;
  planTier: string;
  setupDismissed: boolean;
};

export function MemberHomeHub({ firstName, planTier, setupDismissed }: Props) {
  const { getToken } = useAuth();
  const [stats, setStats] = useState<HubStats>({
    pendingReview: null,
    activeJobs: null,
    accountsLinked: null,
    creditsRemaining: null,
    brandCount: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const [jobsRes, accountsRes, creditsRes, brands] = await Promise.all([
          listJobs(token).catch(() => ({ jobs: [] })),
          listConnectedAccounts(token).catch(() => ({ ok: false, accounts: [] })),
          getCreditBalance(token).catch(() => null),
          getBrands(token).catch(() => []),
        ]);
        if (cancelled) return;
        const jobs = jobsRes.jobs || [];
        const pendingReview = jobs.filter(isReviewQueueJob).length;
        const activeJobs = jobs.filter((j) =>
          ['queued', 'running', 'processing', 'held', 'credit_paused'].includes(j.status || ''),
        ).length;
        const accountsLinked = accountsRes.accounts?.length ?? 0;
        const creditsRemaining = creditsRes
          ? (creditsRes.included_remaining || 0) + (creditsRes.pack_remaining || 0)
          : null;
        setStats({
          pendingReview,
          activeJobs,
          accountsLinked,
          creditsRemaining,
          brandCount: Array.isArray(brands) ? brands.length : 0,
        });
      } catch {
        /* soft — badges stay empty */
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  return (
    <div className="space-y-8 text-white antialiased">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Creator
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Welcome back, {firstName}
          </h1>
          <span className="bg-amber-400/10 text-amber-400 border border-amber-400/20 text-xs font-bold px-2.5 py-1 rounded-md uppercase tracking-wide">
            {tierLabel(planTier)}
          </span>
        </div>
        <p className="text-sm text-slate-400 max-w-2xl">
          Discover trend signals in Peaks, pull assets from Library, run Jobs, then Review and publish — channels,
          analytics, and billing stay in one Creator workspace.
        </p>
      </div>

      <Suspense>
        <CheckoutWelcomeBanner firstName={firstName} />
      </Suspense>

      {!setupDismissed && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-1 shadow-xl">
          <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <PortalQuadrant
          id="peaks"
          title="Peaks"
          icon={Sparkles}
          action={
            <Link href="/peaks" className={CORNER_LINK}>
              Open →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Trend signals and high-signal moments from your live and VOD sources — trim, preview, then send into production.
          </p>
          <StatBadge>Signals → trim → Short</StatBadge>
          <Link href="/peaks" className={PRIMARY_BTN}>
            Browse Peaks
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="library"
          title="Library"
          icon={FolderOpen}
          action={
            <Link href="/library" className={CORNER_LINK}>
              Open →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            One library: Mine (your publishes) and Channels (connected catalogs).
          </p>
          <StatBadge>Mine · Channels</StatBadge>
          <Link href="/library" className={PRIMARY_BTN}>
            Open Library
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="stats"
          title="Analytics"
          icon={BarChart3}
          action={
            <Link href="/stats" className={CORNER_LINK}>
              Open →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Post-publish performance across YouTube, TikTok, and Instagram for this brand.
          </p>
          <StatBadge>Views · engagement · recent posts</StatBadge>
          <Link href="/stats" className={PRIMARY_BTN}>
            View Analytics
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="jobs"
          title="My Jobs"
          icon={Clapperboard}
          action={
            <Link href="/myjobs" className={CORNER_LINK}>
              All jobs →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Track jobs in progress, history, and start a new Short.
          </p>
          {stats.activeJobs != null && (
            <StatBadge>
              {stats.activeJobs === 0
                ? 'No jobs in progress'
                : `${stats.activeJobs} in progress`}
            </StatBadge>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href="/myjobs/new" className={SECONDARY_BTN}>
              New job
            </Link>
            <Link href="/myjobs/active" className={SECONDARY_BTN}>
              In progress
            </Link>
          </div>
        </PortalQuadrant>

        <PortalQuadrant
          id="review"
          title="Review Queue"
          icon={Activity}
          action={
            <Link href="/review" className={CORNER_LINK}>
              Review →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Approve staged outputs before they publish to your social accounts.
          </p>
          {stats.pendingReview != null && (
            <StatBadge>
              {stats.pendingReview === 0
                ? 'Queue clear'
                : `${stats.pendingReview} pending approval${stats.pendingReview === 1 ? '' : 's'}`}
            </StatBadge>
          )}
          <Link href="/review" className={SECONDARY_BTN}>
            Open review
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="channels"
          title="Channels & Social"
          icon={Radio}
          action={
            <Link href="/settings/channels" className={CORNER_LINK}>
              Manage →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Connect source channels and destination social accounts for fetch and publish.
          </p>
          {stats.accountsLinked != null && (
            <StatBadge>
              {stats.accountsLinked === 0
                ? 'No accounts linked'
                : `${stats.accountsLinked} account${stats.accountsLinked === 1 ? '' : 's'} linked`}
            </StatBadge>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <Link href="/settings/channels" className={SECONDARY_BTN}>
              My Channels
            </Link>
            <Link href="/settings/social" className={SECONDARY_BTN}>
              Social accounts
            </Link>
          </div>
        </PortalQuadrant>

        <PortalQuadrant
          id="billing"
          title="Billing & Credits"
          icon={CreditCard}
          action={
            <Link href="/billing" className={CORNER_LINK}>
              Billing →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Subscription, invoices, and credit balance for your Shorts.
          </p>
          {stats.creditsRemaining != null && (
            <StatBadge>
              {stats.creditsRemaining.toLocaleString()} credit{stats.creditsRemaining === 1 ? '' : 's'} left
            </StatBadge>
          )}
          <Link href="/billing" className={SECONDARY_BTN}>
            View billing
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="settings"
          title="Settings"
          icon={Settings2}
          action={
            <Link href="/settings" className={CORNER_LINK}>
              Settings →
            </Link>
          }
        >
          <p className="text-sm text-slate-400 leading-relaxed flex-1">
            Brand identity, team access, and profile preferences.
          </p>
          {stats.brandCount != null && (
            <StatBadge>
              {stats.brandCount === 0
                ? 'No brands yet'
                : `${stats.brandCount} brand${stats.brandCount === 1 ? '' : 's'}`}
            </StatBadge>
          )}
          <Link href="/settings/brand" className={SECONDARY_BTN}>
            Brand profile
          </Link>
        </PortalQuadrant>
      </div>
    </div>
  );
}
