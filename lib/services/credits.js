'use strict';

/**
 * Credit consumption service — CPD-43
 * CPD-367: hard stop at zero — no overage, jobs block when balance exhausted
 * CPD-368: threshold notifications at 25% remaining, 75% used, 100% used
 * CPD-369: auto top-up via off-session Stripe charge before blocking
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
const { createNotification } = require('./notifications');

/**
 * Emit threshold alerts via pipelineBus when usage crosses key thresholds.
 * Also fires in-app notifications for 75% and 100% (CPD-368).
 */
async function emitThresholdAlerts(clientId, includedRemaining, creditsIncluded) {
  if (!creditsIncluded || creditsIncluded <= 0) return;
  const pct = includedRemaining / creditsIncluded;
  try {
    if (pct <= 0) {
      pipelineBus.emit('credits:threshold_100', { clientId, includedRemaining, creditsIncluded });
      // In-app notification — jobs are now paused
      createNotification(clientId, {
        type:      'credits_exhausted',
        title:     'No credits remaining — jobs paused',
        body:      'You have used all your monthly credits. Buy a top-up pack or enable auto top-up to resume.',
        actionUrl: '/credits',
      }).catch(() => {});
    } else if (pct <= 0.25) {
      pipelineBus.emit('credits:threshold_25', { clientId, includedRemaining, creditsIncluded });
      // UI-only warning (25% remaining) — no push notification, banner shown on /credits
    } else if (pct <= 0.5) {
      pipelineBus.emit('credits:threshold_75', { clientId, includedRemaining, creditsIncluded });
      // In-app notification — getting low
      createNotification(clientId, {
        type:      'credits_low',
        title:     'Credits running low',
        body:      `You have ${includedRemaining} of ${creditsIncluded} credits remaining this period.`,
        actionUrl: '/credits',
      }).catch(() => {});
    }
  } catch (_e) {
    /* non-fatal */
  }
}

/**
 * Check whether a job has already been charged (idempotency guard).
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
 * Core deduction logic — drain packs then included allowance.
 * Returns credits still remaining (> 0 means insufficient balance).
 * Runs inside an existing transaction client.
 */
async function _deductInTransaction(txClient, clientId, jobId, creditsUsed, balance, packs, brandId = null) {
  let remaining = creditsUsed;

  // 1. Drain active packs (FIFO — oldest expiring first)
  for (const pack of packs) {
    if (remaining <= 0) break;
    const fromPack = Math.min(remaining, pack.credits_remaining);
    await txClient.query(
      `UPDATE credit_packs SET credits_remaining = credits_remaining - $1 WHERE id = $2`,
      [fromPack, pack.id]
    );
    await txClient.query(
      `INSERT INTO credit_ledger (client_id, job_id, credits_used, type, pack_id, brand_id)
       VALUES ($1, $2, $3, 'pack', $4, $5::uuid)`,
      [clientId, jobId, fromPack, pack.id, brandId || null]
    );
    remaining -= fromPack;
  }

  // 2. Use included allowance
  if (remaining > 0 && balance.includedRemaining > 0) {
    const fromIncluded = Math.min(remaining, balance.includedRemaining);
    await txClient.query(
      `INSERT INTO credit_ledger (client_id, job_id, credits_used, type, brand_id)
       VALUES ($1, $2, $3, 'included', $4::uuid)`,
      [clientId, jobId, fromIncluded, brandId || null]
    );
    remaining -= fromIncluded;
  }

  return remaining; // 0 = fully paid; > 0 = insufficient
}

/**
 * Consume credits for a completed job.
 *
 * Priority order:
 *   1. Active credit packs (FIFO — oldest expiring first)
 *   2. Included monthly allowance
 *   3. Auto top-up (CPD-369) — if enabled, charge off-session and retry
 *   4. PAUSED — no credits, no job (CPD-367)
 *
 * Returns:
 *   { ok: true, balance: { included_remaining, pack_remaining, overage_used } }
 *   { ok: false, status: 'PAUSED', reason: '...' }         — balance exhausted
 *   { ok: false, status: 'ALREADY_CHARGED', balance: ... } — idempotent repeat
 *   { ok: false, status: 'NO_PLAN', reason: '...' }        — unknown client
 */
