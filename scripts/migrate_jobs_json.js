'use strict';
// scripts/migrate_jobs_json.js — One-time migration from data/jobs.json into SQLite.
// Safe to run multiple times — uses upsert so existing records are updated, not duplicated.
//
// Usage:
//   node scripts/migrate_jobs_json.js

const fs   = require('fs');
const path = require('path');

const JOBS_FILE = path.join(__dirname, '..', 'data', 'jobs.json');
const { initDb, saveJob } = require('../lib/db');

function main() {
  // 1. Open / initialize SQLite
  initDb();

  // 2. Read jobs.json
  if (!fs.existsSync(JOBS_FILE)) {
    console.log('[migrate] data/jobs.json not found — nothing to migrate.');
    process.exit(0);
  }

  let raw;
  try {
    raw = fs.readFileSync(JOBS_FILE, 'utf8');
  } catch (e) {
    console.error('[migrate] Could not read jobs.json:', e.message);
    process.exit(1);
  }

  let jobsMap;
  try {
    jobsMap = JSON.parse(raw);
  } catch (e) {
    console.error('[migrate] Could not parse jobs.json:', e.message);
    process.exit(1);
  }

  const entries = Object.entries(jobsMap);
  if (entries.length === 0) {
    console.log('[migrate] jobs.json is empty — nothing to migrate.');
    process.exit(0);
  }

  // 3. Upsert each card into SQLite
  let migrated = 0;
  let skipped  = 0;

  for (const [jobId, card] of entries) {
    try {
      saveJob(jobId, card);
      migrated++;
    } catch (e) {
      console.error(`[migrate] Failed to migrate job ${jobId}:`, e.message);
      skipped++;
    }
  }

  console.log(`[migrate] Done. Migrated: ${migrated}  Skipped/errored: ${skipped}`);
}

main();
