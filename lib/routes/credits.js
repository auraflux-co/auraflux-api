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
const { consumeCredits, refundCredits } = require('../services/credits');
const { getCreditBalance, getClientPlan, getOrCreateClientPlan, getPool, insertCreditPack, hasStripeEvent, recordStripeEvent, updateClientPlanTier } = require('../db');
const { createNotification } = require('../services/notifications');
const { PACKS, PLANS, getPlans, createCheckoutSession, createSubscriptionCheckoutSession, createBillingPortalSession, constructWebhookEvent, resolveSubscriptionTier } = require('../services/stripe_billing');
const { invalidateCache: invalidatePlansCache } = require('../services/stripe_plans_sync');
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

// ── POST /credits/refund ──────────────────────────────────────────────────────
// Internal: auto-refund on hard pipeline failure (CPD-115). Auth: operator+

router.post(
  '/credits/refund',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.OPERATOR }),
  [
    body('clientId').isString().notEmpty(),
    body('jobId').isString().notEmpty(),
    body('credits').isInt({ min: 1 }).withMessage('credits must be a positive integer'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
    const { clientId, jobId, credits } = req.body;
    try {
      const result = await refundCredits(clientId, jobId, credits);
      return result.ok ? res.json(result) : res.status(400).json(result);
    } catch (err) {
      logError('CREDIT_REFUND_ERROR', err, { clientId, jobId });
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
    const clientId = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.SUPERADMIN || req.user?.role === ROLES.OPERATOR
      ? (req.query.clientId || req.user?.id)
      : req.user?.id;

    if (!clientId) {
      return res.status(400).json({ ok: false, error: 'clientId could not be resolved' });
    }

    try {
      // Auto-provision a plan row for new users who haven't completed Stripe yet.
      // planTier comes from Clerk publicMetadata (already in req.user via middleware).
      const planTier = req.user?.planTier || 'operate';
      const plan = await getOrCreateClientPlan(clientId, planTier);
      const balance = await getCreditBalance(clientId);
      if (!balance || !plan) {
        return res.status(404).json({ ok: false, error: `No active plan for client ${clientId}` });
      }

      // Compute period end date from anchor day.
      // Use day 0 of the next month (= last day of current month) when anchor is 1,
      // otherwise use anchor-1 of the next month — but clamp to the real last day of
      // that month so we never roll into an extra month (e.g. Feb 30 → Mar 2).
      const now = new Date();
      const anchor = plan.billing_anchor_day || 1;
      let periodStart = new Date(now.getFullYear(), now.getMonth(), anchor);
      if (periodStart > now) periodStart = new Date(now.getFullYear(), now.getMonth() - 1, anchor);
      // Last day of the period = day before the next anchor. new Date(y, m+1, 0) = last day of month m.
      const periodEndRaw = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, anchor - 1);
      // Guard: if anchor - 1 === 0, new Date(y, m+1, 0) is already correct (last day of month m).
      // If it somehow landed in the wrong month (JS date overflow), pull back to last day of m+1.
      const expectedMonth = (periodStart.getMonth() + 1) % 12;
      const periodEnd = periodEndRaw.getMonth() !== expectedMonth
        ? new Date(periodStart.getFullYear(), periodStart.getMonth() + 2, 0)  // last day of month m+1
        : periodEndRaw;

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
    const clientId = req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.SUPERADMIN || req.user?.role === ROLES.OPERATOR
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
        createNotification(clientId, {
          type:      'credit_pack_purchased',
          title:     `${credits} credits added to your account`,
          body:      'Your credit pack is ready to use.',
          actionUrl: '/dashboard/credits',
        });
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
          await updateClientPlanTier(clientId, 'operate', null);
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

      // Product/price changes → invalidate the plans cache so next request re-fetches
      if (['product.created', 'product.updated', 'price.created', 'price.updated'].includes(event.type)) {
        invalidatePlansCache();
        console.log(`[stripe-webhook] ${event.type} — plans cache invalidated`);
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

// ── GET /plans — list available subscription plans (live from Stripe) ────────

router.get('/plans', apiLimit, async (req, res) => {
  try {
    const livePlans = await getPlans();
    const source = Object.keys(livePlans).length ? livePlans : PLANS;
    res.json({
      ok: true,
      source: Object.keys(livePlans).length ? 'stripe' : 'fallback',
      plans: Object.values(source).map((p) => ({
        id:          p.id,
        label:       p.label,
        credits:     p.credits,
        price_usd:   p.price_usd,
        brands:      p.brands,
        description: p.description || '',
        price_id:    p.price_id || process.env[`STRIPE_PRICE_${p.id.toUpperCase()}`] || null,
        interval:    p.interval || 'month',
      })),
    });
  } catch (err) {
    res.json({ ok: true, source: 'fallback', plans: Object.values(PLANS) });
  }
});

// ── POST /plans/subscribe — initiate Stripe subscription checkout (CPD-100) ───

router.post(
  '/plans/subscribe',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  body('planId').isIn(['operate', 'guided', 'managed']).withMessage('planId must be diy, dwy, or dfy'),
  body('successUrl').isURL().withMessage('successUrl must be a valid URL'),
  body('cancelUrl').isURL().withMessage('cancelUrl must be a valid URL'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

    const { planId, successUrl, cancelUrl } = req.body;
    const clientId = req.user.id;

    try {
      const { checkoutUrl, sessionId } = await createSubscriptionCheckoutSession(
        clientId, planId, successUrl, cancelUrl
      );
      return res.json({ ok: true, url: checkoutUrl, sessionId });
    } catch (err) {
      logError('PLAN_SUBSCRIBE_FAIL', err, { clientId, planId });
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── POST /plans/billing-portal — Stripe Customer Portal session ───────────────
// Returns a short-lived URL that lets a subscriber manage their payment method,
// download invoices, or cancel. Requires the customer to have an existing Stripe
// Customer record (created at first subscription checkout).

router.post(
  '/plans/billing-portal',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  body('returnUrl').isURL().withMessage('returnUrl must be a valid URL'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });

    const email = req.user?.email;
    if (!email) return res.status(400).json({ ok: false, error: 'User email not available' });

    const { returnUrl } = req.body;

    try {
      const { portalUrl } = await createBillingPortalSession(email, returnUrl);
      return res.json({ ok: true, url: portalUrl });
    } catch (err) {
      logError('BILLING_PORTAL_FAIL', err, { email });
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
