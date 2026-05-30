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

export type UserRole = 'customer' | 'superadmin';
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

export type RecurrenceType = 'once' | 'daily' | 'weekly' | 'monthly';

export interface WizardConfig {
  formFactor:     'long' | 'short' | string | null;
  templateId:     string | null;
  contentType:    string | null;
  entryType:      string | null;
  addOns:         string[];
  activeFeatures: string[];
  platforms:      string[];
  publishMode:    PublishMode;
  scheduledAt:    string | null;
  productionPath: string | null;
  topic?:         string | null;
  tone?:          string | null;
  durationMins?:  number | null;
  planTier?:      string | null;
  creditCost?:    number | null;
}

export interface PublishResult {
  platform:      string;
  platformJobId: string | null;
  driveUrl:      string | null;
  error?:        string | null;
  title:         string | null;
  status:        'pending' | 'published' | 'failed';
  publishedAt:   string | null;
}

export interface Job {
  jobId:               string;
  contentType:         string;
  entryType:           'fetch' | 'upload' | 'create';
  status:              'queued' | 'running' | 'complete' | 'failed' | 'held' | 'staged' | 'published' | 'cancelled' | 'queued_scheduled' | 'credit_paused';
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
  filledScript?:   string | null;
}

export interface CreateJobPayload {
  contentType:      string;
  entryType:        'fetch' | 'upload' | 'create';
  platforms:        string[];
  fetchSpec?: {
    sourceUrls:     string[];
    stitchMode?:    boolean;
    sourceLibrary?: Array<{
      url: string; title?: string; duration?: number;
      thumbnailUrl?: string; platform?: string; contentType?: string;
    }>;
    /** ClipEditor output — trim/extract timestamps, clip order, per-clip overrides */
    clipSpec?: {
      mode:             'extract' | 'compact';
      clips:            unknown[];
      uniformFeatures:  boolean;
      featureOverrides: Record<string, Record<string, boolean>>;
    };
  };
  uploadSpec?:      { fileKeys: string[] };
  createSpec?:      { promptText: string };
  publishMode?:     PublishMode;
  scheduledPublishAt?: string;
  scheduledStartAt?: string;
  recurringTemplate?: {
    name?: string;
    recurrenceType: RecurrenceType;
    recurrenceDay?: number;
    recurrenceTime?: string;
  };
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
  // Feature-level configuration: keyed by feature ID (script, tts, commentary, generation, burn_images)
  featureConfig?:   Record<string, Record<string, string>>;
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
  operate:    1.00,
  guided:    0.90,
  managed:    0.75,
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

// ─── Brand context (CPD-329) ──────────────────────────────────────────────────
// Module-level active brand ID injected by BrandContext so all apiFetch calls
// automatically include X-Brand-Id when a brand is active.
let _activeBrandId: string | null = null;

export function setActiveBrandId(id: string | null): void {
  _activeBrandId = id;
}

export function getActiveBrandId(): string | null {
  return _activeBrandId;
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
    ...(_activeBrandId ? { 'X-Brand-Id': _activeBrandId } : {}),
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
  id:           string;
  email:        string | null;
  firstName:    string | null;
  lastName:     string | null;
  role:         UserRole;
  planTier:     PlanTier;
  credits:      number | null;
  createdAt:    string | null;
  jobCount:     number;
  lastJobAt:    string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
}

export async function listCustomers(token?: string): Promise<{ customers: CustomerRecord[] }> {
  return apiFetch('/admin/crm', { token });
}

// ─── Admin All Users (Clerk registry) ────────────────────────────────────────

export interface AdminUser {
  id:           string;
  email:        string | null;
  firstName:    string | null;
  lastName:     string | null;
  role:         string;
  planTier:     string;
  hasAccount:   boolean;
  jobCount:     number;
  lastJobAt:    string | null;
  signedUpAt:   string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
}

export async function listAllUsers(token?: string): Promise<{ total: number; users: AdminUser[] }> {
  return apiFetch('/admin/users', { token });
}

export async function setUserRole(
  userId: string,
  role: 'customer' | 'superadmin',
  token?: string,
): Promise<{ ok: boolean; userId: string; role: string; email: string | null }> {
  return apiFetch(`/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
    token,
  });
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
  lastSignInAt:   string | null;
  lastActiveAt:   string | null;
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

// ─── Admin System Health (CPD-177) ────────────────────────────────────────────

export interface NrIncident {
  issueId:     string;
  title:       string;
  priority:    string;
  state:       string;
  createdAt:   string;
  updatedAt:   string;
  entityNames: string[];
  sources:     string[];
}

export interface RenderDeploy {
  id:         string;
  status:     string;
  commit:     string | null;
  finishedAt: string | null;
}

export interface RenderService {
  id:             string;
  name:           string;
  type:           string;
  suspended:      string | null;
  url:            string | null;
  deploy:         RenderDeploy | null;
  previousDeploy: { status: string; finishedAt: string | null } | null;
}

export interface NrMetrics {
  errorRate:  Record<string, number | null>;
  throughput: Record<string, number | null>;
  latencyMs:  Record<string, number | null>;
  apdex:      Record<string, number | null>;
  jsErrors:   Record<string, number | null>;
  errors24h:  Record<string, number | null>;
}

export interface SystemHealth {
  ok:             boolean;
  generatedAt:    string;
  incidents:      NrIncident[];
  nrMetrics:      NrMetrics;
  renderServices: RenderService[];
}

export async function getSystemHealth(token?: string): Promise<SystemHealth> {
  return apiFetch('/admin/system-health', { token });
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
): Promise<{ jobId?: string; job?: Job; templateId?: string; templateOnly?: boolean; status: string; scheduledStartAt?: string; message?: string }> {
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
  clientId:               string;
  included_remaining:     number;
  included_total:         number;
  pack_remaining:         number;
  overage_used:           number;
  overage_cap:            number | null;
  overage_price_cents:    number;
  tier:                   PlanTier;
  period_start:           string;
  period_end:             string;
  stripe_subscription_id: string | null;
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
  id:              string;
  label:           string;
  credits:         number;
  price_usd:       number;
  price_cents:     number;
  description:     string;
  feature:         string;
  mins:            number;
  rate_per_min:    number;
  priceConfigured: boolean;
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
  brandId?: string | null,  // CPD-328: brand context for multi-brand subscriptions
): Promise<{ ok: boolean; url: string }> {
  return apiFetch('/plans/subscribe', {
    method: 'POST',
    body:   JSON.stringify({ planId, successUrl, cancelUrl, ...(brandId ? { brandId } : {}) }),
    token,
  });
}

export async function purchasePack(
  packId: string,
  successUrl: string,
  cancelUrl: string,
  token?: string,
  quantity = 1,
): Promise<{ ok: boolean; checkoutUrl: string; sessionId: string }> {
  return apiFetch('/credits/purchase-pack', {
    method: 'POST',
    body:   JSON.stringify({ packId, successUrl, cancelUrl, quantity }),
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

// ─── Native billing (CPD-336) ────────────────────────────────────────────────

export interface PaymentMethod {
  id:       string;
  brand:    string;
  last4:    string;
  expMonth: number;
  expYear:  number;
}

export interface Invoice {
  id:          string;
  number:      string | null;
  date:        number;
  amountDue:   number;
  amountPaid:  number;
  currency:    string;
  status:      string;
  pdfUrl:      string | null;
  hostedUrl:   string | null;
  description: string | null;
}

export async function getPaymentMethod(token?: string): Promise<{ ok: boolean; paymentMethod: PaymentMethod | null }> {
  return apiFetch('/billing/payment-method', { token });
}

export async function createSetupIntent(token?: string): Promise<{ ok: boolean; clientSecret: string }> {
  return apiFetch('/billing/setup-intent', { method: 'POST', token });
}

export async function updatePaymentMethod(paymentMethodId: string, token?: string): Promise<{ ok: boolean }> {
  return apiFetch('/billing/payment-method', {
    method: 'POST',
    body:   JSON.stringify({ paymentMethodId }),
    token,
  });
}

export async function getInvoices(token?: string): Promise<{ ok: boolean; invoices: Invoice[] }> {
  return apiFetch('/billing/invoices', { token });
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

// ─── Customer approve-publish (staged → published) ───────────────────────────

export async function approveAndPublish(
  jobId: string,
  platforms?: string[],
  token?: string,
): Promise<{ ok: boolean; jobId: string; approved: boolean; platforms: Record<string, unknown> }> {
  return apiFetch(`/jobs/${jobId}/approve-publish`, {
    method: 'POST',
    token,
    body: platforms ? JSON.stringify({ platforms }) : undefined,
  });
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
  user_name:          string | null;
  phone_number:       string | null;
  created_at:         number;
  resolved:           boolean;
  escalated:          boolean;
  escalation_channel: string | null;
  message_count:      number;
  last_message_at:    number | null;
  last_message_preview: string | null;
  human_took_over:    boolean;
  operator_id:        string | null;
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

// ─── Operator support inbox (CPD-310) ────────────────────────────────────────

export async function listAllSupportSessions(
  opts: { open?: boolean; limit?: number } = {},
  token?: string,
): Promise<{ ok: boolean; sessions: SupportSession[] }> {
  const params = new URLSearchParams();
  if (opts.open) params.set('open', '1');
  if (opts.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/admin/support/sessions?${params}`, { token });
}

export async function getOperatorSessionMessages(
  sessionId: string,
  token?: string,
): Promise<{ ok: boolean; session: SupportSession; messages: SupportMessage[] }> {
  return apiFetch(`/admin/support/sessions/${sessionId}`, { token });
}

export async function sendOperatorReply(
  sessionId: string,
  message: string,
  token?: string,
): Promise<{ ok: boolean; channel: string }> {
  return apiFetch(`/support/sessions/${sessionId}/reply`, {
    method: 'POST',
    body:   JSON.stringify({ message }),
    token,
  });
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface AppNotification {
  id:        number;
  type:      string;
  title:     string;
  body:      string;
  actionUrl: string | null;
  read:      boolean;
  createdAt: string;
}

export async function listNotifications(
  token?: string,
): Promise<{ ok: boolean; notifications: AppNotification[] }> {
  return apiFetch('/notifications', { token });
}

export async function markNotificationRead(
  id: number,
  token?: string,
): Promise<{ ok: boolean }> {
  return apiFetch(`/notifications/${id}/read`, { method: 'PATCH', token });
}

export async function markAllNotificationsRead(
  token?: string,
): Promise<{ ok: boolean }> {
  return apiFetch('/notifications/read-all', { method: 'PATCH', token });
}

// ─── Source library (Browse My Channels) ─────────────────────────────────────

export type SourceDateRange = '24h' | '7d' | '30d' | 'all';
export type SourceType      = 'all' | 'vod' | 'clip' | 'short' | 'video';

export interface SourceFilters {
  dateRange?:   SourceDateRange;
  type?:        SourceType;
  minDuration?: number;
  maxDuration?: number;
  keyword?:     string;
  playlistId?:  string;
}

export interface SourceItem {
  id:            string;
  title:         string;
  thumbnailUrl:  string | null;
  duration:      number;
  url:           string;
  type:          SourceType;
  contentType?:  string;
  publishedAt?:  string;
  viewCount:     number;
  platform?:     SourcePlatform;
}

export interface SourcePlaylist {
  id:    string;
  title: string;
  itemCount?: number;
}

export async function fetchSourceContent(
  platform: SourcePlatform,
  handle: string,
  limit = 50,
  token?: string,
  filters?: SourceFilters,
): Promise<{ ok: boolean; channel: ResolvedChannel; items: SourceItem[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters?.dateRange && filters.dateRange !== 'all') params.set('after', filters.dateRange);
  if (filters?.minDuration != null) params.set('minDuration', String(filters.minDuration));
  if (filters?.maxDuration != null) params.set('maxDuration', String(filters.maxDuration));
  if (filters?.type)        params.set('type',        filters.type);
  if (filters?.playlistId)  params.set('playlistId',  filters.playlistId);
  return apiFetch(`/source/${platform}/${encodeURIComponent(handle)}/content?${params}`, { token });
}

export async function fetchYouTubePlaylists(
  handle: string,
  token?: string,
): Promise<{ ok: boolean; channel: ResolvedChannel; playlists: SourcePlaylist[] }> {
  return apiFetch(`/source/youtube/${encodeURIComponent(handle)}/playlists`, { token });
}

// ─── Source channels (My Channels settings) ──────────────────────────────────

export interface SourceChannels {
  twitchLogin?:   string;
  kickUsername?:  string;
  youtubeHandle?: string;
}

export type SourcePlatform = 'twitch' | 'kick' | 'youtube';

export interface ResolvedChannel {
  id?:           string;
  username?:     string;
  displayName?:  string;
  name?:         string;
  title?:        string;
  avatarUrl?:    string;
  thumbnailUrl?: string;
}

export async function getSourceChannels(
  token?: string,
): Promise<{ ok: boolean; sourceChannels: SourceChannels }> {
  return apiFetch('/account/source-channels', { token });
}

export async function saveSourceChannels(
  channels: SourceChannels,
  token?: string,
): Promise<{ ok: boolean; sourceChannels: SourceChannels }> {
  return apiFetch('/account/source-channels', {
    method: 'PATCH',
    body:   JSON.stringify(channels),
    token,
  });
}

export async function resolveSourceChannel(
  platform: SourcePlatform,
  handle: string,
  token?: string,
): Promise<{ ok: boolean; channel: ResolvedChannel }> {
  const encoded = encodeURIComponent(handle);
  return apiFetch(`/source/${platform}/${encoded}/resolve`, { token });
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

// ─── Canva Image Generation (superadmin) ─────────────────────────────────────

export type CanvaDesignType =
  | 'business_card' | 'card' | 'desktop_wallpaper' | 'doc' | 'document'
  | 'email' | 'facebook_cover' | 'facebook_post' | 'flyer' | 'infographic'
  | 'instagram_post' | 'invitation' | 'logo' | 'phone_wallpaper' | 'photo_collage'
  | 'pinterest_pin' | 'postcard' | 'poster' | 'presentation' | 'proposal'
  | 'report' | 'resume' | 'twitter_post' | 'your_story' | 'youtube_banner'
  | 'youtube_thumbnail';

export interface CanvaCandidate {
  candidate_id: string;
  thumbnail_url: string;
  design_url:   string;
}

export interface CanvaGenerateResult {
  ok:         boolean;
  jobId:      string;
  candidates: CanvaCandidate[];
}

export interface CanvaSaveResult {
  ok:        boolean;
  designId?: string;
  designUrl: string;
}

// ─── Brand API (CPD-329) ──────────────────────────────────────────────────────

export interface Brand {
  id:                     string;
  account_id:             string;
  name:                   string;
  slug:                   string | null;
  created_at:             string;
  active:                 boolean;
  tier:                   PlanTier | null;
  credits_included:       number | null;
  stripe_subscription_id: string | null;
  image_url:              string | null;
  description:            string | null;
}

export interface BrandSubscription {
  brand_id:               string;
  brand_name:             string;
  brand_slug:             string | null;
  tier:                   PlanTier;
  stripe_subscription_id: string | null;
  credits_included:       number;
  next_billing_date:      string | null;
}

export async function getBrands(token?: string): Promise<Brand[]> {
  const res = await apiFetch<{ ok: boolean; brands: Brand[] }>('/brands', { token });
  return res.brands;
}

export async function createBrandApi(name: string, token?: string): Promise<Brand> {
  const res = await apiFetch<{ ok: boolean; brand: Brand }>('/brands', {
    method: 'POST',
    body:   JSON.stringify({ name }),
    token,
  });
  return res.brand;
}

export async function renameBrandApi(id: string, name: string, token?: string): Promise<Brand> {
  const res = await apiFetch<{ ok: boolean; brand: Brand }>(`/brands/${id}`, {
    method: 'PATCH',
    body:   JSON.stringify({ name }),
    token,
  });
  return res.brand;
}

export async function updateBrandApi(
  id: string,
  fields: { name?: string; image_url?: string | null; description?: string | null },
  token?: string,
): Promise<Brand> {
  const res = await apiFetch<{ ok: boolean; brand: Brand }>(`/brands/${id}`, {
    method: 'PATCH',
    body:   JSON.stringify(fields),
    token,
  });
  return res.brand;
}

export async function deleteBrandApi(id: string, token?: string): Promise<void> {
  await apiFetch(`/brands/${id}`, { method: 'DELETE', token });
}

export async function getBrandSubscriptions(token?: string): Promise<BrandSubscription[]> {
  const res = await apiFetch<{ ok: boolean; subscriptions: BrandSubscription[] }>('/billing/subscriptions', { token });
  return res.subscriptions;
}

export async function canvaGenerate(
  prompt: string,
  designType: CanvaDesignType,
  token?: string,
): Promise<CanvaGenerateResult> {
  return apiFetch('/admin/canva-generate', {
    method: 'POST',
    body:   JSON.stringify({ prompt, designType }),
    token,
  });
}

export async function canvaSave(
  jobId: string,
  candidateId: string,
  token?: string,
): Promise<CanvaSaveResult> {
  return apiFetch('/admin/canva-save', {
    method: 'POST',
    body:   JSON.stringify({ jobId, candidateId }),
    token,
  });
}

export interface AutoTopupSettings {
  enabled: boolean;
  pack: { id: string; label: string; credits: number };
}

export async function getAutoTopup(token?: string): Promise<AutoTopupSettings & { ok: boolean }> {
  return apiFetch("/credits/auto-topup", { token });
}

export async function setAutoTopup(enabled: boolean, token?: string): Promise<{ ok: boolean; enabled: boolean }> {
  return apiFetch("/credits/auto-topup", {
    method: "POST",
    body:   JSON.stringify({ enabled }),
    token,
  });
}
