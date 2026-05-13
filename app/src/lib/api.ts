/**
 * AuraFlux API client — typed wrapper for all backend calls.
 * Uses the user's Clerk session token for auth on all requests.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public label?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = 'customer' | 'operator' | 'admin';
export type PlanTier = 'operate' | 'guided' | 'managed' | 'custom';

export type PortalStatus = 'pending' | 'running' | 'pass' | 'hold' | 'failed' | 'skipped';

export interface PortalReport {
  portal:  string;
  status:  PortalStatus;
  passed:  boolean;
  score?:  number;
  notes?:  string[];
}

export type PublishMode = 'immediate' | 'scheduled';

export interface WizardConfig {
  formFactor:     'long' | 'short' | string | null;
  templateId:     string | null;
  contentType:    string | null;
  entryType:      string | null;
  addOns:         string[];   // e.g. ['tts', 'heygen', 'shoppable']
  platforms:      string[];
  publishMode:    PublishMode;
  scheduledAt:    string | null;
  productionPath: string | null;
}

export interface PublishResult {
  platform:      string;
  platformJobId: string | null;
  driveUrl:      string | null;
  title:         string | null;
  status:        'pending' | 'published' | 'failed';
  publishedAt:   string | null;
}

export interface Job {
  jobId:               string;
  contentType:         string;
  entryType:           'fetch' | 'upload' | 'create';
  status:              'queued' | 'running' | 'complete' | 'failed' | 'held';
  customerId:          string;
  planTier:            PlanTier;
  publishMode:         PublishMode;
  scheduledPublishAt?: string | null;
  scheduledStartAt?:   string | null;
  templateId?:         string | null;
  templateName?:       string | null;
  createdAt:           string;
  updatedAt:           string;
  platforms:           string[];
  portalReports?:      PortalReport[];
  outputUrl?:          string;
  thumbnailUrl?:       string;
  publishCopy?: {
    youtube?:   { title?: string; description?: string; tags?: string[] };
    tiktok?:    { caption?: string; hashtags?: string[] };
    instagram?: { caption?: string; hashtags?: string[] };
  };
  wizardConfig?:   WizardConfig;
  publishResults?: PublishResult[];
}

export interface CreateJobPayload {
  contentType:      string;
  entryType:        'fetch' | 'upload' | 'create';
  platforms:        string[];
  fetchSpec?:       { sourceUrls: string[] };
  uploadSpec?:      { fileKeys: string[] };
  createSpec?:      { promptText: string };
  publishMode?:     PublishMode;
  scheduledPublishAt?: string;
  // CPD-110: wizard fields (platform-agnostic job creation)
  formFactor?:      'long' | 'short' | null;
  productionPath?:  string | null;
  features?:        string[];
  extensions?:      string[];  // add-on extensions: 'heygen', 'shoppable'
  // CPD-115: duration-based credit estimation
  durationMins?:    number;
  // CPD-131: content context — used by script generation and portal QA
  topic?:           string;
  tone?:            string;
}

// ─── Credit estimation ────────────────────────────────────────────────────────

export interface CreditEstimate {
  credits:   number;
  breakdown: Record<string, number>;
  message:   string; // Collab-ready summary
}

const CREDIT_RATES = {
  base:                10,
  tts_per_min:          1,
  wan_t2v_per_min:      6,
  heygen_per_min:     120,
  shoppable_per_min:    2,
  script:              10,
  research:            10,
  content_fetch:       10,
  vectcut_thumbnail:   10,
  narrative_clip:      10,
  imagen_thumbnail:    20,
};

// CPD-128: plan-tier discounts on AI production rates
const TIER_DISCOUNT: Record<string, number> = {
  diy:    1.00,
  dwy:    0.90,
  dfy:    0.75,
  custom: 0.70,
};

export function estimateCreditCost({
  durationMins   = 1,
  features       = [] as string[],
  extensions     = [] as string[],
  sourceMode     = '' as string,
  planTier       = 'operate' as string,
}: {
  durationMins?:  number;
  features?:      string[];
  extensions?:    string[];
  sourceMode?:    string;
  planTier?:      string;
}): CreditEstimate {
  const dur      = Math.max(0.1, durationMins);
  const discount = TIER_DISCOUNT[planTier] ?? 1.0;
  const ai       = (rate: number) => Math.ceil(rate * dur * discount);

  const hasTts    = features.includes('tts');
  const hasWan    = features.includes('generation');
  const hasHeygen = extensions.includes('heygen') || extensions.includes('heygen_iv');

  let aiFeatureCost = 0;
  let aiLabel = '';
  if (hasHeygen) {
    aiFeatureCost = ai(CREDIT_RATES.heygen_per_min);
    aiLabel = 'Avatar IV';
  } else if (hasWan) {
    aiFeatureCost = ai(CREDIT_RATES.wan_t2v_per_min);
    aiLabel = 'AI video gen';
  } else if (hasTts) {
    aiFeatureCost = ai(CREDIT_RATES.tts_per_min);
    aiLabel = 'TTS narration';
  }

  const breakdown: Record<string, number> = {
    base:      CREDIT_RATES.base,  // no discount on base
    ai:        aiFeatureCost,
    script:    features.includes('script')      ? CREDIT_RATES.script    : 0,
    shoppable: extensions.includes('shoppable') ? ai(CREDIT_RATES.shoppable_per_min) : 0,
  };

  const credits = Object.values(breakdown).reduce((s, v) => s + v, 0);

  const parts: string[] = [];
  if (aiFeatureCost > 0) parts.push(`${aiFeatureCost} ${aiLabel}`);
  if (breakdown.script > 0) parts.push(`${breakdown.script} script`);
  if (breakdown.shoppable > 0) parts.push(`${breakdown.shoppable} shoppable`);
  const discountNote = discount < 1 ? ` (${Math.round((1 - discount) * 100)}% ${planTier.toUpperCase()} discount applied)` : '';

  const message = parts.length
    ? `${credits} credits total — ${CREDIT_RATES.base} base + ${parts.join(' + ')}${discountNote}.`
    : `${credits} credits (base job, no AI features selected)${discountNote}.`;

  return { credits, breakdown, message };
}

export interface PortalContract {
  portal:      string;
  label:       string;
  description: string;
  required:    Array<{ field: string; type: string; rule: string }>;
  conditional?: Array<{ field: string; condition: string; rule: string }>;
  limits?:     Array<{ field: string; max?: number; min?: number; unit: string; note?: string }>;
  minPlan?:    string;
}

export interface ValidationResult {
  overall:        'pass' | 'partial' | 'fail';
  readyPortals:   string[];
  blockedPortals: string[];
  portals:        Array<{
    portal:      string;
    label:       string;
    ready:       boolean;
    missing:     Array<{ field: string; type: string; rule: string }>;
    suggestions: string[];
  }>;
}

export interface ChatMessage {
  role:    'user' | 'assistant';
  content: string;
}

export interface ClipCandidate {
  id:                 string;
  footagePath:        string;
  startTime:          number;
  duration:           number;
  description:        string;
  tags:               string[];
  relevanceScore:     number;
  suggestedForSegment: number | null;
  status:             'pending' | 'approved' | 'rejected';
  _isStub?:           boolean;
}

// ─── Core fetch helper ────────────────────────────────────────────────────────

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...init } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  const body = await res.json().catch(() => ({})) as { ok: boolean; error?: string; label?: string } & T;

  if (!res.ok) {
    throw new ApiError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      (body as { label?: string }).label,
    );
  }

  return body;
}

// ─── Concierge API ────────────────────────────────────────────────────────────

export async function getPortalContracts(token?: string): Promise<{ contracts: PortalContract[] }> {
  return apiFetch('/concierge/portal-contracts', { token });
}

export async function validateJobSpec(
  spec: Record<string, unknown>,
  token?: string,
): Promise<ValidationResult> {
  const res = await apiFetch<{ ok: boolean } & ValidationResult>('/concierge/validate', {
    method: 'POST',
    body:   JSON.stringify({ spec }),
    token,
  });
  return res;
}

export async function chatWithConcierge(
  messages: ChatMessage[],
  spec?: Record<string, unknown>,
  planTier?: string,
  token?: string,
): Promise<{ response: string }> {
  return apiFetch('/concierge/chat', {
    method: 'POST',
    body:   JSON.stringify({ messages, spec, planTier }),
    token,
  });
}

export async function getScheduleSuggestion(
  opts: { templates?: { name: string; contentType?: string | null }[]; platforms?: string[]; goals?: string; days?: number },
  token?: string,
): Promise<{ ok: boolean; suggestion: string }> {
  return apiFetch('/concierge/schedule-suggest', {
    method: 'POST',
    body:   JSON.stringify(opts),
    token,
  });
}

// ─── Clip sourcing API ────────────────────────────────────────────────────────

export async function suggestClips(
  jobId: string,
  payload: { showTitle: string; footagePath: string; script?: string; keywords?: string[] },
  token?: string,
): Promise<{ candidates: ClipCandidate[]; requiresApproval: boolean; suggestedAt: string }> {
  return apiFetch(`/jobs/${jobId}/clip-candidates`, {
    method: 'POST',
    body:   JSON.stringify(payload),
    token,
  });
}

export async function approveClips(
  jobId: string,
  approvedIds: string[],
  footageStorageKey?: string,
  token?: string,
): Promise<{ approved: ClipCandidate[]; clipManifest: unknown[] }> {
  return apiFetch(`/jobs/${jobId}/clip-candidates/approve`, {
    method: 'POST',
    body:   JSON.stringify({ approvedIds, footageStorageKey }),
    token,
  });
}

// ─── Jobs API ─────────────────────────────────────────────────────────────────

export async function listJobs(token?: string): Promise<{ jobs: Job[] }> {
  return apiFetch('/jobs', { token });
}

export async function listAllJobs(token?: string, customerId?: string): Promise<{ jobs: Job[] }> {
  const qs = customerId ? `?all=true&customerId=${encodeURIComponent(customerId)}` : '?all=true';
  return apiFetch(`/jobs${qs}`, { token });
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface CustomerRecord {
  id:         string;
  email:      string | null;
  firstName:  string | null;
  lastName:   string | null;
  role:       UserRole;
  planTier:   PlanTier;
  credits:    number | null;
  createdAt:  string | null;
  jobCount:   number;
  lastJobAt:  string | null;
}

export async function listCustomers(token?: string): Promise<{ customers: CustomerRecord[] }> {
  return apiFetch('/admin/customers', { token });
}

// ─── Admin Activity Overview (CPD-177) ───────────────────────────────────────

export interface ActivityStats {
  totalJobs:       number;
  running:         number;
  complete:        number;
  published:       number;
  failed:          number;
  jobs7d:          number;
  accountsWithJobs: number;
  credits30d:      number;
}

export interface ActivityFeedItem {
  id:           string;
  customerId:   string;
  email:        string;
  contentType:  string;
  status:       string;
  topic:        string | null;
  durationMins: number | null;
  createdAt:    string | null;
}

export interface AccountActivity {
  customerId:     string;
  email:          string | null;
  firstName:      string | null;
  lastName:       string | null;
  role:           string;
  planTier:       string;
  jobCount:       number;
  publishedCount: number;
  runningCount:   number;
  failedCount:    number;
  jobs7d:         number;
  lastJobAt:      string | null;
}

export interface ActivityOverview {
  ok:       boolean;
  stats:    ActivityStats;
  feed:     ActivityFeedItem[];
  accounts: AccountActivity[];
}

export async function getActivityOverview(token?: string): Promise<ActivityOverview> {
  return apiFetch('/admin/activity-overview', { token });
}

// ─── Admin CRM (CPD-154) ──────────────────────────────────────────────────────

export async function listCrmAccounts(token?: string) {
  return apiFetch<{ ok: boolean; accounts: unknown[] }>('/admin/crm', { token });
}

export async function getCrmAccount(accountId: string, token?: string) {
  return apiFetch<Record<string, unknown>>(`/admin/crm/${accountId}`, { token });
}

// ─── Admin Permissions (CPD-150) ─────────────────────────────────────────────

export async function listPermissions(token?: string) {
  return apiFetch<{ ok: boolean; accounts: unknown[] }>('/admin/permissions', { token });
}

export async function warpIntoAccount(userId: string, token?: string) {
  return apiFetch<{ ok: boolean; url: string }>(`/admin/warp/${userId}`, {
    method: 'POST',
    token,
  });
}

export async function getJob(jobId: string, token?: string): Promise<{ job: Job }> {
  return apiFetch(`/jobs/${jobId}`, { token });
}

export async function createJob(
  payload: CreateJobPayload,
  token?: string,
): Promise<{ jobId: string; job: Job }> {
  return apiFetch('/jobs', { method: 'POST', body: JSON.stringify(payload), token });
}

export async function getJobDetail(jobId: string, token?: string): Promise<{ job: Job }> {
  return apiFetch(`/jobs/${jobId}`, { token });
}

export async function updateJobSchedule(
  jobId: string,
  publishMode: PublishMode,
  scheduledPublishAt?: string,
  token?: string,
  scheduledStartAt?: string | null,
): Promise<{ ok: boolean; jobId: string; publishMode: PublishMode; scheduledPublishAt: string | null }> {
  return apiFetch(`/jobs/${jobId}/schedule`, {
    method: 'PUT',
    body:   JSON.stringify({ publishMode, scheduledPublishAt, scheduledStartAt }),
    token,
  });
}

export async function saveJobAsTemplate(
  jobId: string,
  name: string,
  opts: { description?: string; recurrenceType?: string; recurrenceDay?: number; recurrenceTime?: string } = {},
  token?: string,
): Promise<{ template: JobTemplate }> {
  return apiFetch(`/jobs/${jobId}/save-as-template`, {
    method: 'POST',
    body:   JSON.stringify({ name, ...opts }),
    token,
  });
}

// ─── Templates API ────────────────────────────────────────────────────────────

export type RecurrenceType = 'once' | 'daily' | 'weekly' | 'monthly';

export interface JobTemplate {
  id:               string;
  name:             string;
  description?:     string | null;
  contentType?:     string | null;
  platforms:        string[];
  jobSpec:          Record<string, unknown>;
  recurrenceType?:  RecurrenceType | null;
  recurrenceDay?:   number | null;
  recurrenceTime?:  string | null;
  recurrenceActive: boolean;
  nextFireAt?:      string | null;
  lastFiredAt?:     string | null;
  createdAt:        string;
  updatedAt:        string;
}

export async function listTemplates(token?: string): Promise<{ templates: JobTemplate[] }> {
  return apiFetch('/templates', { token });
}

export async function getTemplateById(templateId: string, token?: string): Promise<{ template: JobTemplate }> {
  return apiFetch(`/templates/${templateId}`, { token });
}

export async function createTemplate(
  payload: { name: string; description?: string; contentType?: string; platforms?: string[];
             jobSpec: Record<string, unknown>; recurrenceType?: string;
             recurrenceDay?: number; recurrenceTime?: string },
  token?: string,
): Promise<{ template: JobTemplate }> {
  return apiFetch('/templates', { method: 'POST', body: JSON.stringify(payload), token });
}

export async function updateTemplate(
  templateId: string,
  patch: Partial<Pick<JobTemplate, 'name' | 'description' | 'recurrenceType' | 'recurrenceDay' | 'recurrenceTime' | 'recurrenceActive'>>,
  token?: string,
): Promise<{ template: JobTemplate }> {
  return apiFetch(`/templates/${templateId}`, { method: 'PUT', body: JSON.stringify(patch), token });
}

export async function deleteTemplate(templateId: string, token?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/templates/${templateId}`, { method: 'DELETE', token });
}

// ─── Plan features API ────────────────────────────────────────────────────────

export interface PlanFeatureMatrix {
  [featureKey: string]: {
    label:       string;
    description: string;
    min_plan:    PlanTier;
    plans:       Record<PlanTier, boolean>;
  };
}

export async function getPlanFeatures(token?: string): Promise<{ features: PlanFeatureMatrix }> {
  return apiFetch('/plan/features', { token });
}

// ─── Credits API ──────────────────────────────────────────────────────────────

export interface CreditBalance {
  clientId:            string;
  included_remaining:  number;
  included_total:      number;
  pack_remaining:      number;
  overage_used:        number;
  overage_cap:         number | null;
  overage_price_cents: number;
  tier:                PlanTier;
  period_start:        string;
  period_end:          string;
}

export interface CreditLedgerEntry {
  id:          number;
  job_id:      string | null;
  type:        'included' | 'pack' | 'overage' | 'refund';
  credits:     number;
  description: string | null;
  created_at:  string;
}

export interface CreditPack {
  id:        string;
  label:     string;
  credits:   number;
  price_usd: number;
}

export async function getCreditBalance(token?: string): Promise<CreditBalance & { ok: boolean }> {
  return apiFetch('/credits/balance', { token });
}

export async function getCreditHistory(
  limit = 20,
  offset = 0,
  token?: string,
): Promise<{ ok: boolean; entries: CreditLedgerEntry[]; total: number }> {
  return apiFetch(`/credits/history?limit=${limit}&offset=${offset}`, { token });
}

export async function getCreditPacks(token?: string): Promise<{ ok: boolean; packs: CreditPack[] }> {
  return apiFetch('/credits/packs', { token });
}

export interface Plan {
  id:               PlanTier;
  label:            string;
  credits:          number;
  price_usd:        number;
  description:      string;
  priceConfigured:  boolean;
}

export async function getPlans(token?: string): Promise<{ ok: boolean; plans: Plan[] }> {
  return apiFetch('/plans', { token });
}

export async function subscribeToPlan(
  planId: string,
  successUrl: string,
  cancelUrl: string,
  token?: string,
): Promise<{ ok: boolean; url: string }> {
  return apiFetch('/plans/subscribe', {
    method: 'POST',
    body:   JSON.stringify({ planId, successUrl, cancelUrl }),
    token,
  });
}

export async function purchasePack(
  packId: string,
  successUrl: string,
  cancelUrl: string,
  token?: string,
): Promise<{ ok: boolean; checkoutUrl: string; sessionId: string }> {
  return apiFetch('/credits/purchase-pack', {
    method: 'POST',
    body:   JSON.stringify({ packId, successUrl, cancelUrl }),
    token,
  });
}

export async function getBillingPortalUrl(
  returnUrl: string,
  token?: string,
): Promise<{ ok: boolean; url: string }> {
  return apiFetch('/plans/billing-portal', {
    method: 'POST',
    body:   JSON.stringify({ returnUrl }),
    token,
  });
}

// ─── Video generation (Wan / RunPod) ─────────────────────────────────────────

export interface GenerateVideoPayload {
  prompt:          string;
  negativePrompt?: string;
  width?:          number;
  height?:         number;
  numFrames?:      number;
  seed?:           number;
}

export interface GenerateVideoQueued {
  promptId:     string;
  outputPrefix: string;
  status:       'queued';
}

export interface GenerateVideoResult {
  status:  'running' | 'success' | 'error';
  files?:  { filename: string; url: string }[];
  error?:  string;
}

export async function generateVideo(
  payload: GenerateVideoPayload,
  token?: string,
): Promise<GenerateVideoQueued> {
  return apiFetch('/api/generate-video', {
    method: 'POST',
    body:   JSON.stringify(payload),
    token,
  });
}

export async function pollVideoStatus(
  promptId: string,
  token?: string,
): Promise<GenerateVideoResult> {
  return apiFetch(`/api/generate-video/${promptId}`, { token });
}

// ─── Social / direct platform publishing (CPD-86) ────────────────────────────

export type SocialPlatform = 'youtube' | 'tiktok' | 'instagram';

export interface ConnectedAccount {
  platform:       SocialPlatform;
  handle:         string | null;
  platformUserId: string | null;
  tokenExpiry:    string | null;
  connectedAt:    string;
}

export async function listConnectedAccounts(token?: string): Promise<{ ok: boolean; accounts: ConnectedAccount[] }> {
  return apiFetch('/social/accounts', { token });
}

export async function disconnectPlatform(platform: SocialPlatform, token?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/social/accounts/${platform}`, { method: 'DELETE', token });
}

/** Returns the OAuth redirect URL to connect a platform. Opens in same window. */
export function getSocialConnectUrl(platform: SocialPlatform): string {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
  return `${base}/social/connect/${platform}`;
}

