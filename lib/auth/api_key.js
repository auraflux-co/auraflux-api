'use strict';
/**
 * lib/auth/api_key.js — CPD-126: API key authentication middleware
 *
 * Resolves `Authorization: Bearer af_live_<key>` to a customer record.
 * Attaches req.user = { id, role, email, planTier } — same shape as Clerk middleware.
 * Use in place of requireAuth on /v1/ routes.
 */

const { validateApiKey } = require('../services/api_keys');
const { ROLES }          = require('./clerk');
const { query }          = require('../db/postgres');

// Rate limit state — simple in-memory per key (resets on restart).
// Production: replace with Redis or Postgres-backed counter.
const _rateLimitState = new Map();

const RATE_LIMITS = {
  diy:    { rpm: 60,  concurrent: 3          },
  dwy:    { rpm: 120, concurrent: 10         },
  dfy:    { rpm: 300, concurrent: Infinity   },
  custom: { rpm: 300, concurrent: Infinity   },
};

function _checkRateLimit(keyId, planTier) {
  const limits = RATE_LIMITS[planTier] || RATE_LIMITS.diy;
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
    return res.status(500).json({ error: 'auth_error', message: 'API key validation failed' });
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

module.exports = { requireApiKeyAuth };
