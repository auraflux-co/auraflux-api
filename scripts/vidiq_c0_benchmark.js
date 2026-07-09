#!/usr/bin/env node
'use strict';

/**
 * Compare C0 intelligence vs vidIQ MCP for the same inputs.
 *
 * Usage:
 *   VIDIQ_MCP_API_KEY=vidiq_... node scripts/vidiq_c0_benchmark.js
 *   node scripts/vidiq_c0_benchmark.js --scenario optimize_title --title "My Short"
 *
 * Output: logs/vidiq_c0_benchmark.jsonl (append) + stdout summary
 */

const fs = require('fs');
const path = require('path');
const { runBenchmarkSuite, runScenario, listScenarios } = require('../lib/intelligence/vidiq_compare');
const vidiq = require('../lib/intelligence/adapters/vidiq_mcp');

const LOG_PATH = path.join(__dirname, '../logs/vidiq_c0_benchmark.jsonl');

function parseArgs(argv) {
  const out = { scenarios: null, input: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scenario' && argv[i + 1]) { out.scenarios = [argv[++i]]; continue; }
    if (a === '--title' && argv[i + 1]) { out.input.title = argv[++i]; continue; }
    if (a === '--keyword' && argv[i + 1]) { out.input.keyword = argv[++i]; continue; }
    if (a === '--type' && argv[i + 1]) { out.input.type = argv[++i]; continue; }
    if (a === '--list') { out.list = true; continue; }
  }
  if (!out.input.title) {
    out.input.title = 'Twitch Soup Ep5 - Cinna Goes Off';
    out.input.type = 'short';
    out.input.keyword = 'twitch clips';
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.list) {
    console.log(JSON.stringify(listScenarios(), null, 2));
    return;
  }

  if (!vidiq.isConfigured()) {
    console.error('VIDIQ_MCP_API_KEY not set — C0-only run (vidIQ side skipped).');
  } else {
    try {
      const bal = await vidiq.getCreditsBalance();
      console.log(`vidIQ credits: ${bal.totalCredits ?? '?'} total`);
    } catch (e) {
      console.warn('vidIQ balance check failed:', e.message);
    }
  }

  const report = args.scenarios
    ? { ok: true, results: [await runScenario(args.scenarios[0], args.input)] }
    : await runBenchmarkSuite(args.input);

  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(report)}\n`);

  for (const row of report.results) {
    console.log(`\n=== ${row.label || row.scenarioId} ===`);
    if (row.summary) console.log('Summary:', JSON.stringify(row.summary));
    if (row.vidiq?.error) console.log('vidIQ error:', row.vidiq.error);
    else if (row.vidiq) console.log('vidIQ:', JSON.stringify(row.vidiq).slice(0, 500));
    if (row.c0?.error) console.log('C0 error:', row.c0.error);
    else if (row.c0) console.log('C0:', JSON.stringify(row.c0).slice(0, 500));
  }

  console.log(`\nAppended to ${LOG_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
