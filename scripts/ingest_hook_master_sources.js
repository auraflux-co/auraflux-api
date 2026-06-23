#!/usr/bin/env node
'use strict';
/**
 * scripts/ingest_hook_master_sources.js — offline Hook Master corpus build (CPD-1086)
 *
 * Usage:
 *   node scripts/ingest_hook_master_sources.js --all
 *   node scripts/ingest_hook_master_sources.js --source jade-beason-100-hooks
 *   node scripts/ingest_hook_master_sources.js --articles-only
 *   node scripts/ingest_hook_master_sources.js --merge-all
 *   node scripts/ingest_hook_master_sources.js --all --passes 5
 */

require('dotenv').config();
const { HOOK_MASTER_SOURCES } = require('../lib/hook_training/sources');
const { ingestSource, ingestAll, mergeAllPlaybook } = require('../lib/hook_training/ingest');

function parseArgs(argv) {
  const out = { all: false, mergeAll: false, articlesOnly: false, passes: 5, sources: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--merge-all') out.mergeAll = true;
    else if (a === '--articles-only') out.articlesOnly = true;
    else if (a === '--passes') { out.passes = Number(argv[++i]) || 5; }
    else if (a === '--source') { out.sources.push(argv[++i]); }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Hook Master ingest — sources:\n${HOOK_MASTER_SOURCES.map((s) => `  ${s.id} (${s.type})`).join('\n')}`);
    process.exit(0);
  }

  if (args.mergeAll) {
    mergeAllPlaybook();
    process.exit(0);
  }

  if (args.all || args.articlesOnly) {
    await ingestAll({ passes: args.passes, articlesOnly: args.articlesOnly });
    process.exit(0);
  }

  if (args.sources.length) {
    let ok = 0;
    for (const id of args.sources) {
      try {
        await ingestSource(id, { passes: args.passes });
        ok++;
      } catch (e) {
        console.error(`[hook-master/ingest] ✗ ${id}: ${e.message}`);
      }
    }
    if (ok) mergeAllPlaybook();
    process.exit(ok ? 0 : 1);
  }

  console.error('Specify --all, --articles-only, --merge-all, or --source <id>');
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
