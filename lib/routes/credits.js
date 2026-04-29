'use strict';

/**
 * Credit routes — CPD-43, CPD-44
 * POST /credits/consume  — internal: deduct credits on job completion
 * GET  /credits/balance  — customer: current balance summary (CPD-44)
 */

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { apiLimit } = require('../rateLimiter');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { consumeCredits } = require('../services/credits');
const { getCreditBalance } = require('../db');

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
      const balance = await getCreditBalance(clientId);
      if (!balance) {
        return res.status(404).json({ ok: false, error: `No active plan for client ${clientId}` });
      }
      return res.json({ ok: true, clientId, ...balance });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
