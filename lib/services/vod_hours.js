'use strict';
/**
 * VOD hours metering — Growth plan includes 40h/mo; Operate+ unlimited (null).
 */
const { getPool, getClientPlan } = require('../db/postgres');
const { getPlanDefaults } = require('./plan_entitlements');

function _periodStart(plan) {
  const now = new Date();
  const anchor = plan.billing_anchor_day || 1;
  let periodStart = new Date(now.getFullYear(), now.getMonth(), anchor);
  if (periodStart > now) periodStart = new Date(now.getFullYear(), now.getMonth() - 1, anchor);
  return periodStart;
}

async function getVodHoursBalance(clientId) {
  const plan = await getClientPlan(clientId);
  if (!plan) return null;

  const defaults = getPlanDefaults(plan.tier);
  const included =
    plan.vod_hours_included != null
      ? Number(plan.vod_hours_included)
      : defaults.vod_hours_included;

  // null / undefined = unlimited
  if (included == null) {
    return {
      unlimited: true,
      hoursIncluded: null,
      hoursUsed: 0,
      hoursRemaining: null,
      tier: plan.tier,
      periodStart: _periodStart(plan).toISOString(),
    };
  }

  const periodStart = _periodStart(plan);
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(hours_delta), 0) AS used
       FROM vod_hours_ledger
      WHERE client_id = $1 AND period_start = $2 AND hours_delta > 0`,
    [clientId, periodStart.toISOString()],
  );
  const hoursUsed = Number(rows[0]?.used || 0);
  return {
    unlimited: false,
    hoursIncluded: included,
    hoursUsed,
    hoursRemaining: Math.max(0, included - hoursUsed),
    tier: plan.tier,
    periodStart: periodStart.toISOString(),
  };
}

/**
 * Debit VOD processing hours for a job. hours must be > 0.
 * Returns { ok, status, balance } — status PAUSED when over quota.
 */
async function consumeVodHours(clientId, jobId, hours, brandId = null) {
  if (!clientId || !(hours > 0)) {
    return { ok: true, status: 'SKIPPED', reason: 'no hours to debit' };
  }

  const balance = await getVodHoursBalance(clientId);
  if (!balance) {
    return { ok: true, status: 'SKIPPED', reason: 'no plan' };
  }
  if (balance.unlimited) {
    return { ok: true, status: 'UNLIMITED', balance };
  }
  if (balance.hoursRemaining < hours) {
    return {
      ok: false,
      status: 'PAUSED',
      reason: `VOD hours exhausted (${balance.hoursUsed.toFixed(2)}/${balance.hoursIncluded}h used this period)`,
      balance,
    };
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO vod_hours_ledger (client_id, brand_id, job_id, hours_delta, reason, period_start)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      clientId,
      brandId,
      jobId,
      hours,
      'job_vod_processing',
      balance.periodStart,
    ],
  );

  const fresh = await getVodHoursBalance(clientId);
  return { ok: true, status: 'DEBITED', balance: fresh };
}

/** Estimate hours from seconds; floor at 1 minute. */
function hoursFromDurationSecs(secs) {
  const s = Number(secs) || 0;
  if (s <= 0) return 1 / 60; // minimum 1 minute
  return Math.max(1 / 60, s / 3600);
}

module.exports = {
  getVodHoursBalance,
  consumeVodHours,
  hoursFromDurationSecs,
};
