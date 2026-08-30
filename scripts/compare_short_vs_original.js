#!/usr/bin/env node
'use strict';

/**
 * CLI: Gemini compare original vs Composer Short
 *   node scripts/compare_short_vs_original.js --source path.mp4 --short path.mp4
 *   node scripts/compare_short_vs_original.js --source … --short … --out logs/cmp.json
 */

const fs = require('fs');
const path = require('path');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

async function main() {
  const source = argVal('--source');
  const short = argVal('--short');
  const out = argVal('--out');
  if (!source || !short) {
    console.error('Usage: node scripts/compare_short_vs_original.js --source <mp4> --short <mp4> [--out logs/cmp.json]');
    process.exit(1);
  }
  // Load .env if present (C0 local)
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* ignore */ }

  const { compareShortVsOriginal } = require('../lib/composition_compare_original');
  const result = await compareShortVsOriginal({
    sourcePath: path.resolve(source),
    shortPath: path.resolve(short),
    includeRaw: process.argv.includes('--raw'),
  });
  const json = JSON.stringify(result, null, 2);
  if (out) {
    const outPath = path.resolve(out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    console.log('Wrote', outPath);
  }
  console.log(json);
  if (!result.ok) process.exit(2);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
