#!/usr/bin/env node
'use strict';
/**
 * scripts/sync_subbrand_twitch_avatars.js — CPD-1006 bulk onboarding
 *
 * Sync Twitch profile_image_url → R2 → brands.image_url for all active brands.
 *
 * Usage:
 *   node scripts/sync_subbrand_twitch_avatars.js --via-api          # no DB — uses production API
 *   node scripts/sync_subbrand_twitch_avatars.js --via-api --force
 *   node scripts/sync_subbrand_twitch_avatars.js                    # requires DATABASE_URL
 */

require('dotenv').config();

const https = require('https');

const ACCOUNT_ID = process.env.AURAFLUX_CPD869_CLERK_USER || 'user_3DeZESHSt4pqQtkDuYJoGDicm2q';
const BASE       = (process.env.AURAFLUX_E2E_BASE || 'https://auraflux-api.onrender.com').replace(/\/$/, '');
const E2E_SECRET = process.env.E2E_AUTH_SECRET || '';

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers: {
        Authorization:  `Bearer clerk_user_${ACCOUNT_ID}`,
        'Content-Type': 'application/json',
      },
    };
    if (E2E_SECRET) opts.headers['X-E2E-Secret'] = E2E_SECRET;
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function syncViaApi(force) {
  const { fetchTwitchAvatarToR2 } = require('../lib/services/brand_twitch_sync');

  const listResp = await apiRequest('GET', '/brands');
  if (listResp.status !== 200 || !listResp.body?.brands) {
    throw new Error(`GET /brands failed (${listResp.status}): ${JSON.stringify(listResp.body).slice(0, 200)}`);
  }

  const brands = listResp.body.brands;
  console.log(`[sync] via-api: ${brands.length} brands for ${ACCOUNT_ID} force=${force}`);

  const results = [];
  for (const brand of brands) {
    const slug = (brand.slug || brand.name || '').toLowerCase();
    if (!slug || brand.is_primary) {
      results.push({ brand: slug || brand.name, status: 'skip', reason: brand.is_primary ? 'primary' : 'no_slug' });
      continue;
    }
    if (brand.image_url && !force) {
      results.push({ brand: slug, status: 'skipped', imageUrl: brand.image_url });
      console.log(`  ${slug}: already set`);
      continue;
    }

    const fetched = await fetchTwitchAvatarToR2({
      brandId:     brand.id,
      accountId:   ACCOUNT_ID,
      twitchLogin: slug,
    });
    if (!fetched.ok) {
      results.push({ brand: slug, status: 'fail', error: fetched.error });
      console.log(`  ${slug}: FAIL — ${fetched.error}`);
      continue;
    }

    const patch = await apiRequest('PATCH', `/brands/${brand.id}`, { image_url: fetched.imageUrl });
    if (patch.status !== 200) {
      results.push({ brand: slug, status: 'fail', error: `PATCH ${patch.status}` });
      console.log(`  ${slug}: PATCH failed (${patch.status})`);
      continue;
    }

    results.push({ brand: slug, status: 'synced', imageUrl: fetched.imageUrl });
    console.log(`  ${slug}: synced → ${fetched.imageUrl}`);
  }

  const synced  = results.filter((r) => r.status === 'synced').length;
  const failed  = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped' || r.status === 'skip').length;
  console.log(`\nDone: ${synced} synced, ${failed} failed, ${skipped} skipped`);
  return { synced, failed, skipped, results };
}

async function syncViaDb(force) {
  const { getBrandsForAccount } = require('../lib/db/postgres');
  const { syncBrandFromTwitch, resolveTwitchLoginForBrand } = require('../lib/services/brand_twitch_sync');

  const brands = await getBrandsForAccount(ACCOUNT_ID);
  if (!brands.length) throw new Error('No brands found for account');

  const results = [];
  for (const brand of brands) {
    const login = await resolveTwitchLoginForBrand(brand.id);
    if (!login) {
      results.push({ brand: brand.slug || brand.name, status: 'skip', reason: 'no_twitch_login' });
      continue;
    }
    const out = await syncBrandFromTwitch({
      brandId: brand.id,
      accountId: ACCOUNT_ID,
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
  console.log(`\nDone: ${synced} synced, ${failed} failed, ${skipped} skipped`);
  return { synced, failed, skipped, results };
}

async function main() {
  const args  = process.argv.slice(2);
  const force = args.includes('--force');
  const viaApi = args.includes('--via-api');

  console.log(`[sync_subbrand_twitch_avatars] account=${ACCOUNT_ID} mode=${viaApi ? 'api' : 'db'} force=${force}`);

  const summary = viaApi ? await syncViaApi(force) : await syncViaDb(force);
  if (summary.failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
