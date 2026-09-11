'use client';

import Link from 'next/link';
import {
  Activity,
  Clapperboard,
  CreditCard,
  Radio,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { PortalQuadrant } from '@/components/member-portal/portal-quadrant';
import { SetupChecklist } from '@/components/dashboard/setup-checklist';
import { CheckoutWelcomeBanner } from '@/components/dashboard/checkout-welcome-banner';
import { Suspense } from 'react';
import { tierLabel } from '@/lib/tier-labels';

const TIER_BADGE: Record<string, string> = {
  growth: 'bg-amber-50 text-amber-900 border border-amber-200',
  operate: 'bg-slate-100 text-slate-700 border border-slate-200',
  guided: 'bg-blue-50 text-blue-800 border border-blue-200',
  managed: 'bg-violet-50 text-violet-800 border border-violet-200',
  custom: 'bg-amber-50 text-amber-900 border border-amber-200',
};

type Props = {
  firstName: string;
  planTier: string;
  setupDismissed: boolean;
};

export function MemberHomeHub({ firstName, planTier, setupDismissed }: Props) {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--mp-muted)]">
          Creator portal
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--mp-text)]">
            Welcome back, {firstName}
          </h1>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-bold tracking-widest uppercase ${TIER_BADGE[planTier] ?? TIER_BADGE.operate}`}
          >
            {tierLabel(planTier)}
          </span>
        </div>
        <p className="text-sm text-[var(--mp-muted)] max-w-2xl">
          Produce and publish from Peaks through Jobs — set up channels, review outputs, and manage billing
          in one place.
        </p>
      </div>

      <Suspense>
        <CheckoutWelcomeBanner firstName={firstName} />
      </Suspense>

      {!setupDismissed && (
        <div className="rounded-2xl border border-[var(--mp-border)] bg-[var(--mp-card)] p-1 shadow-sm">
          <SetupChecklist setupDismissed={setupDismissed} planTier={planTier} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <PortalQuadrant
          id="peaks"
          title="Peaks"
          icon={Sparkles}
          action={
            <Link href="/peaks" className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline">
              Open →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed flex-1">
            Find high-signal moments from your live and VOD sources, then send them into production.
          </p>
          <Link
            href="/peaks"
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-[var(--mp-accent)] text-[var(--mp-accent-fg)] font-bold text-sm px-4 py-2.5 hover:opacity-90 transition"
          >
            Browse Peaks
          </Link>
        </PortalQuadrant>

        <PortalQuadrant
          id="jobs"
          title="My Jobs"
          icon={Clapperboard}
          action={
            <Link href="/myjobs" className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline">
              All jobs →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed flex-1">
            Track active pipeline work, history, and start a new compose run.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/myjobs/new"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--mp-navy)] text-white font-bold text-sm px-4 py-2.5 hover:opacity-90 transition"
            >
              New job
            </Link>
            <Link
              href="/myjobs/active"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--mp-border)] text-[var(--mp-text)] font-semibold text-sm px-4 py-2.5 hover:bg-[var(--mp-soft)] transition"
            >
              In progress
            </Link>
          </div>
        </PortalQuadrant>

        <PortalQuadrant
          id="review"
          title="Review Queue"
          icon={Activity}
          action={
            <Link href="/review" className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline">
              Review →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed">
            Approve staged outputs before they publish to your social accounts.
          </p>
        </PortalQuadrant>

        <PortalQuadrant
          id="channels"
          title="Channels & Social"
          icon={Radio}
          action={
            <Link
              href="/settings/channels"
              className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline"
            >
              Manage →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed flex-1">
            Connect source channels and destination social accounts for fetch and publish.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/settings/channels"
              className="text-sm font-semibold text-[var(--mp-accent-ink)] hover:underline"
            >
              My Channels
            </Link>
            <span className="text-[var(--mp-border)]">·</span>
            <Link
              href="/settings/social"
              className="text-sm font-semibold text-[var(--mp-accent-ink)] hover:underline"
            >
              Social accounts
            </Link>
          </div>
        </PortalQuadrant>

        <PortalQuadrant
          id="billing"
          title="Billing & Credits"
          icon={CreditCard}
          action={
            <Link href="/billing" className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline">
              Billing →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed">
            Subscription, invoices, and credit balance for pipeline runs.
          </p>
        </PortalQuadrant>

        <PortalQuadrant
          id="settings"
          title="Settings"
          icon={Settings2}
          action={
            <Link href="/settings" className="text-xs font-semibold text-[var(--mp-accent-ink)] hover:underline">
              Settings →
            </Link>
          }
        >
          <p className="text-sm text-[var(--mp-muted)] leading-relaxed">
            Brand identity, team access, and profile preferences.
          </p>
        </PortalQuadrant>
      </div>
    </div>
  );
}
