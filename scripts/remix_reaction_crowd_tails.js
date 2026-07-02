#!/usr/bin/env node
'use strict';

/** Re-mix reaction segments with sceneLabel-aware crowd tail (CLIP1 parity with CLIP2). */

if (!process.env.USE_LOCAL_FFMPEG) process.env.USE_LOCAL_FFMPEG = '1';

const path = require('path');
const fs = require('fs');
const { mixCrowdLaughOnReaction } = require('../lib/studio_laughter');

async function main() {
  const asmId = process.argv[2] || 'asm_script_twitch_1782513992551_r43';
  const tmpDir = path.join(__dirname, '..', 'tmp');
  const pairs = [
    { idx: 4, streamer: 'LACY', slug: 'clip1_reaction', label: 'LACY_CLIP1_REACTION' },
    { idx: 7, streamer: 'LACY', slug: 'clip2_reaction', label: 'LACY_CLIP2_REACTION' },
  ];
  for (const p of pairs) {
    const prefix = `${asmId}_${p.idx}_${p.streamer.toLowerCase()}_${p.slug}`;
    const raw = fs.readdirSync(tmpDir).find((f) => f.startsWith(prefix) && f.includes('legacy_chrome.mp4') && !f.includes('_with_crowd'));
    if (!raw) {
      console.warn(`Skip ${p.label}: raw segment not found (${prefix})`);
      continue;
    }
    const rawPath = path.join(tmpDir, raw);
    const outPath = path.join(tmpDir, raw.replace(/\.mp4$/i, '_with_crowd.mp4'));
    console.log(`Remix ${p.label} ← ${raw}`);
    await mixCrowdLaughOnReaction(rawPath, {
      sceneLabel: p.label,
      outputPath: outPath,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(`→ ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
