'use strict';
/**
 * lib/services/token_store.js — Encrypted per-customer OAuth token storage (CPD-86)
 *
 * Stores access + refresh tokens in `platform_oauth_tokens` (PostgreSQL).
 * All token values are AES-256-GCM encrypted with TOKEN_ENCRYPTION_KEY.
 *
 * Env vars required:
 *   TOKEN_ENCRYPTION_KEY — 64-char hex string (32 bytes). Generate with:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');
const db = require('../db');

const ALG = 'aes-256-gcm';
const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY || '';

/** PostgreSQL: `brand_id = NULL` is always false — use IS NULL when brandId is absent. */
const SQL_BRAND_MATCH = '(($2::uuid IS NULL AND brand_id IS NULL) OR brand_id = $2::uuid)';

function _key() {
  if (!KEY_HEX || KEY_HEX.length < 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY env var must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(KEY_HEX.slice(0, 64), 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, _key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv:tag:ciphertext — all base64
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return null;
  const [ivB64, tagB64, encB64] = stored.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const dec = crypto.createDecipheriv(ALG, _key(), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

/**
 * Save (upsert) OAuth tokens for a customer+brand+platform triplet.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {string} [p.brandId]         — Brand UUID (required for new tokens, nullable for legacy)
 * @param {string} p.platform          — 'youtube' | 'tiktok' | 'instagram'
 * @param {string} p.accessToken
 * @param {string} [p.refreshToken]
 * @param {Date|string} [p.tokenExpiry]
 * @param {string} [p.scope]
 * @param {string} [p.platformUserId]
 * @param {string} [p.platformHandle]
 * @param {object} [p.rawMeta]
 */
async function saveTokens({
  customerId,
  brandId = null,
  platform,
  accessToken,
  refreshToken = null,
  tokenExpiry = null,
  scope = null,
  platformUserId = null,
  platformHandle = null,
  rawMeta = {},
}) {
  const encAccess = encrypt(accessToken);
  const encRefresh = encrypt(refreshToken);

  await db.query(
    `INSERT INTO platform_oauth_tokens
       (customer_id, brand_id, platform, access_token, refresh_token, token_expiry,
        scope, platform_user_id, platform_handle, raw_meta, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (customer_id, brand_id, platform) DO UPDATE SET
       access_token     = EXCLUDED.access_token,
       refresh_token    = EXCLUDED.refresh_token,
       token_expiry     = EXCLUDED.token_expiry,
       scope            = EXCLUDED.scope,
       platform_user_id = EXCLUDED.platform_user_id,
       platform_handle  = EXCLUDED.platform_handle,
       raw_meta         = EXCLUDED.raw_meta,
       updated_at       = NOW()`,
    [
      customerId,
      brandId,
      platform,
      encAccess,
      encRefresh,
      tokenExpiry,
      scope,
      platformUserId,
      platformHandle,
      JSON.stringify(rawMeta),
    ]
  );
}

/**
 * Load decrypted tokens for a customer+brand+platform triplet.
 * Returns null if not found.
 *
 * @param {string} customerId
 * @param {string} brandId
 * @param {string} platform
 * @returns {object|null} { accessToken, refreshToken, tokenExpiry, scope, platformUserId, platformHandle, rawMeta }
 */
async function loadTokens(customerId, brandId, platform) {
  const res = await db.query(
    `SELECT access_token, refresh_token, token_expiry, scope,
            platform_user_id, platform_handle, raw_meta, updated_at
       FROM platform_oauth_tokens
      WHERE customer_id = $1 AND ${SQL_BRAND_MATCH} AND platform = $3
      LIMIT 1`,
    [customerId, brandId, platform]
  );
  const row = res.rows[0];
  if (!row) return null;

  return {
    accessToken: decrypt(row.access_token),
    refreshToken: decrypt(row.refresh_token),
    tokenExpiry: row.token_expiry,
    scope: row.scope,
    platformUserId: row.platform_user_id,
    platformHandle: row.platform_handle,
    rawMeta: row.raw_meta || {},
    updatedAt: row.updated_at || null,
  };
}

/**
 * Remove stored tokens for a customer+brand+platform (disconnect).
 */
async function deleteTokens(customerId, brandId, platform) {
  await db.query(
    `DELETE FROM platform_oauth_tokens WHERE customer_id = $1 AND ${SQL_BRAND_MATCH} AND platform = $3`,
    [customerId, brandId, platform],
  );
}

/**
 * Remove tokens for all brands of a customer for a specific platform.
 * Used by webhooks where brand context is unknown.
 */
async function deleteAllTokensForPlatform(customerId, platform) {
  await db.query('DELETE FROM platform_oauth_tokens WHERE customer_id = $1 AND platform = $2', [
    customerId,
    platform,
  ]);
}

/**
 * Check if a customer+brand has a valid (non-expired) token for a platform.
 */
/**
 * Update only channel metadata without touching encrypted tokens.
 */
async function updateTokenChannelMeta(customerId, brandId, platform, { platformUserId, platformHandle }) {
  await db.query(
    `UPDATE platform_oauth_tokens
        SET platform_user_id = $4,
            platform_handle  = $5,
            updated_at       = NOW()
      WHERE customer_id = $1 AND ${SQL_BRAND_MATCH} AND platform = $3`,
    [customerId, brandId, platform, platformUserId, platformHandle]
  );
}

async function hasValidToken(customerId, brandId, platform) {
  const res = await db.query(
    `SELECT 1 FROM platform_oauth_tokens
      WHERE customer_id = $1 AND ${SQL_BRAND_MATCH} AND platform = $3
        AND (
          token_expiry IS NULL
          OR token_expiry > NOW() + INTERVAL '5 minutes'
          OR (refresh_token IS NOT NULL AND refresh_token != '')
        )
      LIMIT 1`,
    [customerId, brandId, platform]
  );
  return res.rows.length > 0;
}

/**
 * List all connected platforms for a customer+brand (for settings UI display).
 */
async function listConnectedPlatforms(customerId, brandId) {
  const brandFilter = arguments.length >= 2
    ? ` AND ${SQL_BRAND_MATCH}`
    : '';
  const params = arguments.length >= 2 ? [customerId, brandId] : [customerId];
  const res = await db.query(
    `SELECT platform, platform_handle, platform_user_id, brand_id, token_expiry, updated_at,
            (refresh_token IS NOT NULL AND refresh_token != '') AS has_refresh_token
       FROM platform_oauth_tokens
      WHERE customer_id = $1${brandFilter}
      ORDER BY platform ASC`,
    params,
  );
  return res.rows.map((r) => ({
    platform: r.platform,
    handle: r.platform_handle,
    platformUserId: r.platform_user_id,
    brandId: r.brand_id,
    tokenExpiry: r.token_expiry,
    hasRefreshToken: r.has_refresh_token ?? false,
    connectedAt: r.updated_at,
  }));
}

// ─── YouTube quota tracking ────────────────────────────────────────────────

const YT_DAILY_CAP = 10_000;

async function trackYouTubeQuota(customerId, unitsUsed) {
  await db.query(
    `INSERT INTO youtube_quota_log (customer_id, quota_date, units_used, updated_at)
     VALUES ($1, CURRENT_DATE, $2, NOW())
     ON CONFLICT (customer_id, quota_date) DO UPDATE SET
       units_used = youtube_quota_log.units_used + EXCLUDED.units_used,
       updated_at = NOW()`,
    [customerId, unitsUsed]
  );
}

async function getYouTubeQuotaUsed(customerId) {
  const res = await db.query(
    `SELECT COALESCE(SUM(units_used), 0) AS total
       FROM youtube_quota_log
      WHERE customer_id = $1 AND quota_date = CURRENT_DATE`,
    [customerId]
  );
  return parseInt(res.rows[0]?.total || '0', 10);
}

async function assertYouTubeQuota(customerId, unitsNeeded = 1650) {
  const used = await getYouTubeQuotaUsed(customerId);
  if (used + unitsNeeded > YT_DAILY_CAP) {
    throw new Error(
      `YouTube quota cap reached for ${customerId}: ${used}/${YT_DAILY_CAP} units used today. ` +
        `Upload would require ${unitsNeeded} more. Retry tomorrow or request quota increase.`
    );
  }
}

module.exports = {
  saveTokens,
  loadTokens,
  updateTokenChannelMeta,
  deleteTokens,
  deleteAllTokensForPlatform,
  hasValidToken,
  listConnectedPlatforms,
  trackYouTubeQuota,
  getYouTubeQuotaUsed,
  assertYouTubeQuota,
  // Exported for testing
  _encrypt: encrypt,
  _decrypt: decrypt,
};
