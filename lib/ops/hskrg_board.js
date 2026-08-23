'use strict';

/**
 * HSKRG Work board client — https://hskrg-work.vercel.app
 * Auth: HSKRG_AGENT_API_KEY + x-org-id (see .cursor/rules/hskrg-board-workflow.mdc)
 */

const DEFAULT_BASE = 'https://hskrg-work.vercel.app';

function boardBaseUrl() {
  return (process.env.HSKRG_WORK_BASE_URL || process.env.HSKRG_WORK_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function agentApiKey() {
  return (process.env.HSKRG_AGENT_API_KEY || '').trim();
}

async function boardFetch(path, { method = 'GET', orgId, body } = {}) {
  const key = agentApiKey();
  if (!key) return { ok: false, status: 0, error: 'HSKRG_AGENT_API_KEY missing' };

  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  if (orgId) headers['x-org-id'] = orgId;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${boardBaseUrl()}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error || text.slice(0, 500),
      data,
    };
  }
  return { ok: true, status: res.status, data };
}

async function resolveOrgId() {
  const explicit = (process.env.HSKRG_ORG_ID || '').trim();
  if (explicit) return explicit;

  const slug = (process.env.HSKRG_ORG_SLUG || 'auraflux').trim();
  const res = await boardFetch('/api/orgs');
  if (!res.ok) throw new Error(`HSKRG org list failed: ${res.error || res.status}`);

  const org = (res.data?.organizations || []).find(o => o.slug === slug);
  if (!org) throw new Error(`HSKRG org not found for slug "${slug}"`);
  return org.id;
}

async function resolvePlatformProjectId(orgId) {
  const explicit = (process.env.HSKRG_PROJECT_ID || '').trim();
  if (explicit) return explicit;

  const res = await boardFetch(`/api/projects?orgId=${encodeURIComponent(orgId)}`, { orgId });
  if (!res.ok) throw new Error(`HSKRG project list failed: ${res.error || res.status}`);

  const project = (res.data?.projects || []).find(p => p.title === 'Platform' && p.active !== false);
  if (!project) throw new Error('HSKRG Platform project not found');
  return project.id;
}

/**
 * Create a board issue. Returns { id, title } or null when skipped/failed.
 */
async function createBoardIssue({ title, description, status = 'open', orgSlug, projectId, orgId }) {
  if (!agentApiKey()) {
    console.warn('[hskrg-board] HSKRG_AGENT_API_KEY missing — skipping board post');
    return null;
  }

  if (orgSlug) process.env.HSKRG_ORG_SLUG = orgSlug;

  const resolvedOrgId = orgId || await resolveOrgId();
  const resolvedProjectId = projectId || await resolvePlatformProjectId(resolvedOrgId);

  const res = await boardFetch('/api/issues', {
    method: 'POST',
    orgId: resolvedOrgId,
    body: {
      organizationId: resolvedOrgId,
      projectId: resolvedProjectId,
      title,
      description,
      status,
    },
  });

  if (!res.ok) {
    console.error(`[hskrg-board] issue create failed ${res.status}: ${res.error || ''}`);
    return null;
  }

  const issue = res.data?.issue;
  if (!issue?.id) {
    console.error('[hskrg-board] issue create returned no id');
    return null;
  }

  const url = `${boardBaseUrl()}/board?org=${encodeURIComponent(process.env.HSKRG_ORG_SLUG || 'auraflux')}&issue=${issue.id}`;
  console.log(`[hskrg-board] issue created: ${issue.id} — ${url}`);
  return issue;
}

module.exports = {
  boardBaseUrl,
  createBoardIssue,
  resolveOrgId,
  resolvePlatformProjectId,
};
