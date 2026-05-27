'use strict';

/**
 * Stripe billing service — CPD-45
 * Credit pack purchase flow via Stripe Checkout (one-time payments).
 * CPD-381: getOrCreateStripeCustomer — single customer per client, shared across all flows.
 * CPD-382: upgradeExistingSubscription — update instead of creating second subscription.
 * CPD-384: automatic_payment_methods on checkout sessions.
 */

const Stripe = require('stripe');
const { getPlans, getPlan, resolvePriceTier } = require('./stripe_plans_sync');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Pack definitions — CPD-115 ────────────────────────────────────────────────
// Credit packs — either generic top-ups or feature-specific add-ons.
// Pricing and credit amounts subject to review (see CPD-318).
//
// Generic top-up:
//   credit_topup : 50 cr @ $100 flat  — buy when monthly credits run out
//
// Feature-specific (10 min each):
//   TTS narration   : 1 cr/min  × 10 min = 10 cr  @ $2/min  = $20
//   WAN T2V         : 6 cr/min  × 10 min = 60 cr  @ $12/min = $120
//   HeyGen std      : 30 cr/min × 10 min = 300 cr @ $30/min = $300
//   HeyGen Avatar IV: 120 cr/min× 10 min = 1200 cr@ $45/min = $450

const PACKS = {
  credit_topup: {
    id:          'credit_topup',
    credits:     50,
    price_cents: 10000,
    label:       'Credit Top-Up',
    description: '50 credits — add capacity when your monthly allowance runs out',
    feature:     null,
    mins:        null,
    rate_per_min: null,
  },
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
 * CPD-381: Resolve (and cache) the Stripe Customer for a given AuraFlux client.
 *
 * Priority:
 *  1. client_plans.stripe_customer_id (DB cache — fastest, avoids Stripe lookup)
 *  2. Stripe customer list search by email (find or create)
 *
 * Always writes the resolved ID back to DB so future calls hit the cache.
 *
 * @param {string} clientId  — AuraFlux Clerk user ID
 * @param {string} email     — customer email (from Clerk)
 * @returns {Promise<string>} Stripe Customer ID (cus_xxx)
 */
async function getOrCreateStripeCustomer(clientId, email) {
  const { getStripeCustomerId, setStripeCustomerId } = require('../db/postgres');
  const stripe = getStripe();

  // 1. Check DB cache
  const cached = await getStripeCustomerId(clientId);
  if (cached) return cached;

  // 2. Look up by email in Stripe
  const { data } = await stripe.customers.list({ email, limit: 1 });
  const customer = data.length
    ? data[0]
    : await stripe.customers.create({ email, metadata: { clientId } });

  // 3. Store for future calls
  await setStripeCustomerId(clientId, customer.id);
  return customer.id;
}

/**
 * CPD-382: Upgrade an existing Stripe subscription to a new plan price.
 *
 * If the customer has an active subscription, updates it in place with proration.
 * Returns the updated subscription object, or null if no active subscription exists
 * (caller should fall through to creating a new checkout session).
 *
 * @param {string} stripeCustomerId  — Stripe cus_xxx
 * @param {string} newPriceId        — Target Stripe price ID
 * @param {string} clientId          — AuraFlux client ID (for DB update)
 * @param {string} planId            — New plan tier name ('guided' | 'managed')
 * @returns {Promise<object|null>}
 */
async function upgradeExistingSubscription(stripeCustomerId, newPriceId, clientId, planId) {
  const stripe = getStripe();

  const { data: subs } = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status:   'active',
    limit:    1,
  });
  if (!subs.length) return null;

  const sub = subs[0];

  // CPD-385 G2: find the subscription item that corresponds to one of the
  // known AuraFlux plan prices, not just data[0] which may be an add-on.
  // Build a set of all known plan price IDs (env vars + any cached live prices).
  const knownPlanPriceIds = new Set(
    ['STRIPE_PRICE_OPERATE', 'STRIPE_PRICE_GUIDED', 'STRIPE_PRICE_MANAGED']
      .map((k) => process.env[k])
      .filter(Boolean),
  );
  // Include the target price so a new subscriber without a cached env var
  // can still be matched by their current item's price if it equals newPriceId.
  const planItem = sub.items.data.find(
    (i) => knownPlanPriceIds.has(i.price.id) || i.price.id === sub.items.data[0]?.price?.id,
  );

  // If we cannot identify exactly one plan item, bail out and let the caller
  // fall through to a new checkout session (safer than updating the wrong item).
  if (!planItem) return null;

  const updated = await stripe.subscriptions.update(sub.id, {
    items:               [{ id: planItem.id, price: newPriceId }],
    proration_behavior:  'create_prorations',
  });

  // Sync tier in DB immediately — webhook will also fire but this is faster
  const { updateClientPlanTier } = require('../db/postgres');
  await updateClientPlanTier(clientId, planId, updated.id, stripeCustomerId);

  return updated;
}