// ─── Operator job actions (CPD-104) ──────────────────────────────────────────

export type OperatorAction = 'retry' | 'advance' | 'rollback';

export async function operatorJobAction(
  jobId: string,
  action: OperatorAction,
  token?: string,
): Promise<{ ok: boolean; jobId: string; action: OperatorAction; previousStatus?: string; advancedPortal?: string }> {
  return apiFetch(`/jobs/${jobId}/${action}`, { method: 'POST', token });
}

// ─── Support (CPD-115) ───────────────────────────────────────────────────────

export interface SupportMessage {
  id:         string;
  session_id: string;
  user_id:    string;
  role:       'user' | 'assistant';
  content:    string;
  channel:    'web' | 'sms';
  created_at: number;
}

export interface SupportSession {
  id:                 string;
  user_id:            string;
  phone_number:       string | null;
  created_at:         number;
  resolved:           boolean;
  escalated:          boolean;
  escalation_channel: string | null;
  message_count:      number;
}

export async function supportChat(
  messages: { role: string; content: string }[],
  sessionId: string | null,
  token?: string,
): Promise<{ ok: boolean; response: string; sessionId: string }> {
  return apiFetch('/support/chat', {
    method: 'POST',
    body:   JSON.stringify({ messages, sessionId }),
    token,
  });
}

