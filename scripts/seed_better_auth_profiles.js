#!/usr/bin/env node
/**
 * Optional: seed user_profiles for known operators so account_ids stay on Clerk ids.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/seed_better_auth_profiles.js
 *
 * For full Clerk → Better Auth user+password import, create accounts via
 * app sign-up (or Better Auth admin API) then set:
 *   UPDATE user_profiles SET account_id = '<legacy_clerk_id>', legacy_clerk_id = '<legacy_clerk_id>'
 *   WHERE email = '...';
 *
 * That keeps brands / jobs / membership rows linked.
 */
'use strict';

const { getPool, initDb } = require('../lib/db/postgres');

async function main() {
  await initDb();
  const pool = getPool();
  const seeds = (process.env.AURAFLUX_PROFILE_SEEDS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  // format: email|accountId|role|planTier
  if (!seeds.length) {
    console.log('No AURAFLUX_PROFILE_SEEDS set. Example:');
    console.log(
      '  AURAFLUX_PROFILE_SEEDS="support@auraflux.co|user_xxx|superadmin|managed;robert@auraflux.co|user_yyy|superadmin|managed"',
    );
    console.log('Skipping. Migration 036 tables are ready after API boot / initDb.');
    process.exit(0);
  }

  for (const line of seeds) {
    const [email, accountId, role = 'customer', planTier = 'operate'] = line.split('|');
    if (!email || !accountId) continue;
    // Placeholder auth_user_id until they sign up with Better Auth — then link by email
    await pool.query(
      `INSERT INTO user_profiles (auth_user_id, account_id, email, role, plan_tier, legacy_clerk_id)
       VALUES ($1, $2, $3, $4, $5, $2)
       ON CONFLICT (account_id) DO UPDATE SET
         email = EXCLUDED.email,
         role = EXCLUDED.role,
         plan_tier = EXCLUDED.plan_tier,
         legacy_clerk_id = COALESCE(user_profiles.legacy_clerk_id, EXCLUDED.legacy_clerk_id),
         updated_at = NOW()`,
      [`pending:${accountId}`, accountId, email, role, planTier],
    );
    console.log('seeded profile', email, accountId);
  }
  console.log('done');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