/**
 * Resolve a Stripe Price ID for a credit pack.
 * Checks env vars first (STRIPE_PACK_PRICE_<PACK_ID_UPPER>),
 * then falls back to searching Stripe products by metadata.pack_id.
 * Returns null when no price is configured — pack is not purchasable.
 */
async function resolvePackPriceId(stripe, packId) {
  // 1. Env var (fastest — set after creating product in Stripe dashboard)
  const envKey = `STRIPE_PACK_PRICE_${packId.toUpperCase()}`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;

  // 2. Stripe catalog: look for active product with metadata.pack_id == packId
  try {
    const { data: products } = await stripe.products.list({ active: true, limit: 100 });
    const match = products.find((p) => p.metadata?.pack_id === packId);
    if (match) {
      const { data: prices } = await stripe.prices.list({
        product: match.id,
        active:  true,
        type:    'one_time',
        limit:   1,
      });
      if (prices.length) return prices[0].id;
    }
  } catch { /* non-fatal — fall through */ }

  return null;
}

/**
 * Create a Stripe Checkout Session for a one-time credit pack purchase.
 *
 * Prefers a catalog Stripe Price ID (env var STRIPE_PACK_PRICE_<ID> or Stripe
 * product with metadata.pack_id). Falls back to inline price_data so existing
 * customers are never blocked even before pack products are in the catalog.
 *
 * @param {string} clientId — AuraFlux client ID (stored in Checkout metadata)
 * @param {string} packId   — key from PACKS (e.g. 'narration', 'text_to_video')
 * @param {string} successUrl
 * @param {string} cancelUrl
 * @returns {Promise<{ checkoutUrl: string, sessionId: string }>}
 */
