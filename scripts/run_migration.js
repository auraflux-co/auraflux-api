#!/usr/bin/env node
/**
 * Run a specific migration file.
 * Usage: node scripts/run_migration.js db/migrations/028_brand_profiles.sql
 */

require('dotenv').config();
const fs = require('fs');
const { query } = require('../lib/db/postgres');

const migrationFile = process.argv[2];

if (!migrationFile) {
  console.error('Usage: node scripts/run_migration.js <migration-file>');
  process.exit(1);
}

async function main() {
  const sql = fs.readFileSync(migrationFile, 'utf8');
  console.log(`Running migration: ${migrationFile}\n`);
  
  try {
    await query(sql);
    console.log('\n✓ Migration completed successfully');
  } catch (err) {
    console.error('\n✗ Migration failed:', err.message);
    process.exit(1);
  }
  
  process.exit(0);
}

main();
