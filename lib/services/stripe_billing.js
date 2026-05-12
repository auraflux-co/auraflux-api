'use strict';

/**
 * Stripe billing service — CPD-45
 * Credit pack purchase flow via Stripe Checkout (one-time payments).
 */

const Stripe = require('stripe');
const { getPlans, getPlan, resolvePriceTier } = require('./stripe_plans_sync');

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
    credits:     1200,
    price_cents: 45000,
    label:       'Avatar Pack',
    description: 'HeyGen Avatar IV — 10 min (1,200 credits) at $45/min',
    feature:     'heygen',
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

// ── Plan definitions — loaded live from Stripe (stripe_plans_sync.js) ────────
// PLANS is kept as a static fallback snapshot for code that calls it
// synchronously (e.g. GET /credits/packs). Async callers should use getPlans().
// Stripe is the authoritative source — update products/prices there, not here.
const PLANS = {
  diy: { id: 'diy', label: 'AuraFlux Operate', credits: 400, price_usd: 999, brands: 1, collab_mode: 'guides' },
  dwy: { id: 'dwy', label: 'AuraFlux Guided',  credits: 1200, price_usd: 2499, brands: 3, collab_mode: 'full' },
  dfy: { id: 'dfy', label: 'AuraFlux Managed', credits: 2000, price_usd: 4499, brands: 5, collab_mode: 'full', has_account_manager: true },
};

// Warm the cache at module load (non-blocking — failures fall back to PLANS above)
getPlans().catch(() => {});

/**
 * Create a Stripe Checkout Session for a plan subscription.
 * Price ID is sourced live from Stripe via stripe_plans_sync (falls back to env var).
 * @param {string} clientId
 * @param {'diy'|'dwy'|'dfy'} planId
 * @param {string} successUrl
 * @param {string} cancelUrl
 */
async function createSubscriptionCheckoutSession(clientId, planId, successUrl, cancelUrl) {
  // Prefer live Stripe data, fall back to env var
  const livePlan = await getPlan(planId);
  const priceId = livePlan?.price_id || process.env[`STRIPE_PRICE_${planId.toUpperCase()}`];
  if (!priceId) throw new Error(`No price ID found for plan ${planId} — check Stripe products or STRIPE_PRICE_${planId.toUpperCase()} env var`);

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
 * Map a Stripe Price ID to an AuraFlux plan tier.
 * Checks live Stripe data first (via stripe_plans_sync cache), falls back to env vars.
 * Returns null if the price ID is not recognised.
 */
async function resolveSubscriptionTier(priceId) {
  if (!priceId) return null;
  // Try live cache first (handles newly added plans automatically)
  const liveTier = await resolvePriceTier(priceId);
  if (liveTier) return liveTier;
  // Env-var fallback (covers test mode or cache miss)
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
  getPlans,   // async — live from Stripe, cached
  getPlan,    // async — single plan by tier ID
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
  constructWebhookEvent,
  resolveSubscriptionTier,
};
