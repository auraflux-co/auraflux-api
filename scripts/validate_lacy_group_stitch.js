#!/usr/bin/env node
'use strict';

/** Re-stitch LACY group from r38 tmp TS with mixed join policy; probe clip→reaction jumps. */
if (!process.env.USE_LOCAL_FFMPEG) process.env.USE_LOCAL_FFMPEG = '1';

const path = require('path');
const fs = require('fs');
const { concatMediaWithTransition, soupJoinUsesXfade } = require('../lib/assembly');
const { boundaryJumpScore } = require('../lib/soup_boundary_compare');
const { probeDurationSec } = require('../lib/clip_comp_tts');

const ROOT = path.join(__dirname, '..');
const ASM = 'asm_script_twitch_1782513992551_r38';
const SEGS = [
  { i: 1, type: 'avatar', file: `${ASM}_1_lacy_intro_legacy_chrome.ts` },
  { i: 2, type: 'avatar', file: `${ASM}_2_lacy_clip1_setup_legacy_chrome.ts` },
  { i: 3, type: 'source_clip', file: `${ASM}_3_lacy_clip1_setup_clip.ts` },
  { i: 4, type: 'avatar', file: `${ASM}_4_lacy_clip1_reaction_legacy_chrome.ts` },
  { i: 5, type: 'avatar', file: `${ASM}_5_lacy_clip2_setup_legacy_chrome.ts` },
  { i: 6, type: 'source_clip', file: `${ASM}_6_lacy_clip2_setup_clip.ts` },
  { i: 7, type: 'avatar', file: `${ASM}_7_lacy_clip2_reaction_legacy_chrome.ts` },
];

async function joinTimes(files, types) {
  let t = 0;
  const points = [];
  for (let i = 0; i < files.length; i++) {
    const dur = await probeDurationSec(files[i]);
    const end = t + dur - (i < files.length - 1 && soupJoinUsesXfade(types[i], types[i + 1]) ? 0.22 : 0);
    if (i < files.length - 1) points.push({ join: `${types[i]}→${types[i + 1]}`, at: end });
    t = end;
  }
  return points;
}

function resolveSegFile(tmpDir, asm, index, slug) {
  const prefix = `${asm}_${index}_`;
  for (const ext of ['.ts', '.mp4']) {
    const files = fs.readdirSync(tmpDir).filter((f) => (
      f.startsWith(prefix) && f.includes(slug) && f.endsWith(ext) && !/_with_crowd|_muted/i.test(f)
    ));
    if (files.length) return path.join(tmpDir, files.sort()[0]);
  }
  return null;
}

async function main() {
  const tmpDir = path.join(ROOT, 'tmp');
  const files = SEGS.map((s) => {
    const slug = s.file.split('_').slice(2).join('_').replace(/\.(ts|mp4)$/, '');
    const hit = resolveSegFile(tmpDir, ASM, s.i, slug.split('_legacy')[0]);
    if (!hit) throw new Error(`Missing segment ${s.i} ${slug}`);
    return hit;
  });
  const types = SEGS.map((s) => s.type);

  const outOld = path.join(ROOT, 'logs', 'lacy_group_xfade_all.mp4');
  const outNew = path.join(ROOT, 'logs', 'lacy_group_mixed_policy.mp4');

  console.log('Stitching ALL xfade (old policy)…');
  await concatMediaWithTransition(files, outOld, { transition: 'crossfade', segTypes: types.map(() => 'avatar') });

  console.log('Stitching mixed policy (clip→reaction cut)…');
  await concatMediaWithTransition(files, outNew, { transition: 'crossfade', segTypes: types });

  const points = await joinTimes(files, types);
  const probeDir = path.join(ROOT, 'logs', '_lacy_probe');
  fs.mkdirSync(probeDir, { recursive: true });

  console.log('\nClip→reaction jump scores:');
  for (const p of points.filter((x) => x.join === 'source_clip→avatar')) {
    const oldJ = await boundaryJumpScore(outOld, p.at, probeDir, 'old');
    const newJ = await boundaryJumpScore(outNew, p.at, probeDir, 'new');
    console.log(`  @ ${p.at.toFixed(2)}s  old=${oldJ.jumpScore}  new=${newJ.jumpScore}  Δ=${((newJ.jumpScore - oldJ.jumpScore) * 1000 | 0) / 1000}`);
  }
  console.log(`\nOutputs:\n  ${outOld}\n  ${outNew}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
