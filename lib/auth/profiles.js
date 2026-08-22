'use strict';
/**
 * user_profiles — maps Better Auth user id → stable account_id + role/tier.
 */
const db = require('../db/postgres');

const TIER_ALIASES = { diy: 'operate', dwy: 'guided', dfy: 'managed' };

function normaliseTier(raw) {
  if (!raw) return 'operate';
  return TIER_ALIASES[raw] || raw;
}

async function getProfileByAuthUserId(authUserId) {
  const { rows } = await db.query(
    `SELECT * FROM user_profiles WHERE auth_user_id = $1 LIMIT 1`,
    [authUserId],
  );
  return rows[0] || null;
}

async function getProfileByAccountId(accountId) {
  const { rows } = await db.query(
    `SELECT * FROM user_profiles WHERE account_id = $1 LIMIT 1`,
    [accountId],
  );
  return rows[0] || null;
}

async function getProfileByEmail(email) {
  const { rows } = await db.query(
    `SELECT * FROM user_profiles WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

/**
 * Ensure a profile exists for a Better Auth user.
 * @param {{ authUserId: string, email?: string, accountId?: string, role?: string, planTier?: string, legacyClerkId?: string }} opts
 */
async function ensureProfile(opts) {
  const authUserId = opts.authUserId;
  if (!authUserId) throw new Error('authUserId required');
  const existing = await getProfileByAuthUserId(authUserId);
  if (existing) {
    if (opts.email && opts.email !== existing.email) {
      await db.query(
        `UPDATE user_profiles SET email = $1, updated_at = NOW() WHERE auth_user_id = $2`,
        [opts.email, authUserId],
      );
      existing.email = opts.email;
    }
    return existing;
  }

  const accountId = opts.accountId || opts.legacyClerkId || authUserId;
  const role = opts.role || 'customer';
  const planTier = normaliseTier(opts.planTier);
  const email = opts.email || null;
  const legacyClerkId = opts.legacyClerkId || null;

  const { rows } = await db.query(
    `INSERT INTO user_profiles
       (auth_user_id, account_id, email, role, plan_tier, legacy_clerk_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (auth_user_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, user_profiles.email),
       updated_at = NOW()
     RETURNING *`,
    [authUserId, accountId, email, role, planTier, legacyClerkId],
  );
  return rows[0];
}

async function updateProfileMeta(accountId, { role, planTier, email } = {}) {
  const sets = [];
  const params = [];
  let i = 1;
  if (role !== undefined) {
    sets.push(`role = $${i++}`);
    params.push(role);
  }
  if (planTier !== undefined) {
    sets.push(`plan_tier = $${i++}`);
    params.push(normaliseTier(planTier));
  }
  if (email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(email);
  }
  if (!sets.length) return null;
  sets.push('updated_at = NOW()');
  params.push(accountId);
  const { rows } = await db.query(
    `UPDATE user_profiles SET ${sets.join(', ')} WHERE account_id = $${i} RETURNING *`,
    params,
  );
  return rows[0] || null;
}

module.exports = {
  normaliseTier,
  getProfileByAuthUserId,
  getProfileByAccountId,
  getProfileByEmail,
  ensureProfile,
  updateProfileMeta,
};
