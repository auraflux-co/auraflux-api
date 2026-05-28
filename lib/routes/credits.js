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
const { getCreditBalance, getClientPlan, getOrCreateClientPlan, getPool, insertCreditPack, hasStripeEvent, recordStripeEvent, updateClientPlanTier, updateBrandPlanTier, setAutoTopupEnabled } = require('../db');
const { createNotification } = require('../services/notifications');
const { PACKS, PLANS, getPlans, createCheckoutSession, createSubscriptionCheckoutSession, createBillingPortalSession, constructWebhookEvent, resolveSubscriptionTier, getOrCreateStripeCustomer, upgradeExistingSubscription } = require('../services/stripe_billing');
const { invalidateCache: invalidatePlansCache } = require('../services/stripe_plans_sync');
const { runOverageBillingCycle, getPendingOverageSummary } = require('../services/billing_cron');
const express = require('express');
const { logError } = require('../error_logger');

/**
 * CPD-381: Resolve the email for a Clerk user ID.
 * req.user.email is often null (Google OAuth JWTs omit it).
 * Falls back to Clerk API to get the primary email address.
 */
async function resolveEmailForUser(userId, sessionEmail) {
  if (sessionEmail) return sessionEmail;
  try {
    const { createClerkClient } = require('@clerk/express');
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const user = await clerk.users.getUser(userId);
    const primary = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;
  } catch (e) {
    logError('[credits] email lookup failed for', e, { userId });
    return null;
  }
}

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
  requireRole({ minLevel: ROLES.SUPERADMIN }),
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
  requireRole({ minLevel: ROLES.SUPERADMIN }),
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
    const clientId = req.user?.role === ROLES.SUPERADMIN
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
    const clientId = req.user?.role === ROLES.SUPERADMIN
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
          `SELECT id, job_id, credits_used AS credits, type, pack_id, created_at
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
    body('quantity').optional().isInt({ min: 1, max: 99 }).withMessage('quantity must be 1–99'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }
    const clientId = req.user?.id;
    const { packId, successUrl, cancelUrl, quantity = 1 } = req.body;
    try {
      // CPD-381: resolve customer so pack purchase links to the same Stripe Customer
      const email = await resolveEmailForUser(clientId, req.user?.email);
      const { checkoutUrl, sessionId } = await createCheckoutSession(
        clientId, packId, successUrl, cancelUrl, quantity, email
      );
      return res.json({ ok: true, checkoutUrl, sessionId, pack: PACKS[packId], quantity });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /credits/auto-topup (CPD-369) ────────────────────────────────────────
// Returns current auto top-up setting for the authenticated customer.

router.get(
  '/credits/auto-topup',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const clientId = req.user?.id;
      const plan = await getClientPlan(clientId);
      return res.json({
        ok: true,
        enabled: plan?.auto_topup_enabled ?? false,
        pack: { id: 'credit_topup', label: 'Credit Top-Up', credits: 50 },
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── POST /credits/auto-topup (CPD-369) ───────────────────────────────────────
// Enable or disable auto top-up for the authenticated customer.

router.post(
  '/credits/auto-topup',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  body('enabled').isBoolean().withMessage('enabled must be a boolean'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ ok: false, errors: errors.array() });
    try {
      const clientId = req.user?.id;
      await setAutoTopupEnabled(clientId, req.body.enabled);
      return res.json({ ok: true, enabled: req.body.enabled });
    } catch (err) {
      logError('AUTO_TOPUP_SET_FAIL', err, { clientId: req.user?.id });
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
  requireRole({ minLevel: ROLES.SUPERADMIN }),
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
  requireRole({ minLevel: ROLES.SUPERADMIN }),
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
// List available packs. Includes priceConfigured flag (same pattern as plans).
// A pack is purchasable when its STRIPE_PACK_PRICE_<ID> env var is set.

router.get('/credits/packs', apiLimit, (req, res) => {
  const packs = Object.values(PACKS).map((p) => ({
    ...p,
    priceConfigured: !!process.env[`STRIPE_PACK_PRICE_${p.id.toUpperCase()}`],
  }));
  res.json({ ok: true, packs });
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
        const clientId        = session.metadata?.clientId;
        const packId          = session.metadata?.packId;
        const stripePaymentId = session.payment_intent || session.id;

        // CPD-401: New subscription checkout (mode=subscription, no packId) → welcome email
        if (session.mode === 'subscription' && clientId && !packId) {
          const planId = session.metadata?.planId || 'operate';
          const PLAN_LABELS = { operate: 'AuraFlux Operate', guided: 'AuraFlux Guided', managed: 'AuraFlux Managed' };
          const planLabel = PLAN_LABELS[planId] || planId;
          try {
            const userEmail = await resolveEmailForUser(clientId, session.customer_email || null);
            if (userEmail) {
              const nodemailer = require('nodemailer');
              const transporter = nodemailer.createTransport({
                host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
                port:   Number(process.env.SMTP_PORT || 587),
                secure: false,
                auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
              });
              await transporter.sendMail({
                from:    `AuraFlux <${process.env.SMTP_USER || 'support@auraflux.co'}>`,
                to:      userEmail,
                subject: "You're in — start your first job on AuraFlux",
                html: `
                  <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
                    <h2 style="margin-bottom:4px">Welcome to AuraFlux</h2>
                    <p style="color:#64748b;margin-top:0">Your <strong>${planLabel}</strong> subscription is confirmed.</p>
                    <p>Your account is ready. Head to the dashboard to start building your first video production job.</p>
                    <a href="https://app.auraflux.co/home?checkout=success"
                       style="display:inline-block;margin:16px 0;padding:12px 24px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
                      Open AuraFlux
                    </a>
                    <p style="font-size:13px;color:#94a3b8">
                      Questions? Reply to this email or visit
                      <a href="https://docs.auraflux.co" style="color:#6366f1">docs.auraflux.co</a>.
                    </p>
                  </div>
                `,
              });
              console.log(`[stripe-webhook] welcome email sent to ${userEmail} for plan=${planId}`);
            }
          } catch (emailErr) {
            logError('[credits] welcome email failed', emailErr, { clientId, planId });
          }
          createNotification(clientId, {
            type:      'subscription_activated',
            title:     `${planLabel} is now active`,
            body:      'Your subscription is confirmed. Start your first job from the dashboard.',
            actionUrl: '/home',
          });
          return res.json({ ok: true });
        }

        // CPD-403: marketing-site pay-first flow — user paid before creating a Clerk account.
        // Store a pending subscription keyed to the Stripe session so the app can claim it
        // after the user signs up via Clerk.
        if (session.mode === 'subscription' && !clientId && session.metadata?.source === 'marketing_site') {
          const plan     = session.metadata?.plan || session.client_reference_id || 'operate';
          const email    = session.customer_email;
          const subId    = session.subscription;
          const custId   = session.customer;
          const sessId   = session.id;
          if (email && sessId) {
            const pool = getPool();
            await pool.query(
              `INSERT INTO pending_subscriptions
                (email, plan, stripe_session_id, stripe_subscription_id, stripe_customer_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (stripe_session_id) DO NOTHING`,
              [email.toLowerCase(), plan, sessId, subId || null, custId || null],
            );
            console.log(`[stripe-webhook] pending subscription stored: email=${email} plan=${plan} session=${sessId}`);
          }
          return res.json({ ok: true });
        }

        if (!clientId || !packId) {
          return res.status(422).json({ ok: false, error: 'Missing metadata in Checkout session' });
        }

        // CPD-369: customer may have changed qty using Stripe's adjustable_quantity
        // selector on the checkout page. Expand line_items to get the actual qty
        // rather than trusting the metadata.credits set at session creation.
        let credits = parseInt(session.metadata?.credits, 10) || 0;
        try {
          const { getStripe } = require('../services/stripe_billing');
          // getStripe() is not exported — use the Stripe secret directly
          const Stripe = require('stripe');
          const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
          const { data: lineItems } = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
          const li = lineItems?.[0];
          if (li && li.quantity) {
            const pack = PACKS[packId];
            credits = (pack?.credits || 0) * li.quantity;
          }
        } catch (_e) { /* fall through to metadata value */ }

        if (!credits) {
          return res.status(422).json({ ok: false, error: 'Could not determine credit amount from session' });
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
        const clientId       = sub.metadata?.clientId;
        const brandId        = sub.metadata?.brandId || null;  // CPD-328: brand-scoped routing
        const stripeCustomerId = sub.customer || null;          // CPD-369: store for auto top-up
        const priceId        = sub.items?.data?.[0]?.price?.id || null;
        const tier           = await resolveSubscriptionTier(priceId);
        if (tier) {
          if (brandId) {
            // Multi-brand path: update the specific brand's plan row
            await updateBrandPlanTier(brandId, tier, sub.id, stripeCustomerId);
            console.log(`[stripe-webhook] subscription.updated: brand=${brandId} → tier=${tier}`);
          } else if (clientId) {
            // Legacy single-brand path: update by clientId
            await updateClientPlanTier(clientId, tier, sub.id, stripeCustomerId);
            console.log(`[stripe-webhook] subscription.updated: client=${clientId} → tier=${tier}`);
          } else {
            console.warn(
              `[stripe-webhook] subscription.updated: could not resolve tier ` +
                `(clientId=${clientId}, brandId=${brandId}, priceId=${priceId}) — no plan update applied`
            );
          }
        } else {
          console.warn(
            `[stripe-webhook] subscription.updated: could not resolve tier ` +
              `(clientId=${clientId}, priceId=${priceId}) — no plan update applied`
          );
        }

      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const clientId = sub.metadata?.clientId;
        const brandId  = sub.metadata?.brandId || null;  // CPD-328
        if (brandId) {
          await updateBrandPlanTier(brandId, 'operate', null);
          console.log(`[stripe-webhook] subscription.deleted: brand=${brandId} → downgraded to operate`);
        } else if (clientId) {
          await updateClientPlanTier(clientId, 'operate', null);
          console.log(`[stripe-webhook] subscription.deleted: client=${clientId} → downgraded to operate`);
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
      plans: Object.values(source).map((p) => {
        const priceId = p.price_id || process.env[`STRIPE_PRICE_${p.id.toUpperCase()}`] || null;
        return {
          id:               p.id,
          label:            p.label,
          credits:          p.credits,
          price_usd:        p.price_usd,
          brands:           p.brands,
          description:      p.description || '',
          price_id:         priceId,
          interval:         p.interval || 'month',
          priceConfigured:  !!priceId,
        };
      }),
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

    const { planId, successUrl, cancelUrl, brandId = null } = req.body;
    const clientId = req.user.id;

    try {
      // CPD-381: resolve customer email + Stripe Customer ID
      const email = await resolveEmailForUser(clientId, req.user?.email);

      // CPD-382: if customer already has an active subscription, update it in
      // place (proration) instead of creating a second subscription via checkout.
      if (email) {
        try {
          const stripeCustomerId = await getOrCreateStripeCustomer(clientId, email);
          const { getPlan } = require('../services/stripe_billing');
          const livePlan = await getPlan(planId);
          const newPriceId = livePlan?.price_id || process.env[`STRIPE_PRICE_${planId.toUpperCase()}`];

          if (newPriceId) {
            const upgraded = await upgradeExistingSubscription(
              stripeCustomerId, newPriceId, clientId, planId
            );
            if (upgraded) {
              return res.json({ ok: true, upgraded: true });
            }
          }
        } catch (upgradeErr) {
          // Non-fatal — fall through to standard checkout session
          logError('PLAN_UPGRADE_DIRECT_FAIL', upgradeErr, { clientId, planId });
        }
      }

      // No existing subscription (or direct upgrade failed) — create checkout session
      // CPD-328: pass brandId so the Stripe metadata carries it through to the webhook
      const { checkoutUrl, sessionId } = await createSubscriptionCheckoutSession(
        clientId, planId, successUrl, cancelUrl, brandId || null, email
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

// ── POST /credits/claim-checkout ─────────────────────────────────────────────
// CPD-403: After a marketing-site pay-first customer creates their Clerk account,
// the app calls this endpoint with the Stripe session_id from the success URL.
// Finds the matching pending_subscriptions row (by session_id or customer email),
// activates the plan for the current user, and sends the welcome email.
router.post(
  '/credits/claim-checkout',
  apiLimit,
  requireAuth,
  async (req, res) => {
    const clientId   = req.user.id;
    const { session_id } = req.body || {};

    if (!session_id) {
      return res.status(400).json({ ok: false, error: 'session_id required' });
    }

    try {
      const pool = getPool();

      // Look up by session_id, not yet claimed, not expired
      const { rows } = await pool.query(
        `SELECT * FROM pending_subscriptions
         WHERE stripe_session_id = $1
           AND claimed_by IS NULL
           AND expires_at > NOW()
         LIMIT 1`,
        [session_id],
      );

      if (!rows.length) {
        return res.status(404).json({ ok: false, error: 'No unclaimed subscription found for this session' });
      }

      const pending = rows[0];
      const plan    = pending.plan;
      const PLAN_LABELS = { operate: 'AuraFlux Operate', guided: 'AuraFlux Guided', managed: 'AuraFlux Managed' };
      const planLabel = PLAN_LABELS[plan] || plan;

      // Apply the plan to the current user
      await updateClientPlanTier(
        clientId,
        plan,
        pending.stripe_subscription_id || null,
        pending.stripe_customer_id || null,
      );

      // Mark as claimed
      await pool.query(
        `UPDATE pending_subscriptions SET claimed_by = $1 WHERE id = $2`,
        [clientId, pending.id],
      );

      console.log(`[claim-checkout] plan=${plan} claimed by clientId=${clientId} from session=${session_id}`);

      // Send welcome email
      const userEmail = await resolveEmailForUser(clientId, req.user?.email || pending.email);
      if (userEmail && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({
            host:   process.env.SMTP_HOST,
            port:   Number(process.env.SMTP_PORT || 587),
            secure: false,
            auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          });
          await transporter.sendMail({
            from:    `AuraFlux <${process.env.SMTP_USER}>`,
            to:      userEmail,
            subject: "You're in — start your first job on AuraFlux",
            html: `
              <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
                <h2 style="margin-bottom:4px">Welcome to AuraFlux</h2>
                <p style="color:#64748b;margin-top:0">Your <strong>${planLabel}</strong> plan is now active.</p>
                <p>Your account is ready. Head to the dashboard to connect your first channel and start producing content.</p>
                <a href="https://app.auraflux.co/home"
                   style="display:inline-block;margin:16px 0;padding:12px 24px;background:#f5c542;color:#0b1220;border-radius:6px;text-decoration:none;font-weight:600">
                  Open AuraFlux
                </a>
                <p style="font-size:13px;color:#94a3b8">
                  Questions? Reply to this email or visit
                  <a href="https://docs.auraflux.co" style="color:#f5c542">docs.auraflux.co</a>.
                </p>
              </div>
            `,
          });
        } catch (emailErr) {
          logError('[claim-checkout] welcome email failed', emailErr, { clientId });
        }
      }

      // In-app notification
      createNotification(clientId, {
        type:      'subscription_activated',
        title:     `${planLabel} is now active`,
        body:      'Your plan is confirmed. Connect a channel to start your first job.',
        actionUrl: '/settings/channels',
      });

      return res.json({ ok: true, plan, claimed: true });
    } catch (err) {
      logError('CLAIM_CHECKOUT_FAIL', err, { clientId, session_id });
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
