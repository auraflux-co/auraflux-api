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

const CORNER_LINK =
  'text-xs font-semibold text-slate-400 hover:text-amber-400 transition-colors';
const SECONDARY_BTN =
  'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 font-semibold px-4 py-2 rounded-xl text-xs transition-colors inline-flex items-center justify-center';
const PRIMARY_BTN =
  'w-full bg-amber-400 hover:bg-amber-500 text-slate-950 font-bold py-3 rounded-xl transition-all text-sm text-center block';

type Props = {
  firstName: string;
  planTier: string;
  setupDismissed: boolean;
};

export function MemberHomeHub({ firstName, planTier, setupDismissed }: Props) {
  return (
    <div className="space-y-8 text-white antialiased">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Creator portal
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
          Produce and publish from Peaks through Jobs — set up channels, review outputs, and manage billing
          in one place.
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
            Find high-signal moments from your live and VOD sources, then send them into production.
          </p>
          <Link href="/peaks" className={PRIMARY_BTN}>
            Browse Peaks
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
            Track active pipeline work, history, and start a new compose run.
          </p>
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
          <p className="text-sm text-slate-400 leading-relaxed">
            Approve staged outputs before they publish to your social accounts.
          </p>
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
          <p className="text-sm text-slate-400 leading-relaxed">
            Subscription, invoices, and credit balance for pipeline runs.
          </p>
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
          <p className="text-sm text-slate-400 leading-relaxed">
            Brand identity, team access, and profile preferences.
          </p>
        </PortalQuadrant>
      </div>
    </div>
  );
}
