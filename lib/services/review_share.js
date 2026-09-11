'use strict';

/**
 * Guest review share tokens — public Approve / Request re-cut without member session.
 * Gate: review.guest_share
 */

const crypto = require('crypto');
const { query: dbQuery } = require('../db/postgres');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function generateRawToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * @returns {Promise<{ token: string, urlPath: string, expiresAt: string }>}
 */
async function createReviewShareToken({
  jobId,
  brandId = null,
  accountId = null,
  ttlDays = 7,
  permissions = { approve: true, revise: true, comment: true },
} = {}) {
  if (!jobId) throw new Error('jobId required');
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 86400000);
  await dbQuery(
    `INSERT INTO review_share_tokens (token_hash, job_id, brand_id, account_id, expires_at, permissions)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tokenHash, jobId, brandId, accountId, expiresAt.toISOString(), JSON.stringify(permissions)],
  );
  return {
    token: raw,
    urlPath: `/review/share/${raw}`,
    expiresAt: expiresAt.toISOString(),
  };
}

async function resolveReviewShareToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const { rows } = await dbQuery(
    `SELECT * FROM review_share_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  return rows[0] || null;
}

async function revokeReviewShareToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  await dbQuery(
    `UPDATE review_share_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
}

module.exports = {
  createReviewShareToken,
  resolveReviewShareToken,
  revokeReviewShareToken,
  hashToken,
};