async function consumeCredits(clientId, jobId, creditsUsed, brandId = null) {
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
        pack_remaining:     balance?.packCredits ?? 0,
        overage_used:       0,
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
  const packs   = await getActivePacks(clientId);

  // ── Quick insufficiency check (no DB writes yet) ───────────────────────────
  const totalAvailable = balance.includedRemaining + balance.packCredits;
  const wouldNeedAutoTopup = creditsUsed > totalAvailable;

  // ── Auto top-up (CPD-369) ─────────────────────────────────────────────────
  // If balance will run out and auto top-up is enabled, charge off-session first.
  if (wouldNeedAutoTopup && plan.auto_topup_enabled) {
    try {
      const { attemptAutoTopup } = require('./stripe_billing');
      const topup = await attemptAutoTopup(plan, null, clientId);
      if (topup.ok) {
        console.log(`[credits] Auto top-up succeeded for ${clientId}: +${topup.credits} credits`);
        createNotification(clientId, {
          type:      'auto_topup_success',
          title:     `Auto top-up: +${topup.credits} credits added`,
          body:      'Your card was automatically charged to keep your jobs running.',
          actionUrl: '/credits',
        }).catch(() => {});
      } else {
        console.warn(`[credits] Auto top-up failed for ${clientId}: ${topup.reason}`);
        createNotification(clientId, {
          type:      'auto_topup_failed',
          title:     'Auto top-up failed',
          body:      `Could not charge your card: ${topup.reason}. Update your payment method to resume jobs.`,
          actionUrl: '/billing/payment',
        }).catch(() => {});
      }
    } catch (topupErr) {
      console.error(`[credits] Auto top-up error for ${clientId}:`, topupErr.message);
    }
  }

  const pool = getPool();
  const txClient = await pool.connect();
  let remaining;
  try {
    await txClient.query('BEGIN');
    // Re-fetch balance inside transaction for consistency (auto top-up may have added credits)
    const freshBalance = await getCreditBalance(clientId);
    const freshPacks   = await getActivePacks(clientId);
    remaining = await _deductInTransaction(txClient, clientId, jobId, creditsUsed, freshBalance, freshPacks, brandId);

    if (remaining > 0) {
      // CPD-367: hard stop — no overage writes, roll back and return PAUSED
      await txClient.query('ROLLBACK');
      // Fire threshold notification (balance is at or near zero)
      const newBalance = await getCreditBalance(clientId);
      await emitThresholdAlerts(clientId, newBalance.includedRemaining, newBalance.creditsIncluded);
      return {
        ok: false,
        status: 'PAUSED',
        reason: `Insufficient credits: need ${creditsUsed}, have ${freshBalance.includedRemaining + freshBalance.packCredits}. Buy a top-up pack at /credits.`,
      };
    }

    await txClient.query('COMMIT');
  } catch (err) {
    await txClient.query('ROLLBACK');
    throw err;
  } finally {
    txClient.release();
  }

  // ── Post-commit: refresh balance and emit threshold alerts ─────────────────
  const newBalance = await getCreditBalance(clientId);
  await emitThresholdAlerts(clientId, newBalance.includedRemaining, newBalance.creditsIncluded);

  return {
    ok: true,
    balance: {
      included_remaining: newBalance.includedRemaining,
      pack_remaining:     newBalance.packCredits,
      overage_used:       0,
    },
  };
}

/**
 * Refund credits for a hard-failed job (CPD-115).
 * Only refunds if a charge exists — idempotent.
 */
async function refundCredits(clientId, jobId, credits) {
  if (!clientId || !jobId || !credits || credits <= 0) {
    return { ok: false, reason: 'clientId, jobId, credits required' };
  }

  const pool = getPool();

  const existing = await findExistingCharge(jobId);
  if (!existing) return { ok: false, reason: 'No charge found for this job — nothing to refund' };

  const { rows: refundRows } = await pool.query(
    `SELECT id FROM credit_ledger WHERE job_id = $1 AND type = 'refund' LIMIT 1`,
    [jobId]
  );
  if (refundRows.length > 0) return { ok: false, reason: 'Already refunded' };

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
