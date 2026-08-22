#!/usr/bin/env node
/**
 * scripts/connect_brand_socials.js
 *
 * One-off script: generates Upload-Post connect URLs for TikTok + Instagram
 * for each sub-brand. Opens each URL in the default browser in sequence.
 *
 * Usage:
 *   node scripts/connect_brand_socials.js                   # all brands, all platforms
 *   node scripts/connect_brand_socials.js tiktok            # TikTok only
 *   node scripts/connect_brand_socials.js instagram         # Instagram only
 *   node scripts/connect_brand_socials.js tiktok natashaughey  # single brand
 *
 * Each URL opens a hosted Upload-Post OAuth page scoped to that brand's
 * Upload-Post profile. The user signs into TikTok/Instagram in the browser,
 * and the account is linked under that brand's profile.
 */

'use strict';
require('dotenv').config();

const { exec } = require('child_process');
const { generateConnectUrl, ensureProfile } = require('../lib/services/uploadpost_users');

const PLATFORM_ARG = process.argv[2] && !process.argv[2].includes('-') && !process.argv[2].includes(' ')
  ? ['tiktok', 'instagram', 'youtube'].includes(process.argv[2]) ? process.argv[2] : null
  : null;

const BRAND_FILTER = PLATFORM_ARG ? process.argv[3] : process.argv[2];

const PLATFORMS = PLATFORM_ARG ? [PLATFORM_ARG] : ['tiktok', 'instagram'];

// Each brand gets its own Upload-Post profile (username = brand slug).
// Upload-Post profiles are created on first use via ensureProfile().
const BRANDS = [
  'natashaughey', 'martinezofwonkru', 'thevarietygurl', 'millkberry',
  'lettucek', 'fuzzyness', 'hana', 'wanderbot', 'somarcus', 'rockleesmile',
  'clintus', 'ninuschk', 'alluux', 'patterrz', 'supermcgamer',
  't10nat', 'guhrl', 'tenshi',
].map(name => ({ name, customerId: name })); // Upload-Post username = brand name

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
            : process.platform === 'win32'  ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd);
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  const brands = BRAND_FILTER
    ? BRANDS.filter(b => b.name.toLowerCase() === BRAND_FILTER.toLowerCase())
    : BRANDS;

  if (!brands.length) {
    console.error(`No brand found matching "${BRAND_FILTER}"`);
    process.exit(1);
  }

  const redirectUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.auraflux.co'}/settings/social?social_connected=1`;

  console.log(`\nGenerating ${PLATFORMS.join(' + ')} connect URLs for ${brands.length} brand(s)...\n`);

  const results = [];

  for (const brand of brands) {
    try {
      const url = await generateConnectUrl(brand.customerId, {
        redirectUrl,
        platforms: PLATFORMS,
      });

      results.push({ brand: brand.name, url, ok: true });
      console.log(`✓ ${brand.name}`);
      console.log(`  ${url}\n`);
    } catch (err) {
      results.push({ brand: brand.name, error: err.message, ok: false });
      console.error(`✗ ${brand.name}: ${err.message}`);
    }

    await pause(400);
  }

  // Print summary table
  console.log('\n─── Connect URLs ───────────────────────────────────────────────\n');
  results.forEach(r => {
    if (r.ok) console.log(`${r.brand.padEnd(20)} ${r.url}`);
    else      console.log(`${r.brand.padEnd(20)} ERROR: ${r.error}`);
  });

  // Ask before opening browsers
  if (results.some(r => r.ok)) {
    console.log(`\nOpen all ${results.filter(r => r.ok).length} URLs in browser? (y/N) `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', async (key) => {
      if (key.toString().toLowerCase() === 'y') {
        for (const r of results.filter(r => r.ok)) {
          console.log(`Opening ${r.brand}...`);
          openBrowser(r.url);
          await pause(1500); // stagger so browser doesn't overload
        }
        console.log('\nAll opened. Complete OAuth in each tab, then close.');
      } else {
        console.log('Skipped. Copy URLs above to connect manually.');
      }
      process.exit(0);
    });
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
