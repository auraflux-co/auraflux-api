/**
 * Tier label mapping — internal tier IDs → user-facing display names.
 *
 * Internal tier IDs (diy, dwy, dfy, custom) are API identifiers and must never
 * be shown to users. Use these helpers everywhere a tier name is displayed.
 */

export const TIER_LABELS: Record<string, string> = {
  diy:    'Operate',
  dwy:    'Guided',
  dfy:    'Managed',
  custom: 'Enterprise',
};

export const TIER_LABEL_LOWER: Record<string, string> = {
  diy:    'operate',
  dwy:    'guided',
  dfy:    'managed',
  custom: 'enterprise',
};

/** Returns the display name for a tier ID (e.g. "diy" → "Operate"). */
export function tierLabel(tier: string | null | undefined): string {
  return TIER_LABELS[tier ?? ''] ?? 'Operate';
}

/** Returns the display name, title-cased, for use in sentences. */
export function tierLabelLower(tier: string | null | undefined): string {
  return TIER_LABEL_LOWER[tier ?? ''] ?? 'operate';
}

/** Returns the display name with "plan" appended (e.g. "Operate plan"). */
export function tierPlanLabel(tier: string | null | undefined): string {
  return `${tierLabel(tier)} plan`;
}
