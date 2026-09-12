'use strict';

/**
 * Managed add-on subscription state resolution (iss_05nin1trEmPm)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('isManagedAddonPriceId distinguishes add-on from base Managed price', () => {
  process.env.STRIPE_PRICE_MANAGED_ADDON = 'price_addon_test';
  process.env.STRIPE_PRICE_MANAGED = 'price_managed_full';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

  // Clear require cache so env is picked up
  delete require.cache[require.resolve('../lib/services/stripe_billing')];
  const { isManagedAddonPriceId, getManagedAddonPriceId } = require('../lib/services/stripe_billing');

  assert.equal(getManagedAddonPriceId(), 'price_addon_test');
  assert.equal(isManagedAddonPriceId('price_addon_test'), true);
  assert.equal(isManagedAddonPriceId('price_managed_full'), false);
  assert.equal(isManagedAddonPriceId(null), false);
});

test('resolveSubscriptionState: base + add-on items', async () => {
  process.env.STRIPE_PRICE_MANAGED_ADDON = 'price_addon_test';
  process.env.STRIPE_PRICE_OPERATE = 'price_operate_test';
  process.env.STRIPE_PRICE_GROWTH = 'price_growth_test';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

  delete require.cache[require.resolve('../lib/services/stripe_billing')];
  const { resolveSubscriptionState } = require('../lib/services/stripe_billing');

  const state = await resolveSubscriptionState({
    items: {
      data: [
        { price: { id: 'price_operate_test' } },
        { price: { id: 'price_addon_test' } },
      ],
    },
  });

  assert.equal(state.tier, 'operate');
  assert.equal(state.managedAddon, true);
});

test('resolveSubscriptionState: legacy full Managed alone', async () => {
  process.env.STRIPE_PRICE_MANAGED_ADDON = 'price_addon_test';
  process.env.STRIPE_PRICE_MANAGED = 'price_managed_full';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';

  delete require.cache[require.resolve('../lib/services/stripe_billing')];
  const { resolveSubscriptionState } = require('../lib/services/stripe_billing');

  const state = await resolveSubscriptionState({
    items: {
      data: [{ price: { id: 'price_managed_full' } }],
    },
  });

  assert.equal(state.tier, 'managed');
  assert.equal(state.managedAddon, true);
});
