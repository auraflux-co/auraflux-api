/**
 * Tier label mapping — internal tier IDs → user-facing display names.
 *
 * Customer-facing SSoT (2026-09):
 *   growth  → Creator   (solo streamers)
 *   operate → Studio    (high volume & teams / agencies)
 *   guided  → Guided    (same platform + operator support)
 *   managed → Managed   (done-for-you)
 *
 * Stripe / API ids stay growth | operate | guided | managed.
 */

export const TIER_LABELS: Record<string, string> = {
  growth:     'Creator',
  operate:    'Studio',
  guided:     'Guided',
  managed:    'Managed',
  custom:     'Enterprise',
  // Legacy aliases — diy/dwy/dfy were the old internal keys
  diy:        'Studio',
  dwy:        'Guided',
  dfy:        'Managed',
};

export const TIER_LABEL_LOWER: Record<string, string> = {
  growth:     'creator',
  operate:    'studio',
  guided:     'guided',
  managed:    'managed',
  custom:     'enterprise',
};

export const TIER_AUDIENCE: Record<string, string> = {
  growth:  'For solo streamers',
  operate: 'For high volume & teams',
  guided:  'For teams that want operator guidance',
  managed: 'For done-for-you production',
};

/** Returns the display name for a tier ID (e.g. "growth" → "Creator"). */
export function tierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[tier ?? ''] ?? 'Creator';
}

/** Returns the display name, lowercased, for use in sentences. */
export function tierLabelLower(tier: string | null | undefined): string {
  return TIER_LABEL_LOWER[tier ?? ''] ?? 'creator';
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
