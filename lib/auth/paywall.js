'use strict';
/**
 * Paywall helpers — purchase on auraflux.co before app account access.
 * Shared by API claim-checkout and (via duplicate query patterns) the Next auth layer.
 */
const { getPool } = require('../db/postgres');

/**
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function findUnclaimedPendingBySession(sessionId) {
  if (!sessionId) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM pending_subscriptions
     WHERE stripe_session_id = $1
       AND claimed_by IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [sessionId],
  );
  return rows[0] || null;
}

/**
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findUnclaimedPendingByEmail(email) {
  if (!email) return null;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM pending_subscriptions
     WHERE lower(email) = lower($1)
       AND claimed_by IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [email],
  );
  return rows[0] || null;
}

/**
 * True when the account has an active Stripe subscription on client_plans.
 * @param {string} clientId
 * @returns {Promise<boolean>}
 */
async function hasPaidSubscription(clientId) {
  if (!clientId) return false;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM client_plans
     WHERE client_id = $1
       AND active = TRUE
       AND stripe_subscription_id IS NOT NULL
       AND stripe_subscription_id <> ''
     LIMIT 1`,
    [clientId],
  );
  return rows.length > 0;
}

module.exports = {
  findUnclaimedPendingBySession,
  findUnclaimedPendingByEmail,
  hasPaidSubscription,
};
