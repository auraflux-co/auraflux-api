#!/usr/bin/env node
'use strict';

/**
 * Full merged LACY streamer block — uses validated HeyGen merges + r43 clips/reactions.
 * Proves production stitch path before a new full-show job tonight.
 *
 *   node scripts/stitch_merged_lacy_full_block.js
 *   node scripts/stitch_merged_lacy_full_block.js --handoff JASON
 */

if (!process.env.USE_LOCAL_FFMPEG) process.env.USE_LOCAL_FFMPEG = '1';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  concatMediaWithTransition,
  soupJoinTransition,
} = require('../lib/assembly');
const { ffmpegPath } = require('../lib/ffmpeg_utils');
const { probeDurationSec } = require('../lib/clip_comp_tts');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');
const TEST_ROOT = path.join(ROOT, 'output/scene_reset_hold_test_2026-06-29T21-16-16');
const R43 = 'asm_script_twitch_1782513992551_r43';
const TMP = path.join(ROOT, 'tmp');

const DEFAULT_SEGMENTS = [
  {
    label: 'LACY_INTRO',
    type: 'avatar',
    file: path.join(TEST_ROOT, 'merged_intro_clip1/LACY_INTRO_CLIP1_SETUP_merged.mp4'),
  },
  {
    label: 'LACY_INTRO_CLIP',
    type: 'source_clip',
    file: path.join(TMP, `${R43}_3_lacy_clip1_setup_clip.ts`),
  },
  {
    label: 'LACY_CLIP1_REACTION',
    type: 'avatar',
    file: path.join(TEST_ROOT, 'merged_reaction_clip2/LACY_CLIP1_REACTION_CLIP2_SETUP_merged_with_crowd.mp4'),
  },
  {
    label: 'LACY_CLIP1_REACTION_CLIP',
    type: 'source_clip',
    file: path.join(TMP, `${R43}_6_lacy_clip2_setup_clip.ts`),
  },
  {
    label: 'LACY_CLIP2_REACTION',
    type: 'avatar',
    file: path.join(TMP, `${R43}_7_lacy_clip2_reaction_legacy_chrome_with_crowd.mp4`),
  },
];

async function extractClip(video, atSec, windowSec, outPath) {
  const start = Math.max(0, atSec - windowSec);
  const dur = windowSec * 2;
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', start.toFixed(3), '-t', dur.toFixed(3),
    '-i', video,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-ar', '48000',
    '-y', outPath,
  ], { timeout: 120000 });
}

async function joinTimes(files, types, labels) {
  let t = 0;
  const points = [];
  for (let i = 0; i < files.length; i++) {
    const dur = await probeDurationSec(files[i]);
    const spec = i < files.length - 1
      ? soupJoinTransition(types[i], types[i + 1], labels[i], labels[i + 1])
      : null;
    const overlap = spec?.useXfade ? (spec.videoDur ?? 0.22) : 0;
    const holdExtra = spec?.mode === 'hold_cut'
      ? (spec.holdSec ?? 0.14) + (spec.slateSec ?? 0.06)
      : 0;
    if (i < files.length - 1) {
      points.push({
        index: i + 1,
        from: labels[i],
        to: labels[i + 1],
        atSec: t + dur - overlap,
        policy: spec,
      });
    }
    t += dur - overlap + holdExtra;
  }
  return points;
}

function parseArgs(argv) {
  const out = { handoff: null, windowSec: 3 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--handoff') out.handoff = String(argv[++i] || '').toUpperCase();
    else if (argv[i] === '--window') out.windowSec = Number(argv[++i]) || 3;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const segments = [...DEFAULT_SEGMENTS];

  for (const seg of segments) {
    if (!fs.existsSync(seg.file)) {
      console.error(`Missing: ${seg.file}`);
      process.exit(1);
    }
  }

  if (opts.handoff) {
    const handoffCandidates = fs.readdirSync(TMP).filter((f) =>
      f.startsWith(`${R43}_`) && f.includes(`${opts.handoff.toLowerCase()}_intro`) && /\.(mp4|ts)$/i.test(f) && !/_muted/i.test(f)
    );
    const handoffMp4 = handoffCandidates.find((f) => f.endsWith('.mp4'));
    const handoffFile = path.join(TMP, handoffMp4 || handoffCandidates.sort().pop());
    if (!handoffFile || !fs.existsSync(handoffFile)) {
      console.error(`Missing handoff ${opts.handoff}_INTRO in tmp`);
      process.exit(1);
    }
    segments.push({ label: `${opts.handoff}_INTRO`, type: 'avatar', file: handoffFile });
  }

  const files = segments.map((s) => s.file);
  const types = segments.map((s) => s.type);
  const labels = segments.map((s) => s.label);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(ROOT, 'logs', `merged_lacy_full_block_${stamp}`);
  const clipsDir = path.join(outDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  console.log('Merged LACY full block segments:');
  segments.forEach((s, i) => console.log(`  ${i + 1}. ${s.label} ← ${path.basename(s.file)}`));

  const blockMp4 = path.join(outDir, 'LACY_merged_full_block.mp4');
  console.log(`\nStitching → ${blockMp4}`);
  await concatMediaWithTransition(files, blockMp4, {
    transition: 'crossfade',
    segTypes: types,
    segLabels: labels,
    logFn: (m) => console.log(m),
  });

  const joins = await joinTimes(files, types, labels);
  const report = { blockMp4, segments: labels, joins: [] };

  for (const j of joins) {
    const slug = `${String(j.index).padStart(2, '0')}_${j.from}_to_${j.to}`.replace(/[^a-zA-Z0-9]+/g, '_');
    const clipPath = path.join(clipsDir, `${slug}.mp4`);
    await extractClip(blockMp4, j.atSec, opts.windowSec, clipPath);
    const policyName = j.policy?.sceneReset
      ? 'scene_reset'
      : j.policy?.useXfade ? 'xfade' : 'cut';
    report.joins.push({ ...j, policyName, clip: clipPath });
    console.log(`  join ${j.index}: ${j.from} → ${j.to} [${policyName}] ~${j.atSec.toFixed(1)}s`);
  }

  fs.writeFileSync(path.join(outDir, 'block_report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), [
    '# LACY merged full block validation',
    '',
    'HeyGen merges eliminate avatar→avatar joins at 0:09 and 0:55.',
    '150 handoff only when `--handoff JASON` is passed.',
    '',
    `Full block: \`${blockMp4}\``,
    '',
    '## Key joins (no scene_reset on 009/055 — those boundaries are inside merged renders)',
    ...report.joins.map((j) => `- ${j.from} → ${j.to} (${j.policyName}) ~${j.atSec.toFixed(1)}s`),
  ].join('\n'));

  const dur = await probeDurationSec(blockMp4);
  console.log(`\n✅ Done — ${dur.toFixed(1)}s → ${blockMp4}`);
  console.log(`   Review clips in ${clipsDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
