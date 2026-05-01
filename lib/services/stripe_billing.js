'use strict';

/**
 * Stripe billing service — CPD-45
 * Credit pack purchase flow via Stripe Checkout (one-time payments).
 */

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Pack definitions — CPD-115 ────────────────────────────────────────────────
// Feature-specific top-up packs. Each pack = 10 minutes of the feature.
// Price per minute is the customer-facing rate; credits reflect the rate card.
//   TTS narration   : 1 cr/min  × 10 min = 10 cr  @ $2/min  = $20
//   WAN T2V         : 6 cr/min  × 10 min = 60 cr  @ $12/min = $120
//   HeyGen std      : 30 cr/min × 10 min = 300 cr @ $30/min = $300
//   HeyGen Avatar IV: 120 cr/min× 10 min = 1200 cr@ $45/min = $450

const PACKS = {
  narration: {
    id:          'narration',
    credits:     10,
    price_cents: 2000,
    label:       'Clip Narration Pack',
    description: 'TTS narration — 10 min (10 credits) at $2/min',
    feature:     'tts',
    mins:        10,
    rate_per_min: 2,
  },
  text_to_video: {
    id:          'text_to_video',
    credits:     60,
    price_cents: 12000,
    label:       'Text to Video Pack',
    description: 'WAN T2V generation — 10 min (60 credits) at $12/min',
    feature:     'wan_t2v',
    mins:        10,
    rate_per_min: 12,
  },
  avatar: {
    id:          'avatar',
    credits:     300,
    price_cents: 30000,
    label:       'Avatar Pack',
    description: 'HeyGen standard avatar — 10 min (300 credits) at $30/min',
    feature:     'heygen_std',
    mins:        10,
    rate_per_min: 30,
  },
  avatar_iv: {
    id:          'avatar_iv',
    credits:     1200,
    price_cents: 45000,
    label:       'Avatar IV Pack',
    description: 'HeyGen Avatar IV — 10 min (1,200 credits) at $45/min',
    feature:     'heygen_iv',
    mins:        10,
    rate_per_min: 45,
  },
  shoppable: {
    id:          'shoppable',
    credits:     20,
    price_cents: 4000,
    label:       'Shoppable Pack',
    description: 'Shoppable video (FFmpeg CTA overlay + platform tagging) — 10 min (20 credits) at $4/min',
    feature:     'shoppable',
    mins:        10,
    rate_per_min: 4,
  },
};

function getStripe() {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(STRIPE_SECRET_KEY);
}

/**
 * Create a Stripe Checkout Session for a one-time credit pack purchase.
 * @param {string} clientId — AuraFlux client ID (stored in Checkout metadata)
 * @param {string} packId — 'S' | 'M' | 'L' | 'XL'
 * @param {string} successUrl — redirect URL on payment success
 * @param {string} cancelUrl — redirect URL on cancel
 * @returns {Promise<{ checkoutUrl: string, sessionId: string }>}
 */
async function createCheckoutSession(clientId, packId, successUrl, cancelUrl) {
  const pack = PACKS[packId];
  if (!pack) throw new Error(`Unknown pack ID: ${packId}`);

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: pack.price_cents,
          product_data: {
            name: pack.label,
            description: `${pack.credits} AuraFlux production credits`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      clientId,
      packId,
      credits: String(pack.credits),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

// ── Plan definitions ──────────────────────────────────────────────────────────
// Tier keys stay diy/dwy/dfy internally; brand names are Operate/Guided/Managed.

const PLANS = {
  diy: {
    id:          'diy',
    label:       'AuraFlux Operate',
    credits:     400,
    price_usd:   999,
    description: 'Run your content system — 1 brand, self-serve, guides + Copilot (guide mode)',
    brands:      1,
    copilot:     'guides',
    no_rollover: true,
  },
  dwy: {
    id:          'dwy',
    label:       'AuraFlux Guided',
    credits:     1200,
    price_usd:   2499,
    description: 'Build and optimize with us — 3 brands, full Copilot + SMS support',
    brands:      3,
    copilot:     'full',
    no_rollover: true,
  },
  dfy: {
    id:          'dfy',
    label:       'AuraFlux Managed',
    credits:     2000,
    price_usd:   4499,
    description: 'Full content operation, handled for you — 5 brands, Copilot + account manager',
    brands:      5,
    copilot:     'full',
    am:          true,
    no_rollover: true,
  },
};

/**
 * Create a Stripe Checkout Session for a plan subscription.
 * Requires STRIPE_PRICE_DIY / STRIPE_PRICE_DWY / STRIPE_PRICE_DFY env vars.
 * @param {string} clientId
 * @param {'diy'|'dwy'|'dfy'} planId
 * @param {string} successUrl
 * @param {string} cancelUrl
 */
async function createSubscriptionCheckoutSession(clientId, planId, successUrl, cancelUrl) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Unknown plan ID: ${planId}`);

  const priceEnvKey = `STRIPE_PRICE_${planId.toUpperCase()}`;
  const priceId = process.env[priceEnvKey];
  if (!priceId) throw new Error(`${priceEnvKey} not set — configure Stripe Price IDs in env`);

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { clientId, planId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

/**
 * Verify and parse an incoming Stripe webhook event.
 * @param {Buffer|string} rawBody
 * @param {string} signature — value of stripe-signature header
 * @returns {import('stripe').Stripe.Event}
 */
function constructWebhookEvent(rawBody, signature) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

/**
 * Map Stripe Price IDs to AuraFlux plan tiers.
 * Populated from env vars so the same code runs in test and prod.
 *
 * STRIPE_PRICE_DIY  → Stripe Price ID for the DIY subscription plan
 * STRIPE_PRICE_DWY  → Stripe Price ID for the DWY subscription plan
 * STRIPE_PRICE_DFY  → Stripe Price ID for the DFY subscription plan
 *
 * If the env vars aren't set, subscription tier updates are no-ops (safe in test).
 */
function resolveSubscriptionTier(priceId) {
  if (!priceId) return null;
  const map = {
    [process.env.STRIPE_PRICE_DIY]: 'diy',
    [process.env.STRIPE_PRICE_DWY]: 'dwy',
    [process.env.STRIPE_PRICE_DFY]: 'dfy',
  };
  return map[priceId] || null;
}

/**
 * Create a Stripe Customer Portal session so a subscriber can manage their
 * payment method, view invoices, and cancel. Looks up the Stripe Customer by
 * email since we don't store stripe_customer_id locally.
 *
 * @param {string} email — customer's email (from Clerk JWT)
 * @param {string} returnUrl — where Stripe redirects after the portal closes
 * @returns {Promise<{ portalUrl: string }>}
 */
async function createBillingPortalSession(email, returnUrl) {
  const stripe = getStripe();

  // Find the Stripe customer by email
  const { data: customers } = await stripe.customers.list({ email, limit: 1 });
  if (!customers.length) {
    throw new Error('No Stripe customer found for this account. Please subscribe to a plan first.');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customers[0].id,
    return_url: returnUrl,
  });

  return { portalUrl: session.url };
}

module.exports = {
  PACKS,
  PLANS,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
  constructWebhookEvent,
  resolveSubscriptionTier,
};
