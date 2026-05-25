'use strict';
/**
 * Billing routes — native payment method management (CPD-336)
 *
 * GET  /billing/payment-method   — current default card on file
 * POST /billing/setup-intent      — create SetupIntent to collect a new card
 * POST /billing/payment-method    — attach confirmed payment method + set as default
 * GET  /billing/invoices          — paginated invoice list from Stripe
 */

const express = require('express');
const { requireAuth, requireRole, ROLES } = require('../middleware/auth');
const { apiLimit } = require('../middleware/rate_limit');

const Stripe = require('stripe');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  return Stripe(key);
}

/**
 * Resolve the Stripe Customer for the authenticated user.
 * Looks up by email (we don't store stripe_customer_id locally yet).
 * Creates a customer if one doesn't exist.
 */
async function resolveStripeCustomer(stripe, email) {
  const { data } = await stripe.customers.list({ email, limit: 1 });
  if (data.length) return data[0];
  return stripe.customers.create({ email });
}

const router = express.Router();

// ── GET /billing/payment-method ────────────────────────────────────────────────
// Returns the default payment method (card brand, last4, expiry) or null.

router.get(
  '/billing/payment-method',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const stripe   = getStripe();
      const email    = req.user?.email;
      if (!email) return res.status(400).json({ ok: false, error: 'No email on session' });

      const customer = await resolveStripeCustomer(stripe, email);

      // Retrieve default payment method
      const pmId = customer.invoice_settings?.default_payment_method
                || customer.default_source;

      if (!pmId) return res.json({ ok: true, paymentMethod: null });

      const pm = typeof pmId === 'string'
        ? await stripe.paymentMethods.retrieve(pmId)
        : pmId;

      if (pm.type !== 'card') return res.json({ ok: true, paymentMethod: null });

      return res.json({
        ok: true,
        paymentMethod: {
          id:       pm.id,
          brand:    pm.card.brand,
          last4:    pm.card.last4,
          expMonth: pm.card.exp_month,
          expYear:  pm.card.exp_year,
        },
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── POST /billing/setup-intent ─────────────────────────────────────────────────
// Creates a Stripe SetupIntent and returns its client_secret for use with
// Stripe Elements on the frontend.

router.post(
  '/billing/setup-intent',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const stripe   = getStripe();
      const email    = req.user?.email;
      if (!email) return res.status(400).json({ ok: false, error: 'No email on session' });

      const customer = await resolveStripeCustomer(stripe, email);

      const intent = await stripe.setupIntents.create({
        customer:             customer.id,
        payment_method_types: ['card'],
        usage:                'off_session',
      });

      return res.json({ ok: true, clientSecret: intent.client_secret });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── POST /billing/payment-method ───────────────────────────────────────────────
// Attaches a confirmed paymentMethodId to the customer and sets it as default
// on both the customer and their active subscription.

router.post(
  '/billing/payment-method',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const { paymentMethodId } = req.body;
      if (!paymentMethodId) return res.status(400).json({ ok: false, error: 'paymentMethodId required' });

      const stripe   = getStripe();
      const email    = req.user?.email;
      if (!email) return res.status(400).json({ ok: false, error: 'No email on session' });

      const customer = await resolveStripeCustomer(stripe, email);

      // Attach if not already attached
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id })
        .catch((err) => {
          if (err.code !== 'payment_method_already_attached') throw err;
        });

      // Set as default on customer invoice settings
      await stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });

      // Update active subscription default payment method (if any)
      const { data: subs } = await stripe.subscriptions.list({
        customer: customer.id,
        status:   'active',
        limit:    1,
      });
      if (subs.length) {
        await stripe.subscriptions.update(subs[0].id, {
          default_payment_method: paymentMethodId,
        });
      }

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /billing/invoices ──────────────────────────────────────────────────────
// Returns the last 24 invoices for the customer.

router.get(
  '/billing/invoices',
  apiLimit,
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const stripe   = getStripe();
      const email    = req.user?.email;
      if (!email) return res.status(400).json({ ok: false, error: 'No email on session' });

      const customer = await resolveStripeCustomer(stripe, email);

      const { data: invoices } = await stripe.invoices.list({
        customer: customer.id,
        limit:    24,
      });

      return res.json({
        ok: true,
        invoices: invoices.map((inv) => ({
          id:          inv.id,
          number:      inv.number,
          date:        inv.created,
          amountDue:   inv.amount_due,
          amountPaid:  inv.amount_paid,
          currency:    inv.currency,
          status:      inv.status,
          pdfUrl:      inv.invoice_pdf,
          hostedUrl:   inv.hosted_invoice_url,
          description: inv.lines?.data?.[0]?.description ?? null,
        })),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

module.exports = router;
