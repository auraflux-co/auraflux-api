/**
 * Human-readable label helpers for jobs, statuses, entry types, platforms,
 * credit ledger types, and API error sanitisation.
 *
 * All internal enum/slug values must be translated through these helpers before
 * being rendered in any customer-facing or admin UI.
 */

import { labelForContentType } from './content-types';

// ── Job status ────────────────────────────────────────────────────────────────

export const JOB_STATUS_LABELS: Record<string, string> = {
  pending:          'Preparing',
  queued:           'In Queue',
  queued_scheduled: 'Scheduled',
  running:          'Processing',
  complete:         'Complete',
  staged:           'In Review',
  published:        'Published',
  failed:           'Failed',
  held:             'On Hold',
  cancelled:        'Cancelled',
  credit_paused:    'Credits Paused',
};

export function jobStatusLabel(status: string | null | undefined): string {
  return JOB_STATUS_LABELS[status ?? ''] ?? (status ?? 'Unknown');
}

// ── Portal status ─────────────────────────────────────────────────────────────

export const PORTAL_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  pass:    'Passed',
  hold:    'On Hold',
  failed:  'Failed',
  skipped: 'Skipped',
};

export function portalStatusLabel(status: string | null | undefined): string {
  return PORTAL_STATUS_LABELS[status ?? ''] ?? (status ?? '—');
}

// ── Entry / source type ───────────────────────────────────────────────────────

export const ENTRY_TYPE_LABELS: Record<string, string> = {
  fetch:          'URL Fetch',
  upload:         'File Upload',
  library:        'Source Library',
  research_query: 'Web Research',
  template:       'From Template',
  custom:         'Custom',
};

export function entryTypeLabel(type: string | null | undefined): string {
  return ENTRY_TYPE_LABELS[type ?? ''] ?? (type ?? '—');
}

// ── Platform display names ────────────────────────────────────────────────────

export const PLATFORM_LABELS: Record<string, string> = {
  youtube:   'YouTube',
  tiktok:    'TikTok',
  instagram: 'Instagram',
  twitter:   'X (Twitter)',
  facebook:  'Facebook',
  linkedin:  'LinkedIn',
};

export function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? p;
}

export function platformListLabel(platforms: string[]): string {
  if (!platforms?.length) return 'No platforms';
  return platforms.map(platformLabel).join(', ');
}

// ── Credit / ledger type ──────────────────────────────────────────────────────

export const CREDIT_TYPE_LABELS: Record<string, string> = {
  included:   'Plan Credits',
  overage:    'Overage',
  pack:       'Credit Pack',
  refund:     'Refund',
  bonus:      'Bonus Credits',
  adjustment: 'Adjustment',
  deduction:  'Job Usage',
  charge:     'Job Usage',
};

export function creditTypeLabel(type: string | null | undefined): string {
  return CREDIT_TYPE_LABELS[type ?? ''] ?? (type ?? '—');
}

// ── Job display title ─────────────────────────────────────────────────────────
// Builds a human title from whatever data is available on a job row.

export function jobDisplayTitle(job: {
  contentType?: string | null;
  templateName?: string | null;
  wizardConfig?: { topic?: string | null; templateName?: string | null } | null;
  createdAt?: string | number | null;
  jobId?: string;
}): string {
  // 1. Prefer topic (text-to-video jobs have a meaningful topic)
  const topic = job.wizardConfig?.topic?.trim();
  if (topic) return topic;
  // 2. Use the saved template name (TikTok Clutch, YouTube Deep Dive, etc.)
  const tplName = job.templateName || job.wizardConfig?.templateName;
  if (tplName) return tplName;
  // 3. Fall back to content-type + date
  const type = job.contentType ? labelForContentType(job.contentType) : null;
  if (job.createdAt) {
    const d = new Date(typeof job.createdAt === 'string' ? job.createdAt : Number(job.createdAt));
    const dateStr = isNaN(d.getTime()) ? '' : ` — ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    if (type) return `${type}${dateStr}`;
  }
  return type ?? 'Untitled job';
}

// ── Error sanitisation ────────────────────────────────────────────────────────
// Strips technical noise (stack traces, SQL, HTTP status) from error messages
// before they're shown to users. Keep it short and actionable.

const TECHNICAL_PATTERNS = [
  /at \w+ \(/,             // stack trace lines
  /SELECT|INSERT|UPDATE|DELETE|FROM|WHERE/i,  // SQL
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/,         // network errors
  /^[45]\d{2}:/,           // "400: ..." / "500: ..."
  /unexpected token/i,
  /json parse/i,
];

export function formatUserError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (!msg || TECHNICAL_PATTERNS.some((re) => re.test(msg))) return fallback;
  // Truncate very long messages
  if (msg.length > 120) return fallback;
  return msg;
}
