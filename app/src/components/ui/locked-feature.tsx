'use client';

/**
 * LockedFeature — CPD-129
 *
 * Wraps UI elements that require a higher plan tier.
 * Instead of hiding locked features, renders them greyed-out with a lock icon
 * and an upgrade tooltip. Creates an upsell surface rather than an invisible wall.
 *
 * Usage:
 *   <LockedFeature minPlan="dfy" label="Available on Managed plan">
 *     <AvatarOption />
 *   </LockedFeature>
 */

import { ReactNode } from 'react';
import { type PlanTier } from '@/lib/api';

const TIER_RANK: Record<string, number> = {
  diy:    1,
  dwy:    2,
  dfy:    3,
  custom: 99,
};

const PLAN_LABELS: Record<string, string> = {
  diy:    'Operate',
  dwy:    'Guided',
  dfy:    'Managed',
  custom: 'Custom',
};

interface LockedFeatureProps {
  /** Minimum plan tier required to access this feature */
  minPlan:     PlanTier;
  /** Current user's plan tier */
  currentPlan?: PlanTier | string;
  /** Short label shown in tooltip e.g. "Available on Managed" */
  label?:      string;
  /** Custom upgrade message */
  upgradeMsg?: string;
  children:    ReactNode;
  /** If true, hides completely rather than greying out (use sparingly) */
  hide?:       boolean;
}

export function LockedFeature({
  minPlan,
  currentPlan = 'diy',
  label,
  upgradeMsg,
  children,
  hide = false,
}: LockedFeatureProps) {
  const currentRank = TIER_RANK[currentPlan] ?? 1;
  const requiredRank = TIER_RANK[minPlan] ?? 1;
  const isLocked = currentRank < requiredRank;

  if (!isLocked) return <>{children}</>;
  if (hide)      return null;

  const planName = PLAN_LABELS[minPlan] ?? minPlan;
  const message  = upgradeMsg ?? (label ?? `Upgrade to ${planName} to unlock this feature`);

  return (
    <div className="relative group">
      {/* Greyed-out children */}
      <div className="opacity-40 pointer-events-none select-none" aria-disabled="true">
        {children}
      </div>

      {/* Lock overlay */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center gap-1.5 bg-black/60 backdrop-blur-sm rounded-md px-2.5 py-1.5 border border-white/10">
          <LockIcon />
          <span className="text-xs text-white/80 font-medium whitespace-nowrap">
            {PLAN_LABELS[minPlan] ?? planName}
          </span>
        </div>
      </div>

      {/* Tooltip on hover */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <div className="bg-gray-900 border border-white/10 rounded-lg px-3 py-2 text-xs text-white shadow-xl max-w-52 text-center">
          <p className="font-medium text-amber-400 mb-0.5">Feature locked</p>
          <p className="text-gray-300">{message}</p>
          <p className="text-indigo-400 mt-1">Upgrade on the Billing page →</p>
        </div>
        {/* Arrow */}
        <div className="w-2 h-2 bg-gray-900 border-r border-b border-white/10 rotate-45 mx-auto -mt-1" />
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg className="w-3 h-3 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

/**
 * Inline locked badge — use for buttons/menu items that can't be wrapped
 */
export function LockedBadge({ minPlan }: { minPlan: PlanTier }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
      <LockIcon />
      {PLAN_LABELS[minPlan] ?? minPlan}
    </span>
  );
}
