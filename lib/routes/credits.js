'use strict';

/**
 * Credit routes — CPD-43, CPD-44
 * POST /credits/consume  — internal: deduct credits on job completion
 * GET  /credits/balance  — customer: current balance summary (CPD-44)
 * GET  /credits/history   — customer: paginated ledger history (CPD-44)
 */

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { apiLimit } = require('../rateLimiter');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { consumeCredits } = require('../services/credits');
const { getCreditBalance, getClientPlan, getPool } = require('../db');

// ── POST /credits/consume ─────────────────────────────────────────────────────
// Internal service endpoint — called by the portal pipeline after job completion.
// Auth: x-admin-token (service bypass) OR operator+

const consumeValidations = [
  body('clientId').isString().notEmpty().withMessage('clientId required'),
  body('jobId').isString().notEmpty().withMessage('jobId required'),
  body('creditsUsed').isInt({ min: 1 }).withMessage('creditsUsed must be a positive integer'),
];

router.post(
  '/credits/consume',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.OPERATOR }),
  consumeValidations,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    const { clientId, jobId, creditsUsed } = req.body;

    try {
      const result = await consumeCredits(clientId, jobId, creditsUsed);

      if (result.status === 'ALREADY_CHARGED') {
        return res.status(200).json({ ok: true, idempotent: true, ...result });
      }

      if (!result.ok) {
        const httpStatus = result.status === 'PAUSED' ? 402 : 400;
        return res.status(httpStatus).json(result);
      }

      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /credits/balance ──────────────────────────────────────────────────────
// Customer-facing balance summary. Auth: customer+

router.get(
  '/credits/balance',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    // For operator+, allow ?clientId= override; customer reads own balance from JWT
    const clientId = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.OPERATOR
      ? (req.query.clientId || req.user?.id)
      : req.user?.id;

    if (!clientId) {
      return res.status(400).json({ ok: false, error: 'clientId could not be resolved' });
    }

    try {
      const [balance, plan] = await Promise.all([
        getCreditBalance(clientId),
        getClientPlan(clientId),
      ]);
      if (!balance || !plan) {
        return res.status(404).json({ ok: false, error: `No active plan for client ${clientId}` });
      }

      // Compute period end date from anchor day
      const now = new Date();
      const anchor = plan.billing_anchor_day;
      let periodStart = new Date(now.getFullYear(), now.getMonth(), anchor);
      if (periodStart > now) periodStart = new Date(now.getFullYear(), now.getMonth() - 1, anchor);
      const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, anchor - 1);

      return res.json({
        ok: true,
        clientId,
        included_remaining: balance.includedRemaining,
        included_total: balance.creditsIncluded,
        pack_remaining: balance.packCredits,
        overage_used: balance.overageUsed,
        overage_cap: plan.overage_cap_credits ?? null,
        overage_price_cents: plan.overage_price_cents,
        tier: balance.tier,
        period_start: balance.periodStart,
        period_end: periodEnd.toISOString().split('T')[0],
        history_url: `/credits/history?clientId=${encodeURIComponent(clientId)}`,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /credits/history ───────────────────────────────────────────────────
// Paginated credit ledger history. Auth: customer+

router.get(
  '/credits/history',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const clientId = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.OPERATOR
      ? (req.query.clientId || req.user?.id)
      : req.user?.id;

    if (!clientId) {
      return res.status(400).json({ ok: false, error: 'clientId could not be resolved' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    try {
      const pool = getPool();
      const [{ rows }, { rows: countRows }] = await Promise.all([
        pool.query(
          `SELECT id, job_id, credits_used, type, pack_id, created_at
           FROM credit_ledger
           WHERE client_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [clientId, limit, offset]
        ),
        pool.query(
          'SELECT COUNT(*) AS total FROM credit_ledger WHERE client_id = $1',
          [clientId]
        ),
      ]);

      return res.json({
        ok: true,
        clientId,
        total: parseInt(countRows[0]?.total, 10) || 0,
        limit,
        offset,
        entries: rows,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
