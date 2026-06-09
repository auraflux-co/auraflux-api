#!/usr/bin/env node
/**
 * Create 20 brand profiles for testing multi-brand YouTube channel management.
 * Each profile will be able to connect its own YouTube channel.
 * 
 * Run: node scripts/create_brand_profiles.js
 */

require('dotenv').config();
const { query } = require('../lib/db/postgres');

const CUSTOMER_ID = 'user_2kxLZH7ckSLZH3d6dCK3hVVqvHs'; // robert@auraflux.co

const PROFILES = [
  { name: 'natashaughey', display: 'Natasha Hughey' },
  { name: 'martinezofwonkru', display: 'Martinez of Wonkru' },
  { name: 'thevarietygurl', display: 'The Variety Gurl' },
  { name: 'millkberry', display: 'Millkberry' },
  { name: 'lettucek', display: 'LettuceK' },
  { name: 'fuzzyness', display: 'Fuzzyness' },
  { name: 'hana', display: 'Hana' },
  { name: 'wanderbot', display: 'Wanderbot' },
  { name: 'somarcus', display: 'Somarcus' },
  { name: 'rockleesmile', display: 'RockLeeSmile' },
  { name: 'clintus', display: 'Clintus' },
  { name: 'ninuschk', display: 'Ninuschk' },
  { name: 'alluux', display: 'Alluux' },
  { name: 'patterrz', display: 'Patterrz' },
  { name: 'supermcgamer', display: 'SuperMCGamer' },
  { name: 't10nat', display: 'T10nat' },
  { name: 'guhrl', display: 'Guhrl' },
  { name: 'tenshi', display: 'Tenshi' },
  { name: 'bogur', display: 'Bogur' },
  { name: 'nixstah', display: 'Nixstah' },
];

async function main() {
  console.log(`Creating ${PROFILES.length} brand profiles for customer ${CUSTOMER_ID}...\n`);

  for (let i = 0; i < PROFILES.length; i++) {
    const { name, display } = PROFILES[i];
    const isDefault = i === 0; // First one is default

    try {
      const result = await query(
        `INSERT INTO brand_profiles (customer_id, profile_name, display_name, is_default, source_channels)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (customer_id, profile_name) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = NOW()
         RETURNING id, profile_name`,
        [CUSTOMER_ID, name, display, isDefault, JSON.stringify({ twitchLogin: name })]
      );
      console.log(`✓ ${result.rows[0].id} → ${name}`);
    } catch (err) {
      console.error(`✗ ${name}: ${err.message}`);
    }
  }

  console.log('\nDone! Brand profiles created.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
