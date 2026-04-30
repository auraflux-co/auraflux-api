'use strict';

/**
 * Stripe metered billing cron — CPD-46
 * Reports end-of-period overage credits to Stripe usage_records.
 * Runs nightly; idempotent via billing_periods.overage_reported_at.
 */

const Stripe = require('stripe');
const { getPool } = require('../db');
const { logError } = require('../error_logger');

const OVERAGE_PRICE_CENTS_BY_TIER = {
  diy:    1000,  // $10.00/credit
  dwy:    1800,  // $18.00/credit
  dfy:    3500,  // $35.00/credit
  custom: 0,     // custom pricing — skip metered reporting
};

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(key);
}

/**
 * Report overage for one client's current billing period to Stripe.
 * Uses action='set' so re-runs overwrite rather than double-count.
 *
 * @returns {Promise<{ skipped?: string, reported?: number, usageRecordId?: string }>}
 */
async function reportClientOverage(clientId) {
  const pool = getPool();

  // Load plan with Stripe subscription info
  const { rows: plans } = await pool.query(
    `SELECT * FROM client_plans WHERE client_id = $1 AND active = TRUE LIMIT 1`,
    [clientId]
  );
  const plan = plans[0];
  if (!plan) return { skipped: 'no_active_plan' };
  if (!plan.stripe_metered_item_id) return { skipped: 'no_metered_item_id' };
  if (plan.tier === 'custom') return { skipped: 'custom_tier' };

  // Get or open current billing period
  const now = new Date();
  const anchor = plan.billing_anchor_day;
  let start = new Date(now.getFullYear(), now.getMonth(), anchor);
  if (start > now) start = new Date(now.getFullYear(), now.getMonth() - 1, anchor);
  const periodStart = start.toISOString().split('T')[0];

  const { rows: periods } = await pool.query(
    `SELECT * FROM billing_periods WHERE client_id = $1 AND period_start = $2 LIMIT 1`,
    [clientId, periodStart]
  );
  const period = periods[0];
  if (!period) return { skipped: 'no_billing_period' };

  // Idempotency: already reported this period
  if (period.overage_reported_at) {
    return { skipped: 'already_reported', usageRecordId: period.stripe_usage_record_id };
  }

  // Sum overage credits for the current period
  const { rows: usage } = await pool.query(
    `SELECT COALESCE(SUM(credits_used), 0)::INTEGER AS total
     FROM credit_ledger
     WHERE client_id = $1
       AND type = 'overage'
       AND created_at >= $2`,
    [clientId, start.toISOString()]
  );
  const overageCredits = usage[0]?.total ?? 0;

  // Skip zero-overage clients to avoid $0 noise on Stripe
  if (overageCredits === 0) {
    return { skipped: 'zero_overage' };
  }

  // Report to Stripe usage_records with action='set' (idempotent)
  const stripe = getStripe();
  const usageRecord = await stripe.subscriptionItems.createUsageRecord(
    plan.stripe_metered_item_id,
    {
      quantity: overageCredits,
      timestamp: Math.floor(Date.now() / 1000),
      action: 'set',  // overwrites previous — safe for re-runs
    }
  );

  // Mark period as reported
  await pool.query(
    `UPDATE billing_periods
     SET status = 'reported',
         overage_reported_at = NOW(),
         overage_credits = $1,
         overage_charge_cents = $2,
         stripe_usage_record_id = $3
     WHERE id = $4`,
    [
      overageCredits,
      overageCredits * (OVERAGE_PRICE_CENTS_BY_TIER[plan.tier] || plan.overage_price_cents || 0),
      usageRecord.id,
      period.id,
    ]
  );

  return { reported: overageCredits, usageRecordId: usageRecord.id };
}

/**
 * Run overage reporting for ALL active clients with outstanding overage.
 * Called by the nightly cron or manually via admin endpoint.
 *
 * @returns {Promise<{ results: Array<{ clientId, ...result }> }>}
 */
async function runOverageBillingCycle() {
  const pool = getPool();

  // Find all active clients with a metered_item_id
  const { rows: clients } = await pool.query(
    `SELECT client_id FROM client_plans
     WHERE active = TRUE AND stripe_metered_item_id IS NOT NULL`
  );

  const results = [];
  for (const { client_id: clientId } of clients) {
    try {
      const result = await reportClientOverage(clientId);
      results.push({ clientId, ...result });
    } catch (err) {
      logError('BILLING_CRON_CLIENT_ERROR', err, { clientId });
      results.push({ clientId, error: err.message });
    }
  }

  return { results, ran_at: new Date().toISOString() };
}

/**
 * Get pending overage summary for the operator dashboard.
 * Returns clients with unreported overage before their next billing date.
 */
async function getPendingOverageSummary() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      cp.client_id,
      cp.tier,
      cp.billing_anchor_day,
      cp.overage_price_cents,
      COALESCE(SUM(cl.credits_used), 0)::INTEGER AS unreported_overage,
      COALESCE(SUM(cl.credits_used), 0) * cp.overage_price_cents AS estimated_charge_cents
    FROM client_plans cp
    LEFT JOIN credit_ledger cl
      ON cl.client_id = cp.client_id
      AND cl.type = 'overage'
      AND cl.billing_period_id IS NULL
    WHERE cp.active = TRUE
    GROUP BY cp.client_id, cp.tier, cp.billing_anchor_day, cp.overage_price_cents
    HAVING COALESCE(SUM(cl.credits_used), 0) > 0
    ORDER BY estimated_charge_cents DESC
  `);

  return rows.map((r) => ({
    clientId: r.client_id,
    tier: r.tier,
    billingAnchorDay: r.billing_anchor_day,
    unreportedOverageCredits: r.unreported_overage,
    estimatedChargeCents: parseInt(r.estimated_charge_cents, 10) || 0,
    estimatedChargeDollars: ((parseInt(r.estimated_charge_cents, 10) || 0) / 100).toFixed(2),
  }));
}

module.exports = { reportClientOverage, runOverageBillingCycle, getPendingOverageSummary };
