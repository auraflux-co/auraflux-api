'use strict';

/**
 * Credit consumption service — CPD-43
 * Handles FIFO pack deduction, included-vs-overage routing, idempotency,
 * threshold alerts, and overage cap enforcement.
 */

const {
  getClientPlan,
  getCreditBalance,
  logCreditEvent,
  getActivePacks,
  deductPackCredits,
  getOrCreateBillingPeriod,
  getPool,
} = require('../db');

const pipelineBus = require('../pipeline_events');

/**
 * Check whether a job has already been charged (idempotency guard).
 * Returns the existing ledger row or null.
 */
async function findExistingCharge(jobId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM credit_ledger WHERE job_id = $1 LIMIT 1',
    [jobId]
  );
  return rows[0] || null;
}

/**
 * Emit threshold alerts via pipelineBus when usage crosses 75% or 100%.
 */
function emitThresholdAlerts(clientId, includedUsed, creditsIncluded) {
  if (!creditsIncluded || creditsIncluded <= 0) return;
  const pct = includedUsed / creditsIncluded;
  try {
    if (pct >= 1.0) {
      pipelineBus.emit('credits:threshold_100', { clientId, includedUsed, creditsIncluded });
    } else if (pct >= 0.75) {
      pipelineBus.emit('credits:threshold_75', { clientId, includedUsed, creditsIncluded });
    }
  } catch (_e) {
    /* non-fatal */
  }
}

/**
 * Consume credits for a completed job.
 *
 * Priority:
 *   1. Active credit packs (FIFO — oldest expiring first)
 *   2. Included monthly allowance
 *   3. Overage (billed at overage_price_cents/credit)
 *
 * Returns:
 *   { ok: true, balance: { included_remaining, pack_remaining, overage_used } }
 *   { ok: false, status: 'PAUSED', reason: '...' }         — overage cap hit
 *   { ok: false, status: 'ALREADY_CHARGED', balance: ... } — idempotent repeat
 *   { ok: false, status: 'NO_PLAN', reason: '...' }        — unknown client
 */
async function consumeCredits(clientId, jobId, creditsUsed) {
  if (!clientId || !jobId || !creditsUsed || creditsUsed <= 0) {
    return { ok: false, status: 'INVALID_ARGS', reason: 'clientId, jobId, creditsUsed required' };
  }

  // ── Idempotency guard ──────────────────────────────────────────────────────
  const existing = await findExistingCharge(jobId);
  if (existing) {
    const balance = await getCreditBalance(clientId);
    return {
      ok: false,
      status: 'ALREADY_CHARGED',
      balance: {
        included_remaining: balance?.includedRemaining ?? 0,
        pack_remaining: balance?.packCredits ?? 0,
        overage_used: balance?.overageUsed ?? 0,
      },
    };
  }

  // ── Load plan ──────────────────────────────────────────────────────────────
  const plan = await getClientPlan(clientId);
  if (!plan) {
    return { ok: false, status: 'NO_PLAN', reason: `No active plan for client ${clientId}` };
  }

  // ── Current period ─────────────────────────────────────────────────────────
  await getOrCreateBillingPeriod(clientId);
  const balance = await getCreditBalance(clientId);

  // ── Overage cap check ──────────────────────────────────────────────────────
  if (plan.overage_cap_credits !== null && plan.overage_cap_credits !== undefined) {
    const projectedOverage = balance.overageUsed + Math.max(0, creditsUsed - balance.includedRemaining - balance.packCredits);
    if (projectedOverage > plan.overage_cap_credits) {
      return {
        ok: false,
        status: 'PAUSED',
        reason: `Overage cap of ${plan.overage_cap_credits} credits would be exceeded`,
      };
    }
  }

  const pool = getPool();

  // ── Transaction: deduct credits in priority order ─────────────────────────
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let remaining = creditsUsed;

    // 1. Drain active packs (FIFO)
    const packs = await getActivePacks(clientId);
    for (const pack of packs) {
      if (remaining <= 0) break;
      const fromPack = Math.min(remaining, pack.credits_remaining);
      await client.query(
        `UPDATE credit_packs SET credits_remaining = credits_remaining - $1 WHERE id = $2`,
        [fromPack, pack.id]
      );
      await client.query(
        `INSERT INTO credit_ledger (client_id, job_id, credits_used, type, pack_id)
         VALUES ($1, $2, $3, 'pack', $4)`,
        [clientId, jobId, fromPack, pack.id]
      );
      remaining -= fromPack;
    }

    // 2. Use included allowance
    if (remaining > 0 && balance.includedRemaining > 0) {
      const fromIncluded = Math.min(remaining, balance.includedRemaining);
      await client.query(
        `INSERT INTO credit_ledger (client_id, job_id, credits_used, type)
         VALUES ($1, $2, $3, 'included')`,
        [clientId, jobId, fromIncluded]
      );
      remaining -= fromIncluded;
    }

    // 3. Overage
    if (remaining > 0) {
      await client.query(
        `INSERT INTO credit_ledger (client_id, job_id, credits_used, type)
         VALUES ($1, $2, $3, 'overage')`,
        [clientId, jobId, remaining]
      );
      remaining = 0;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── Post-commit: refresh balance and emit threshold alerts ─────────────────
  const newBalance = await getCreditBalance(clientId);
  emitThresholdAlerts(clientId, newBalance.includedUsed, newBalance.creditsIncluded);

  return {
    ok: true,
    balance: {
      included_remaining: newBalance.includedRemaining,
      pack_remaining: newBalance.packCredits,
      overage_used: newBalance.overageUsed,
    },
  };
}

/**
 * Refund credits for a hard-failed job (CPD-115).
 * Only refunds if a charge exists — idempotent.
 * Adds a 'refund' row to credit_ledger and restores included/pack balance.
 *
 * @param {string} clientId
 * @param {string} jobId
 * @param {number} credits — amount to refund (from jobSpec.creditCost)
 * @returns {{ ok: boolean, refunded?: number, reason?: string }}
 */
async function refundCredits(clientId, jobId, credits) {
  if (!clientId || !jobId || !credits || credits <= 0) {
    return { ok: false, reason: 'clientId, jobId, credits required' };
  }

  const pool = getPool();

  // Check existing charge
  const existing = await findExistingCharge(jobId);
  if (!existing) return { ok: false, reason: 'No charge found for this job — nothing to refund' };

  // Idempotency: check if already refunded
  const { rows: refundRows } = await pool.query(
    `SELECT id FROM credit_ledger WHERE job_id = $1 AND type = 'refund' LIMIT 1`,
    [jobId]
  );
  if (refundRows.length > 0) return { ok: false, reason: 'Already refunded' };

  // Restore to included balance (simplest — avoids pack re-allocation complexity)
  await pool.query(
    `INSERT INTO credit_ledger (client_id, job_id, credits_used, type)
     VALUES ($1, $2, $3, 'refund')`,
    [clientId, jobId, -Math.abs(credits)]
  );

  try {
    pipelineBus.emit('credits:refunded', { clientId, jobId, credits });
  } catch (_e) { /* non-fatal */ }

  return { ok: true, refunded: credits };
}

module.exports = { consumeCredits, refundCredits, findExistingCharge };
