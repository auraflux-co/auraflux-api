#!/usr/bin/env node
'use strict';

/**
 * sync_stripe_plans.js — Sync Stripe plan data → Render env vars
 *
 * Run manually after making changes in the Stripe dashboard:
 *   node scripts/sync_stripe_plans.js
 *
 * What it does:
 *   1. Fetches all active Stripe products tagged with metadata.auraflux_plan
 *   2. For each plan, finds the active recurring price
 *   3. Updates Render env vars STRIPE_PRICE_<TIER> with the current price IDs
 *   4. Prints a summary of all plans with current names, prices, and credits
 *
 * Adding a new plan:
 *   1. Create a Product in Stripe Dashboard
 *   2. Add metadata: auraflux_plan=<tier>, credits_monthly=<n>, brands=<n>,
 *      collab_mode=<guides|full>, has_account_manager=<true|false>
 *   3. Add a recurring Price to the product
 *   4. Run this script — it auto-registers the price ID in Render
 *   5. Add the tier to FEATURE_PLANS in lib/services/feature_gate.js
 *
 * Changing a plan price:
 *   1. In Stripe Dashboard: Products → your plan → Add Price (new price)
 *   2. Archive the old price
 *   3. Run this script — it finds the new active price and updates Render
 *
 * Renaming a plan:
 *   1. In Stripe Dashboard: Products → your plan → Edit name
 *   2. No script needed — the app reads the name live from Stripe at runtime
 */

require('dotenv').config();
const Stripe = require('stripe');
const https = require('https');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_API_SERVICE_ID = process.env.RENDER_API_SERVICE_ID || 'srv-d7nsd77avr4c73frifcg';

if (!STRIPE_SECRET_KEY) { console.error('❌  STRIPE_SECRET_KEY not set'); process.exit(1); }
if (!RENDER_API_KEY)    { console.error('❌  RENDER_API_KEY not set'); process.exit(1); }

const stripe = Stripe(STRIPE_SECRET_KEY);

// ── Helpers ────────────────────────────────────────────────────────────────

function renderRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.render.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔍  Fetching AuraFlux plans from Stripe…\n');

  // 1. List all active products with auraflux_plan metadata
  const products = await stripe.products.list({ active: true, limit: 100 });
  const aurafluxProducts = products.data.filter(p => p.metadata?.auraflux_plan);

  if (!aurafluxProducts.length) {
    console.error('❌  No Stripe products found with metadata.auraflux_plan.');
    console.error('   Add metadata to your products: auraflux_plan=diy (or dwy/dfy/custom)');
    process.exit(1);
  }

  const planUpdates = {};  // { STRIPE_PRICE_DIY: 'price_xxx', ... }
  const planSummary = [];

  for (const product of aurafluxProducts) {
    const tier = product.metadata.auraflux_plan.toUpperCase();

    // Find the active recurring price
    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      type: 'recurring',
      limit: 10,
    });

    const price = prices.data.find(p => p.recurring?.interval === 'month') || prices.data[0];
    if (!price) {
      console.warn(`⚠️  No active recurring price for ${product.name} (${tier}) — skipping`);
      continue;
    }

    const envKey = `STRIPE_PRICE_${tier}`;
    planUpdates[envKey] = price.id;

    planSummary.push({
      tier: tier.toLowerCase(),
      name: product.name,
      price_id: price.id,
      price_usd: `$${(price.unit_amount / 100).toFixed(2)}/mo`,
      credits: product.metadata?.credits_monthly || '?',
      brands: product.metadata?.brands || '?',
    });
  }

  // 2. Print summary
  console.log('📦  Plans found:\n');
  console.table(planSummary);

  // 3. Fetch current Render env vars
  console.log('\n🔧  Fetching current Render env vars…');
  const currentVars = await renderRequest('GET', `/v1/services/${RENDER_API_SERVICE_ID}/env-vars?limit=100`);
  const existingMap = {};
  for (const item of currentVars) {
    const ev = item.envVar || item;
    existingMap[ev.key] = ev.value || '';
  }

  // 4. Merge updates
  let changed = 0;
  for (const [key, value] of Object.entries(planUpdates)) {
    if (existingMap[key] === value) {
      console.log(`  ✅  ${key} unchanged (${value})`);
    } else {
      console.log(`  🔄  ${key}: ${existingMap[key] || '(not set)'} → ${value}`);
      existingMap[key] = value;
      changed++;
    }
  }

  if (!changed) {
    console.log('\n✅  All Render env vars already up to date — nothing to change.\n');
    return;
  }

  // 5. Write updated env vars back to Render (safe GET-merge-PUT)
  const payload = Object.entries(existingMap).map(([key, value]) => ({ key, value }));
  console.log(`\n📤  Writing ${changed} updated var(s) to Render…`);
  const result = await renderRequest('PUT', `/v1/services/${RENDER_API_SERVICE_ID}/env-vars`, payload);
  console.log(`✅  Updated ${result.length ?? '?'} env vars on Render.`);
  console.log('\n⚡  A redeploy is NOT needed — env var updates take effect on next deploy.');
  console.log('   If you want the change immediately, trigger a redeploy in the Render dashboard.\n');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
