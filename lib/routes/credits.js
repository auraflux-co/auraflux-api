'use strict';

/**
 * Credit routes — CPD-43, CPD-44
 * POST /credits/consume  — internal: deduct credits on job completion
 * GET  /credits/balance  — customer: current balance summary (CPD-44)
 * GET  /credits/history   — customer: paginated ledger history (CPD-44)
 * GET  /credits/packs      — public: list available credit packs (CPD-45)
 * POST /credits/purchase-pack — customer: initiate Stripe Checkout (CPD-45)
 * POST /credits/webhook    — Stripe webhook handler (CPD-45, CPD-88)
 */

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { apiLimit } = require('../rateLimiter');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { consumeCredits } = require('../services/credits');
const { getCreditBalance, getClientPlan, getPool, insertCreditPack, hasStripeEvent, recordStripeEvent, updateClientPlanTier } = require('../db');
const { PACKS, createCheckoutSession, constructWebhookEvent, resolveSubscriptionTier } = require('../services/stripe_billing');
const { runOverageBillingCycle, getPendingOverageSummary } = require('../services/billing_cron');
const express = require('express');
const { logError } = require('../error_logger');

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

// ── POST /credits/purchase-pack ──────────────────────────────────────────────
// Initiate Stripe Checkout session for a credit pack. Auth: customer+

router.post(
  '/credits/purchase-pack',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  [
    body('packId').isIn(Object.keys(PACKS)).withMessage(`packId must be one of: ${Object.keys(PACKS).join(', ')}`),
    body('successUrl').isURL().withMessage('successUrl must be a valid URL'),
    body('cancelUrl').isURL().withMessage('cancelUrl must be a valid URL'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }
    const clientId = req.user?.id;
    const { packId, successUrl, cancelUrl } = req.body;
    try {
      const { checkoutUrl, sessionId } = await createCheckoutSession(
        clientId, packId, successUrl, cancelUrl
      );
      return res.json({ ok: true, checkoutUrl, sessionId, pack: PACKS[packId] });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /credits/pending-overage (CPD-46) ─────────────────────────────────────
// Operator dashboard: clients with unreported overage before next billing date.

router.get(
  '/credits/pending-overage',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.OPERATOR }),
  async (req, res) => {
    try {
      const summary = await getPendingOverageSummary();
      return res.json({ ok: true, clients: summary });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── POST /credits/run-overage-billing (CPD-46) ───────────────────────────────
// Admin-triggered manual run of the overage billing cycle (also runs nightly by cron).

router.post(
  '/credits/run-overage-billing',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.ADMIN }),
  async (req, res) => {
    try {
      const result = await runOverageBillingCycle();
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /credits/packs ─────────────────────────────────────────────────
// List available packs for the 'Buy credits' modal. No auth required.

router.get('/credits/packs', apiLimit, (req, res) => {
  res.json({ ok: true, packs: Object.values(PACKS) });
});

// ── POST /credits/webhook ─────────────────────────────────────────────────
// Stripe webhook handler. Raw body required for signature verification.
// express.json() must have verify callback saving req.rawBody for this path.

router.post(
  '/credits/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    // Use rawBody set by express.json verify callback; fall back to req.body (Buffer from express.raw)
    const rawBody = req.rawBody || req.body;

    let event;
    try {
      event = constructWebhookEvent(rawBody, sig);
    } catch (err) {
      return res.status(400).json({ ok: false, error: `Webhook signature invalid: ${err.message}` });
    }

    // Idempotency guard
    if (await hasStripeEvent(event.id)) {
      return res.json({ ok: true, status: 'already_processed' });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const clientId = session.metadata?.clientId;
        const packId = session.metadata?.packId;
        const credits = parseInt(session.metadata?.credits, 10);
        const stripePaymentId = session.payment_intent || session.id;

        if (!clientId || !packId || !credits) {
          return res.status(422).json({ ok: false, error: 'Missing metadata in Checkout session' });
        }

        await insertCreditPack(clientId, credits, stripePaymentId);
      } else if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const clientId = sub.metadata?.clientId;
        const priceId = sub.items?.data?.[0]?.price?.id || null;
        const tier = resolveSubscriptionTier(priceId);
        if (clientId && tier) {
          await updateClientPlanTier(clientId, tier, sub.id);
          console.log(`[stripe-webhook] subscription.updated: client=${clientId} → tier=${tier}`);
        } else {
          console.warn(
            `[stripe-webhook] subscription.updated: could not resolve tier ` +
              `(clientId=${clientId}, priceId=${priceId}) — no plan update applied`
          );
        }

      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const clientId = sub.metadata?.clientId;
        if (clientId) {
          await updateClientPlanTier(clientId, 'diy', null);
          console.log(`[stripe-webhook] subscription.deleted: client=${clientId} → downgraded to diy`);
        }

      } else if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const clientId = invoice.metadata?.clientId || invoice.customer_email || 'unknown';
        const amount = invoice.amount_due;
        const attemptCount = invoice.attempt_count;
        logError(
          'STRIPE_PAYMENT_FAILED',
          new Error(`Invoice payment failed for client ${clientId} — amount=${amount} attempt=${attemptCount}`),
          { clientId, invoiceId: invoice.id, amount, attemptCount, customerEmail: invoice.customer_email }
        );
        console.warn(
          `[stripe-webhook] ⚠️ invoice.payment_failed: client=${clientId} amount=${amount} attempt=${attemptCount}`
        );
      }

      // Record event AFTER successful processing to ensure atomicity
      await recordStripeEvent(event.id, event.type);
    } catch (err) {
      // Return 500 so Stripe retries
      return res.status(500).json({ ok: false, error: err.message });
    }

    return res.json({ ok: true, received: true });
  }
);

module.exports = router;
