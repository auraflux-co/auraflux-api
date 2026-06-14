#!/usr/bin/env node
/**
 * Seed 20 test brands directly via database for multi-brand YouTube testing.
 * Run: node scripts/seed_test_brands.js
 */

require('dotenv').config();
const { createBrand } = require('../lib/db/postgres');

const ACCOUNT_ID = 'user_2kxLZH7ckSLZH3d6dCK3hVVqvHs'; // robert@auraflux.co

const BRAND_NAMES = [
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

async function main() {
  console.log(`Creating ${BRAND_NAMES.length} test brands for ${ACCOUNT_ID}...\n`);
  
  const created = [];
  const errors = [];
  
  for (const name of BRAND_NAMES) {
    try {
      const brand = await createBrand(ACCOUNT_ID, name);
      console.log(`✓ ${brand.id} → ${name}`);
      created.push(brand);
    } catch (err) {
      console.error(`✗ ${name}: ${err.message}`);
      errors.push({ name, error: err.message });
    }
  }
  
  console.log(`\n✓ Created ${created.length} brands`);
  if (errors.length > 0) {
    console.log(`✗ Failed ${errors.length} brands`);
  }
  
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
