'use strict';
/**
 * lib/auth/api_key.js — CPD-126: API key authentication middleware
 *
 * Resolves `Authorization: Bearer af_live_<key>` to a customer record.
 * Attaches req.user = { id, role, email, planTier } — same shape as Clerk middleware.
 * Use in place of requireAuth on /v1/ routes.
 *
 * E2E Clerk-user auth mode (for Run 4+ E2E testing without browser flows):
 *   Authorization: Bearer clerk_user_{clerkUserId}
 *   X-E2E-Secret:  {E2E_AUTH_SECRET from env}
 *
 * This lets the E2E runner authenticate as the real Clerk test accounts
 * (operate-test, guided-test, managed-test) without requiring FAPI browser sessions.
 * Jobs are attributed to the actual Clerk users, CRM shows them correctly.
 */

const { validateApiKey } = require('../services/api_keys');
const { ROLES, _getClerkUserMeta: _clerkMeta } = require('./clerk');
const { query }          = require('../db/postgres');

// Rate limit state — simple in-memory per key (resets on restart).
// Production: replace with Redis or Postgres-backed counter.
const _rateLimitState = new Map();

const RATE_LIMITS = {
  operate:    { rpm: 60,  concurrent: 3          },
  guided:    { rpm: 120, concurrent: 10         },
  managed:    { rpm: 300, concurrent: Infinity   },
  custom: { rpm: 300, concurrent: Infinity   },
};

function _checkRateLimit(keyId, planTier) {
  const limits = RATE_LIMITS[planTier] || RATE_LIMITS.operate;
  const now    = Date.now();
  const window = 60_000;

  if (!_rateLimitState.has(keyId)) {
    _rateLimitState.set(keyId, { hits: [], concurrent: 0 });
  }

  const state = _rateLimitState.get(keyId);
  state.hits  = state.hits.filter(t => now - t < window);

  if (state.hits.length >= limits.rpm) {
    return { allowed: false, reason: 'rate_limit_exceeded', retryAfterMs: window - (now - state.hits[0]) };
  }

  state.hits.push(now);
  return { allowed: true };
}

/**
 * requireApiKeyAuth — drop-in replacement for requireAuth on /v1/ routes.
 * Resolves key → customer_id → customer email from DB, attaches req.user.
 */
async function requireApiKeyAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!raw) {
    return res.status(401).json({ error: 'missing_api_key', message: 'Authorization: Bearer af_live_<key> required' });
  }

  let keyRecord;
  try {
    keyRecord = await validateApiKey(raw);
  } catch (err) {
    console.error('[auth/api_key] validateApiKey threw:', err.message);
    return res.status(500).json({ error: 'auth_error', message: 'API key validation failed', detail: err.message });
  }

  if (!keyRecord) {
    return res.status(401).json({ error: 'invalid_api_key', message: 'API key not found or revoked' });
  }

  const rateCheck = _checkRateLimit(keyRecord.id, keyRecord.plan_tier);
  if (!rateCheck.allowed) {
    res.set('Retry-After', Math.ceil(rateCheck.retryAfterMs / 1000));
    return res.status(429).json({ error: 'rate_limit_exceeded', message: 'Too many requests', retryAfterMs: rateCheck.retryAfterMs });
  }

  // Resolve customer email for logging (best-effort — non-blocking)
  let email = `${keyRecord.customer_id}@api`;
  try {
    const row = await query('SELECT email FROM customers WHERE clerk_id = $1 LIMIT 1', [keyRecord.customer_id]);
    if (row.rows[0]) email = row.rows[0].email;
  } catch (_) { /* non-fatal */ }

  req.user = {
    id:        keyRecord.customer_id,
    role:      ROLES.CUSTOMER,
    email,
    planTier:  keyRecord.plan_tier,
    apiKeyId:  keyRecord.id,
  };

  next();
}

/**
 * E2E Clerk-user auth — authenticates as a real Clerk user without browser FAPI flows.
 *
 * Requires:
 *   Authorization: Bearer clerk_user_{clerkUserId}
 *   X-E2E-Secret: {process.env.E2E_AUTH_SECRET}
 *
 * Only works when E2E_AUTH_SECRET is set in the environment (never set in production).
 * Looks up the real Clerk user metadata (planTier, role) so the request is treated
 * exactly as if the user had authenticated via Clerk session JWT.
 */
async function requireE2EClerkUserAuth(req, res, next, userId) {
  const secret = process.env.E2E_AUTH_SECRET;
  if (!secret) {
    return res.status(401).json({ error: 'e2e_not_configured', message: 'E2E_AUTH_SECRET not set' });
  }
  const provided = req.headers['x-e2e-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'invalid_e2e_secret', message: 'X-E2E-Secret header mismatch' });
  }
  try {
    const meta = await _clerkMeta(userId);
    req.user = {
      id:       userId,
      role:     meta.role     || ROLES.CUSTOMER,
      planTier: meta.planTier || 'operate',
      email:    `${userId}@clerk`,
      _e2eAuth: true,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'clerk_lookup_failed', message: err.message });
  }
}

/**
 * requireApiKeyOrE2EAuth — combined middleware for /v1/ routes.
 * Accepts:
 *   - API key (Authorization: Bearer af_live_...)
 *   - E2E Clerk-user token (Authorization: Bearer clerk_user_{userId} + X-E2E-Secret header)
 */
async function requireApiKeyOrE2EAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!raw) {
    return res.status(401).json({ error: 'missing_auth', message: 'Authorization: Bearer <api_key_or_e2e_token> required' });
  }

  if (raw.startsWith('clerk_user_')) {
    const userId = raw.slice('clerk_user_'.length);
    return requireE2EClerkUserAuth(req, res, next, userId);
  }

  return requireApiKeyAuth(req, res, next);
}

module.exports = { requireApiKeyAuth, requireApiKeyOrE2EAuth };
