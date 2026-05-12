'use strict';

/**
 * stripe_plans_sync.js — Stripe as source of truth for plan definitions
 *
 * Fetches live plan data from Stripe products tagged with metadata.auraflux_plan.
 * Caches in memory with a configurable TTL. Invalidated by product/price webhooks.
 *
 * Usage:
 *   const { getPlans, getPlan, invalidateCache } = require('./stripe_plans_sync');
 *   const plans = await getPlans();   // { diy: {...}, dwy: {...}, dfy: {...} }
 *   const diy   = await getPlan('diy');
 *
 * Adding a new plan in Stripe:
 *   1. Create a Product in Stripe Dashboard
 *   2. Add metadata: auraflux_plan=<tier>, credits_monthly=<n>, brands=<n>,
 *      collab_mode=<guides|full>, has_account_manager=<true|false>
 *   3. Add a recurring Price to the product
 *   4. Add STRIPE_PRICE_<TIER>=<price_id> to Render env vars
 *      (or run: node scripts/sync_stripe_plans.js)
 *   5. Add the tier to FEATURE_PLANS in lib/services/feature_gate.js
 *      (feature permissions are a code decision, not a Stripe concern)
 */

const Stripe = require('stripe');

// ── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — webhook invalidates sooner
let _cache = null;      // { plans: {}, fetchedAt: Date }
let _fetchPromise = null;

// ── Stripe plan tier → fallback env var price ID mapping ──────────────────
const PRICE_ENV_KEYS = {
  diy: 'STRIPE_PRICE_DIY',
  dwy: 'STRIPE_PRICE_DWY',
  dfy: 'STRIPE_PRICE_DFY',
};

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(key);
}

/**
 * Fetch all AuraFlux plans from Stripe products with auraflux_plan metadata.
 * Returns a map keyed by plan tier: { diy: PlanDef, dwy: PlanDef, dfy: PlanDef, ... }
 *
 * PlanDef shape:
 * {
 *   id:                  string   // 'diy' | 'dwy' | 'dfy' | custom tier
 *   label:               string   // product name from Stripe
 *   description:         string   // product description from Stripe
 *   credits:             number   // from metadata.credits_monthly
 *   brands:              number   // from metadata.brands
 *   collab_mode:         string   // 'guides' | 'full'
 *   has_account_manager: boolean
 *   price_usd:           number   // unit_amount in cents (e.g. 999 = $9.99)
 *   price_id:            string   // Stripe price ID
 *   product_id:          string   // Stripe product ID
 *   currency:            string   // 'usd'
 *   interval:            string   // 'month' | 'year'
 * }
 */
async function fetchPlansFromStripe() {
  const stripe = getStripe();

  // List all active products (up to 100 — more than enough for plan count)
  const products = await stripe.products.list({ active: true, limit: 100 });

  const plans = {};

  for (const product of products.data) {
    const tier = product.metadata?.auraflux_plan;
    if (!tier) continue; // not an AuraFlux plan product

    // Find the default active recurring price for this product
    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      type: 'recurring',
      limit: 10,
    });

    // Prefer the price ID we already have in env (for stability), fall back to first active
    const envPriceId = process.env[PRICE_ENV_KEYS[tier]];
    const price =
      prices.data.find(p => p.id === envPriceId) ||
      prices.data.find(p => p.recurring?.interval === 'month') ||
      prices.data[0];

    if (!price) {
      console.warn(`[stripe_plans_sync] No active price found for product ${product.id} (${tier}) — skipping`);
      continue;
    }

    plans[tier] = {
      id:                  tier,
      label:               product.name,
      description:         product.description || '',
      credits:             parseInt(product.metadata?.credits_monthly || '0', 10),
      brands:              parseInt(product.metadata?.brands || '1', 10),
      collab_mode:         product.metadata?.collab_mode || 'guides',
      has_account_manager: product.metadata?.has_account_manager === 'true',
      price_usd:           price.unit_amount,
      price_id:            price.id,
      product_id:          product.id,
      currency:            price.currency,
      interval:            price.recurring?.interval || 'month',
    };
  }

  return plans;
}

/**
 * Get all plans. Returns cached data if fresh, otherwise fetches from Stripe.
 * Falls back to env-var-only skeleton if Stripe is unreachable (safe for startup).
 */
async function getPlans() {
  // Return cache if still fresh
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.plans;
  }

  // Deduplicate concurrent fetches
  if (_fetchPromise) return _fetchPromise;

  _fetchPromise = (async () => {
    try {
      const plans = await fetchPlansFromStripe();
      _cache = { plans, fetchedAt: Date.now() };
      console.log(`[stripe_plans_sync] Loaded ${Object.keys(plans).length} plans from Stripe:`, Object.keys(plans).join(', '));
      return plans;
    } catch (err) {
      console.error('[stripe_plans_sync] Failed to fetch from Stripe, using fallback:', err.message);
      // Return last known cache if available, otherwise empty
      return _cache?.plans || {};
    } finally {
      _fetchPromise = null;
    }
  })();

  return _fetchPromise;
}

/**
 * Get a single plan definition by tier ID.
 */
async function getPlan(tierId) {
  const plans = await getPlans();
  return plans[tierId] || null;
}

/**
 * Invalidate the cache. Called by the webhook handler when Stripe notifies
 * of product or price changes. Next call to getPlans() will re-fetch.
 */
function invalidateCache() {
  _cache = null;
  console.log('[stripe_plans_sync] Cache invalidated — will re-fetch on next request');
}

/**
 * Resolve a Stripe price ID to a plan tier (for webhook event handling).
 * Returns the tier string ('diy', 'dwy', etc.) or null.
 */
async function resolvePriceTier(priceId) {
  const plans = await getPlans();
  const match = Object.values(plans).find(p => p.price_id === priceId);
  return match?.id || null;
}

module.exports = { getPlans, getPlan, invalidateCache, resolvePriceTier };
