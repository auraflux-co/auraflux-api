#!/usr/bin/env node
/**
 * Create 20 test brands for multi-brand YouTube testing.
 * Uses the existing POST /brands endpoint.
 * 
 * Usage: node scripts/create_test_brands.js <clerk_jwt_token>
 */

const https = require('https');

const API_BASE = process.env.API_BASE_URL || 'https://auraflux-api.onrender.com';

const BRANDS = [
  'natashaughey',
  'martinezofwonkru',
  'thevarietygurl',
  'millkberry',
  'lettucek',
  'fuzzyness',
  'hana',
  'wanderbot',
  'somarcus',
  'rockleesmile',
  'clintus',
  'ninuschk',
  'alluux',
  'patterrz',
  'supermcgamer',
  't10nat',
  'guhrl',
  'tenshi',
  'bogur',
  'nixstah',
];

async function createBrand(name, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ name });
    const url = new URL(`${API_BASE}/brands`);
    
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const token = process.argv[2];
  
  if (!token) {
    console.error('Usage: node scripts/create_test_brands.js <clerk_jwt_token>');
    console.error('\nGet your token from the browser:');
    console.error('1. Log in to app.auraflux.co');
    console.error('2. Open DevTools → Network tab');
    console.error('3. Look for Authorization: Bearer <token> in any request');
    process.exit(1);
  }
  
  console.log(`Creating ${BRANDS.length} brands...\n`);
  
  for (const name of BRANDS) {
    try {
      const result = await createBrand(name, token);
      console.log(`✓ ${name} → ${result.brand?.id}`);
    } catch (err) {
      console.error(`✗ ${name}: ${err.message}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
