'use strict';
/**
 * lib/services/api_keys.js — CPD-126: Developer API key CRUD
 *
 * Keys: af_live_<64 hex chars>
 * Stored: SHA-256 hash only. Plaintext returned once at generation.
 */

const crypto  = require('crypto');
const { query } = require('../db/postgres');

const PREFIX = 'af_live_';
const KEY_BYTES = 32; // 64 hex chars

function _generateRaw() {
  return PREFIX + crypto.randomBytes(KEY_BYTES).toString('hex');
}

function _hash(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function _prefix(rawKey) {
  return rawKey.slice(0, PREFIX.length + 8); // "af_live_" + 8 chars
}

/**
 * Create a new API key for a customer.
 * Returns { key, record } — key is the plaintext (shown once), record is the DB row.
 */
async function createApiKey(customerId, planTier, name = '') {
  const raw    = _generateRaw();
  const hash   = _hash(raw);
  const prefix = _prefix(raw);

  const result = await query(
    `INSERT INTO api_keys (customer_id, key_hash, key_prefix, name, plan_tier)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, key_prefix, name, plan_tier, created_at`,
    [customerId, hash, prefix, name, planTier]
  );

  return { key: raw, record: result.rows[0] };
}

/**
 * Validate a raw API key. Returns the key record if valid, null otherwise.
 * Updates last_used_at on success.
 */
async function validateApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith(PREFIX)) return null;

  const hash = _hash(rawKey);
  const result = await query(
    `UPDATE api_keys
     SET last_used_at = NOW()
     WHERE key_hash = $1 AND revoked_at IS NULL
     RETURNING id, customer_id, key_prefix, name, plan_tier, created_at, last_used_at`,
    [hash]
  );

  return result.rows[0] || null;
}

/**
 * List all active API keys for a customer (hashes never returned).
 */
async function listApiKeys(customerId) {
  const result = await query(
    `SELECT id, key_prefix, name, plan_tier, created_at, last_used_at
     FROM api_keys
     WHERE customer_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [customerId]
  );
  return result.rows;
}

/**
 * Revoke an API key by ID. Only the owning customer can revoke.
 */
async function revokeApiKey(keyId, customerId) {
  const result = await query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND customer_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [keyId, customerId]
  );
  return result.rows.length > 0;
}

module.exports = { createApiKey, validateApiKey, listApiKeys, revokeApiKey };
