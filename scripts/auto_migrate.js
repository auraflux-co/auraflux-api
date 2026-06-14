#!/usr/bin/env node
/**
 * Auto-apply pending migrations on server start.
 * Checks schema_migrations table and runs any migrations not yet applied.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query } = require('../lib/db/postgres');

const MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');

async function getAppliedMigrations() {
  try {
    const result = await query('SELECT version FROM schema_migrations');
    return new Set(result.rows.map(r => r.version));
  } catch (err) {
    console.error('[auto-migrate] Could not read schema_migrations:', err.message);
    return new Set();
  }
}

async function applyMigration(file) {
  const version = file.replace('.sql', '');
  const filePath = path.join(MIGRATIONS_DIR, file);
  const sql = fs.readFileSync(filePath, 'utf8');
  
  console.log(`  → Applying ${version}...`);
  await query(sql);
  console.log(`  ✓ ${version} applied`);
}

async function main() {
  const applied = await getAppliedMigrations();
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  
  const pending = files.filter(f => !applied.has(f.replace('.sql', '')));
  
  if (pending.length === 0) {
    console.log('[auto-migrate] No pending migrations');
    return;
  }
  
  console.log(`[auto-migrate] Found ${pending.length} pending migration(s):\n`);
  
  for (const file of pending) {
    try {
      await applyMigration(file);
    } catch (err) {
      console.error(`  ✗ ${file} failed:`, err.message);
      throw err;
    }
  }
  
  console.log(`\n[auto-migrate] All migrations applied`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[auto-migrate] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { main };
