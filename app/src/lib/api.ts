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
export type PlanTier = 'diy' | 'dwy' | 'dfy' | 'custom';

export type PortalStatus = 'pending' | 'running' | 'pass' | 'hold' | 'failed' | 'skipped';

export interface PortalReport {
  portal:  string;
  status:  PortalStatus;
  passed:  boolean;
  score?:  number;
  notes?:  string[];
}

export type PublishMode = 'immediate' | 'scheduled';

export interface Job {
  jobId:               string;
  contentType:         string;
  entryType:           'fetch' | 'upload' | 'create';
  status:              'queued' | 'running' | 'complete' | 'failed' | 'held';
  customerId:          string;
  planTier:            PlanTier;
  publishMode:         PublishMode;
  scheduledPublishAt?: string | null;
  createdAt:           string;
  updatedAt:           string;
  platforms:           string[];
  portalReports?:      PortalReport[];
  outputUrl?:          string;
  thumbnailUrl?:       string;
  publishCopy?: {
    youtube?: { title?: string };
    tiktok?:  { caption?: string };
  };
}

export interface CreateJobPayload {
  contentType:   string;
  entryType:     'fetch' | 'upload' | 'create';
  platforms:     string[];
  fetchSpec?:    { sourceUrls: string[] };
  uploadSpec?:   { fileKeys: string[] };
  createSpec?:   { promptText: string };
  publishMode?:  PublishMode;
  scheduledPublishAt?: string;
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

async function apiFetch<T>(
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

export async function listAllJobs(token?: string): Promise<{ jobs: Job[] }> {
  return apiFetch('/jobs?all=true', { token });
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
