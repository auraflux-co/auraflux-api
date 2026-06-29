#!/usr/bin/env node
'use strict';

/**
 * Run Gemini stitch QA on an existing streamer block report (from stitch_streamer_block.js).
 *
 * Usage:
 *   node scripts/gemini_qa_streamer_block.js logs/streamer_block_LACY_.../block_report.json
 *   node scripts/gemini_qa_streamer_block.js --report logs/.../block_report.json --only handoff
 */

const path = require('path');
const { qaStreamerBlockReport } = require('../lib/soup_stitch_gemini_qa');

function parseArgs(argv) {
  const out = { report: null, only: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') out.report = argv[++i];
    else if (a === '--only') out.only = String(argv[++i] || '').toLowerCase();
    else if (!a.startsWith('-') && !out.report) out.report = a;
  }
  return out;
}

function joinFilter(only) {
  if (!only) return null;
  if (only === 'handoff') {
    return (j) => /_CLIP2_REACTION$/i.test(j.from || '') && /_INTRO$/i.test(j.to || '');
  }
  if (only === 'intro_setup') {
    return (j) => /_INTRO$/i.test(j.from || '') && /_CLIP1_SETUP$/i.test(j.to || '');
  }
  if (only === 'reaction_setup') {
    return (j) => /_CLIP1_REACTION$/i.test(j.from || '') && /_CLIP2_SETUP$/i.test(j.to || '');
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.report) {
    console.error('Usage: node scripts/gemini_qa_streamer_block.js <block_report.json>');
    process.exit(1);
  }
  const reportPath = path.resolve(opts.report);
  const summary = await qaStreamerBlockReport(reportPath, { joinFilter: joinFilter(opts.only) });
  if (!summary.overallPass) process.exitCode = 2;
}

main().catch((e) => { console.error(e); process.exit(1); });
