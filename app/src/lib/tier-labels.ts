/**
 * Tier label mapping — internal tier IDs → user-facing display names.
 *
 * Marketing SSoT (auraflux.co/pricing):
 *   growth  → Growth / Creator
 *   operate → Pro Operator / Agency
 *   managed → Managed (inquiry)
 * Guided remains a support/service tier, not a checkout card.
 */

export const TIER_LABELS: Record<string, string> = {
  growth:     'Growth / Creator',
  operate:    'Pro Operator / Agency',
  guided:     'Guided',
  managed:    'Managed',
  custom:     'Enterprise',
  // Legacy aliases — diy/dwy/dfy were the old internal keys
  diy:        'Pro Operator / Agency',
  dwy:        'Guided',
  dfy:        'Managed',
};

export const TIER_LABEL_LOWER: Record<string, string> = {
  growth:     'growth / creator',
  operate:    'pro operator / agency',
  guided:     'guided',
  managed:    'managed',
  custom:     'enterprise',
};

/** Returns the display name for a tier ID (e.g. "growth" → "Growth / Creator"). */
export function tierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[tier ?? ''] ?? 'Growth / Creator';
}

/** Returns the display name, lowercased, for use in sentences. */
export function tierLabelLower(tier: string | null | undefined): string {
  return TIER_LABEL_LOWER[tier ?? ''] ?? 'growth / creator';
}

/** Returns the display name with "plan" appended. */
export function tierPlanLabel(tier: string | null | undefined): string {
  return `${tierLabel(tier)} plan`;
}

/** English plural helper — avoids a11y trees splitting "clip" + "s". */
export function pluralize(count: number, singular: string, plural?: string): string {
  const n = Number(count);
  if (n === 1) return singular;
  return plural ?? `${singular}s`;
}