async function createCheckoutSession(clientId, packId, successUrl, cancelUrl, quantity = 1, email = null) {
  const pack = PACKS[packId];
  if (!pack) throw new Error(`Unknown pack ID: ${packId}`);

  const qty    = Math.max(1, Math.min(99, parseInt(quantity, 10) || 1));
  const stripe = getStripe();
  const priceId = await resolvePackPriceId(stripe, packId);

  // CPD-381 / CPD-385 G1: resolve and require customer linkage.
  // Errors propagate to the route handler — checkout must not proceed as a
  // guest because that defeats the single-customer-per-client guarantee.
  let customerParam = {};
  if (email) {
    const cid = await getOrCreateStripeCustomer(clientId, email);
    customerParam = { customer: cid };
  }

  // CPD-369: credit_topup pack uses Stripe's native adjustable_quantity so
  // customers can change the amount directly on the hosted checkout page.
  // Other feature packs are fixed at qty 1 (they represent a specific minute
  // bundle — buying 2× would be unusual and confusing).
  const adjustable = packId === 'credit_topup'
    ? { adjustable_quantity: { enabled: true, minimum: 1, maximum: 99 } }
    : {};

  const lineItem = priceId
    ? { price: priceId, quantity: qty, ...adjustable }
    : {
        price_data: {
          currency:     'usd',
          unit_amount:  pack.price_cents,
          product_data: {
            name:        pack.label,
            description: `${pack.credits} AuraFlux production credits`,
          },
        },
        quantity: qty,
        ...adjustable,
      };

  const totalCredits = pack.credits * qty;

  const session = await stripe.checkout.sessions.create({
    mode:                       'payment',
    automatic_payment_methods:  { enabled: true },
    line_items:                 [lineItem],
    ...customerParam,
    metadata: {
      clientId,
      packId,
      credits:  String(totalCredits),
      quantity: String(qty),
    },
    success_url: successUrl,
    cancel_url:  cancelUrl,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

// ── Plan definitions — loaded live from Stripe (stripe_plans_sync.js) ────────
// PLANS is kept as a static fallback snapshot for code that calls it
// synchronously (e.g. GET /credits/packs). Async callers should use getPlans().
// Stripe is the authoritative source — update products/prices there, not here.
const PLANS = {
  operate: { id: 'operate', label: 'AuraFlux Operate', credits: 400, price_usd: 999, brands: 1, collab_mode: 'guides' },
  guided: { id: 'guided', label: 'AuraFlux Guided',  credits: 1200, price_usd: 2499, brands: 3, collab_mode: 'full' },
  managed: { id: 'managed', label: 'AuraFlux Managed', credits: 2000, price_usd: 4499, brands: 5, collab_mode: 'full', has_account_manager: true },
};

// Warm the cache at module load (non-blocking — failures fall back to PLANS above)
getPlans().catch(() => {});

/**
 * Create a Stripe Checkout Session for a plan subscription.
 * Price ID is sourced live from Stripe via stripe_plans_sync (falls back to env var).
 * @param {string} clientId
 * @param {'operate'|'guided'|'managed'} planId
 * @param {string} successUrl
 * @param {string} cancelUrl
 * @param {string|null} [brandId] - CPD-328: UUID of the brand this subscription is for
 */
async function createSubscriptionCheckoutSession(clientId, planId, successUrl, cancelUrl, brandId = null, email = null) {
  // Prefer live Stripe data, fall back to env var
  const livePlan = await getPlan(planId);
  const priceId = livePlan?.price_id || process.env[`STRIPE_PRICE_${planId.toUpperCase()}`];
  if (!priceId) throw new Error(`No price ID found for plan ${planId} — check Stripe products or STRIPE_PRICE_${planId.toUpperCase()} env var`);

  const stripe = getStripe();
  const metadata = { clientId, planId };
  if (brandId) metadata.brandId = brandId;  // CPD-328: brand context for webhook routing

  // CPD-381 / CPD-385 G1: require customer linkage — errors propagate
  let customerParam = {};
  if (email) {
    const cid = await getOrCreateStripeCustomer(clientId, email);
    customerParam = { customer: cid };
  }

  const session = await stripe.checkout.sessions.create({
    mode:                       'subscription',
    automatic_payment_methods:  { enabled: true },
    line_items:                 [{ price: priceId, quantity: 1 }],
    ...customerParam,
    metadata,
    // CPD-363: copy metadata onto the Subscription object so webhook handlers
    // reading sub.metadata.clientId / sub.metadata.brandId work correctly.
    // Stripe does not auto-copy session metadata to subscription_data.
    subscription_data: { metadata },
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
    [process.env.STRIPE_PRICE_OPERATE]: 'operate',
    [process.env.STRIPE_PRICE_GUIDED]: 'guided',
    [process.env.STRIPE_PRICE_MANAGED]: 'managed',
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

/**
 * Attempt an off-session charge for the credit_topup pack (CPD-369).
 *
 * Requires the customer to have a saved payment method in Stripe.
 * Uses the Stripe customer ID stored in client_plans.stripe_customer_id,
 * or falls back to looking up by email.
 *
 * Returns { ok: true, credits } on success, { ok: false, reason } on failure.
 * Never throws — caller treats failure as a soft error and falls through to PAUSED.
 *
 * @param {object} plan     — client_plans row (must have stripe_customer_id or no email available)
 * @param {string} [email]  — customer email, used as fallback customer lookup
 * @param {string} clientId — for insertCreditPack
 */
async function attemptAutoTopup(plan, email, clientId) {
  try {
    const stripe = getStripe();
    const pack = PACKS.credit_topup;
    if (!pack) return { ok: false, reason: 'credit_topup pack not defined' };

    const priceId = await resolvePackPriceId(stripe, 'credit_topup');
    if (!priceId) return { ok: false, reason: 'credit_topup has no configured Stripe price' };

    // Resolve Stripe customer
    let customerId = plan?.stripe_customer_id || null;
    if (!customerId && email) {
      const { data: customers } = await stripe.customers.list({ email, limit: 1 });
      customerId = customers[0]?.id || null;
    }
    if (!customerId) return { ok: false, reason: 'No Stripe customer found for auto top-up' };

    // Get default payment method
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });
    const pmId = customer.invoice_settings?.default_payment_method?.id
      || (typeof customer.invoice_settings?.default_payment_method === 'string'
        ? customer.invoice_settings.default_payment_method
        : null);
    if (!pmId) return { ok: false, reason: 'No default payment method saved — customer must update card' };

    // Charge off-session
    const price = await stripe.prices.retrieve(priceId);
    const pi = await stripe.paymentIntents.create({
      amount:               price.unit_amount,
      currency:             price.currency || 'usd',
      customer:             customerId,
      payment_method:       pmId,
      confirm:              true,
      off_session:          true,
      description:          `AuraFlux auto top-up — ${pack.credits} credits`,
      metadata: {
        clientId,
        packId:  'credit_topup',
        credits: String(pack.credits),
        source:  'auto_topup',
      },
    });

    if (pi.status !== 'succeeded') {
      return { ok: false, reason: `Payment ${pi.status} — requires customer action` };
    }

    // Insert credits
    const { insertCreditPack } = require('../db');
    await insertCreditPack(clientId, pack.credits, pi.id);

    return { ok: true, credits: pack.credits, paymentIntentId: pi.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  PACKS,
  PLANS,
  getPlans,   // async — live from Stripe, cached
  getPlan,    // async — single plan by tier ID
  getOrCreateStripeCustomer,        // CPD-381
  upgradeExistingSubscription,      // CPD-382
  createCheckoutSession,
  createSubscriptionCheckoutSession,
  createBillingPortalSession,
  constructWebhookEvent,
  resolveSubscriptionTier,
  attemptAutoTopup,
};
