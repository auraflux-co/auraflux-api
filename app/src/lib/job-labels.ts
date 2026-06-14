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
  processing:       'In Review',
  complete:         'Complete',
  staged:           'In Review',
  operator_review:  'In Review',
  published:        'Published',
  failed:           'Failed',
  held:             'On Hold',
  cancelled:        'Cancelled',
  credit_paused:    'Credits Paused',
};

export function jobStatusLabel(status: string | null | undefined): string {
  return JOB_STATUS_LABELS[status ?? ''] ?? (status ?? 'Unknown');
}

/** Statuses that belong on /review once output exists (CPD-431 operator_review included). */
export const REVIEW_QUEUE_STATUSES = new Set([
  'complete',
  'staged',
  'operator_review',
]);

/** True when assembled output is ready for human review / approve-publish. */
export function isReviewQueueJob(job: {
  status?: string | null;
  outputUrl?: string | null;
}): boolean {
  const status = job.status ?? '';
  if (REVIEW_QUEUE_STATUSES.has(status)) return true;
  // Customer/developer API masks operator_review as processing (CPD-431).
  if (status === 'processing' && job.outputUrl) return true;
  // Portal-policy leak before API deploy — passed/non-compliant with output is review-ready.
  if (job.outputUrl && (status === 'passed' || status === 'non-compliant' || status === 'sendback')) {
    return true;
  }
  return false;
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

// ── Add-on / enhancement labels (pipeline addOns, not wizard templates) ───────

export const ADDON_LABELS: Record<string, string> = {
  tts:             'Voiceover',
  heygen:          'Avatar',
  shoppable:       'Shoppable tagging',
  wan:             'Video generation',
  clipSourcing:    'Scene selection',
  showCommentary:  'Narrative narration',
  branding:        'Brand overlay',
  imageBurn:       'Image burn',
  dynamicOverlays: 'Dynamic overlays',
  captions:        'Captions',
  colorGrade:      'Color grade',
  effects:         'Visual effects',
  thumbnail:       'Thumbnail',
  pip:             'Picture-in-picture',
};

export function addOnLabel(key: string): string {
  return ADDON_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human label for how the job was submitted (dashboard vs API vs E2E script). */
export function createdByLabel(createdBy: string | null | undefined): string {
  switch (createdBy) {
    case 'dashboard':   return 'Dashboard wizard';
    case 'e2e_script':  return 'E2E test script';
    case 'api':         return 'Direct API';
    case 'agent':       return 'Automation agent';
    default:            return createdBy ? String(createdBy) : 'Unknown';
  }
}

export function isDashboardOrder(createdBy: string | null | undefined): boolean {
  return createdBy === 'dashboard';
}

/** Wizard preset name, or a clear fallback when the job was not created from a template. */
export function resolveTemplateDisplayName(job: {
  templateName?: string | null;
  contentType?: string | null;
  wizardConfig?: {
    templateName?: string | null;
    templateId?: string | null;
    contentType?: string | null;
  } | null;
}): string {
  const name = job.templateName || job.wizardConfig?.templateName;
  if (name) return name;
  const ct = job.wizardConfig?.contentType || job.contentType;
  if (ct) {
    return `${labelForContentType(ct)} (no wizard template selected)`;
  }
  return 'Custom job (no wizard template selected)';
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