export async function getSupportSessions(token?: string): Promise<{ ok: boolean; sessions: SupportSession[] }> {
  return apiFetch('/support/sessions', { token });
}

export async function getSupportSessionMessages(
  sessionId: string,
  token?: string,
): Promise<{ ok: boolean; messages: SupportMessage[] }> {
  return apiFetch(`/support/sessions/${sessionId}`, { token });
}

export async function resolveSupportSession(sessionId: string, token?: string): Promise<{ ok: boolean }> {
  return apiFetch(`/support/sessions/${sessionId}/resolve`, { method: 'POST', token });
}

export async function escalateSupportSession(
  payload: { sessionId: string | null; summary: string; userName: string; userEmail: string },
  token?: string,
): Promise<{ ok: boolean; message?: string }> {
  return apiFetch('/support/escalate', {
    method: 'POST',
    body:   JSON.stringify(payload),
    token,
  });
}

// ─── Job validation ───────────────────────────────────────────────────────────

export async function validatePublishCopy(
  jobId: string,
  publishCopy?: Record<string, unknown>,
  token?: string,
): Promise<{ violations: unknown[]; sanitized: unknown }> {
  return apiFetch(`/jobs/${jobId}/validate-publish`, {
    method: 'POST',
    body:   JSON.stringify({ publishCopy }),
    token,
  });
}
