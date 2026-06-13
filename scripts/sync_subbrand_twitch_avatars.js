#!/usr/bin/env node
'use strict';
/**
 * scripts/sync_subbrand_twitch_avatars.js — CPD-1006 bulk onboarding
 *
 * Sync Twitch profile_image_url → brands.image_url for all active brands
 * under an account (defaults to robert@auraflux.co CPD-869 sub-brands).
 *
 * Usage:
 *   node scripts/sync_subbrand_twitch_avatars.js
 *   node scripts/sync_subbrand_twitch_avatars.js --account user_3DeZESHSt4pqQtkDuYJoGDicm2q
 *   node scripts/sync_subbrand_twitch_avatars.js --force
 */

require('dotenv').config();

const { getBrandsForAccount } = require('../lib/db/postgres');
const { syncBrandFromTwitch, resolveTwitchLoginForBrand } = require('../lib/services/brand_twitch_sync');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const accountIdx = args.indexOf('--account');
  const accountId = accountIdx >= 0 ? args[accountIdx + 1] : (process.env.AURAFLUX_CPD869_CLERK_USER || 'user_3DeZESHSt4pqQtkDuYJoGDicm2q');

  console.log(`[sync_subbrand_twitch_avatars] account=${accountId} force=${force}`);

  const brands = await getBrandsForAccount(accountId);
  if (!brands.length) {
    console.error('No brands found for account');
    process.exit(1);
  }

  const results = [];
  for (const brand of brands) {
    const login = await resolveTwitchLoginForBrand(brand.id);
    if (!login) {
      results.push({ brand: brand.slug || brand.name, status: 'skip', reason: 'no_twitch_login' });
      continue;
    }
    const out = await syncBrandFromTwitch({
      brandId: brand.id,
      accountId,
      twitchLogin: login,
      force,
    });
    results.push({
      brand: brand.slug || brand.name,
      login,
      status: out.ok ? (out.skipped ? 'skipped' : 'synced') : 'fail',
      imageUrl: out.imageUrl || null,
      error: out.error || null,
    });
    console.log(`  ${brand.slug || brand.name}: ${out.ok ? (out.skipped ? 'already set' : 'synced') : out.error}`);
  }

  const synced  = results.filter((r) => r.status === 'synced').length;
  const failed  = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'skip').length;
  console.log(`\nDone: ${synced} synced, ${failed} failed, ${skipped} skipped/no-login`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
