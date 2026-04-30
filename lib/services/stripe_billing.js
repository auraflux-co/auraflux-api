'use strict';

/**
 * Stripe billing service — CPD-45
 * Credit pack purchase flow via Stripe Checkout (one-time payments).
 */

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Pack definitions ──────────────────────────────────────────────────────────
// price_cents = USD cents; credits = number of production credits included.

const PACKS = {
  S:  { id: 'S',  credits: 5,  price_cents: 5500,  label: 'Pack S — 5 credits' },
  M:  { id: 'M',  credits: 15, price_cents: 15000, label: 'Pack M — 15 credits' },
  L:  { id: 'L',  credits: 30, price_cents: 27000, label: 'Pack L — 30 credits' },
  XL: { id: 'XL', credits: 60, price_cents: 48000, label: 'Pack XL — 60 credits' },
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

// ── Plan definitions (mirrors feature-gating.mdc) ────────────────────────────

const PLANS = {
  diy: { id: 'diy', label: 'DIY',   credits: 50,   price_usd: 29,  description: 'Self-serve, basic automations' },
  dwy: { id: 'dwy', label: 'DWY',   credits: 200,  price_usd: 99,  description: 'Assisted — AI tools, scheduling, VectCut, TTS' },
  dfy: { id: 'dfy', label: 'DFY',   credits: 1000, price_usd: 299, description: 'Full done-for-you — HeyGen, Imagen 3, direct publish APIs' },
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

module.exports = {
  PACKS,
  PLANS,
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  constructWebhookEvent,
  resolveSubscriptionTier,
};
