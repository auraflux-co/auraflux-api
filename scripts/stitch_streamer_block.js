#!/usr/bin/env node
'use strict';

/**
 * Isolate one Twitch Soup streamer block — stitch + export boundary review clips.
 *
 * Usage:
 *   node scripts/stitch_streamer_block.js --streamer LACY --asm-id asm_script_twitch_1782513992551_r43
 *   node scripts/stitch_streamer_block.js --streamer LACY --asm-id ... --handoff JASON
 *   node scripts/stitch_streamer_block.js --streamer LACY --asm-id ... --gemini
 *   node scripts/stitch_streamer_block.js --streamer LACY --asm-id ... --merged
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
const {
  LEGACY_BLOCK_SEGMENTS,
  MERGED_BLOCK_SEGMENTS,
} = require('../lib/soup_streamer_block_segments');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {
    streamer: 'LACY',
    asmId: null,
    handoff: null,
    windowSec: 3,
    outDir: null,
    tmpDir: path.join(ROOT, 'tmp'),
    gemini: false,
    metrics: false,
    merged: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--streamer') out.streamer = String(argv[++i] || 'LACY').toUpperCase();
    else if (a === '--asm-id') out.asmId = argv[++i];
    else if (a === '--gemini') out.gemini = true;
    else if (a === '--metrics') out.metrics = true;
    else if (a === '--merged') out.merged = true;
    else if (a === '--handoff') out.handoff = String(argv[++i] || '').toUpperCase();
    else if (a === '--window') out.windowSec = Number(argv[++i]) || 3;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--tmp-dir') out.tmpDir = argv[++i];
  }
  return out;
}

function resolveSegmentFile(tmpDir, asmId, index, slug, preferCrowd = false, { slugOnly = false } = {}) {
  const prefix = slugOnly ? `${asmId}_` : `${asmId}_${index}_`;
  const candidates = fs.readdirSync(tmpDir).filter((f) => {
    if (!f.startsWith(prefix)) return false;
    if (!f.includes(slug)) return false;
    if (!/\.(ts|mp4)$/i.test(f)) return false;
    if (/_muted/i.test(f)) return false;
    if (preferCrowd && !/_with_crowd/i.test(f)) return false;
    if (!preferCrowd && /_with_crowd/i.test(f)) return false;
    return true;
  });
  if (preferCrowd && !candidates.length) {
    return resolveSegmentFile(tmpDir, asmId, index, slug, false);
  }
  if (!candidates.length) return null;
  const mp4 = candidates.find((f) => f.endsWith('.mp4'));
  return path.join(tmpDir, mp4 || candidates.sort().pop());
}

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

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.asmId) {
    console.error('Usage: --streamer LACY --asm-id asm_script_twitch_... [--handoff JASON]');
    process.exit(1);
  }

  const streamer = opts.streamer;
  const blockSegments = opts.merged ? MERGED_BLOCK_SEGMENTS : LEGACY_BLOCK_SEGMENTS;
  const files = [];
  const types = [];
  const labels = [];

  for (let i = 0; i < blockSegments.length; i++) {
    const seg = blockSegments[i];
    const idx = i + 1;
    const preferCrowd = !!seg.preferCrowd;
    const slug = `${streamer.toLowerCase()}_${seg.slug}`;
    const fp = resolveSegmentFile(opts.tmpDir, opts.asmId, idx, slug, preferCrowd, {
      slugOnly: opts.merged,
    });
    if (!fp) {
      console.error(`Missing segment ${idx} ${streamer}_${seg.slug} under ${opts.tmpDir}`);
      process.exit(1);
    }
    files.push(fp);
    types.push(seg.type);
    labels.push(`${streamer}${seg.labelSuffix}`);
    console.log(`${idx}. ${labels[labels.length - 1]}  ← ${path.basename(fp)}`);
  }

  if (opts.handoff) {
    const handoffIdx = opts.merged ? 6 : 8;
    const handoffSlug = `${opts.handoff.toLowerCase()}_intro`;
    const handoffFile = resolveSegmentFile(opts.tmpDir, opts.asmId, handoffIdx, handoffSlug, false, {
      slugOnly: opts.merged,
    });
    if (!handoffFile) {
      console.error(`Missing handoff intro ${opts.handoff}_INTRO (index ${handoffIdx})`);
      process.exit(1);
    }
    files.push(handoffFile);
    types.push('avatar');
    labels.push(`${opts.handoff}_INTRO`);
    console.log(`${handoffIdx}. ${labels[labels.length - 1]}  ← ${path.basename(handoffFile)} (handoff)`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.outDir || path.join('logs', `streamer_block_${streamer}_${opts.asmId}_${stamp}`));
  const clipsDir = path.join(outDir, 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });

  const blockMp4 = path.join(outDir, `${streamer}_block.mp4`);
  console.log(`\nStitching ${files.length} segments → ${blockMp4}`);
  const stitchMeta = await concatMediaWithTransition(files, blockMp4, {
    transition: 'crossfade',
    segTypes: types,
    segLabels: labels,
    logFn: (m) => console.log(m),
  });

  const joins = await joinTimes(files, types, labels);
  const report = {
    streamer,
    asmId: opts.asmId,
    blockMp4,
    stitchMeta,
    _segmentFiles: files,
    _segmentLabels: labels,
    joins: [],
  };

  for (const j of joins) {
    const slug = `${String(j.index).padStart(2, '0')}_${j.from}_to_${j.to}`.replace(/[^a-zA-Z0-9]+/g, '_');
    const clipPath = path.join(clipsDir, `${slug}.mp4`);
    await extractClip(blockMp4, j.atSec, opts.windowSec, clipPath);
    const policyName = j.policy?.sceneReset
      ? 'scene_reset'
      : j.policy?.mode === 'hold_cut'
        ? 'hold_cut'
        : (j.policy?.useXfade ? 'xfade' : 'cut');
    report.joins.push({ ...j, policyName, clip: clipPath });
    console.log(`  clip ${j.index}: ${j.from} → ${j.to}  [${policyName}]  ~${j.atSec.toFixed(1)}s`);
  }

  fs.writeFileSync(path.join(outDir, 'block_report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), [
    `# ${streamer} streamer block — isolated stitch`,
    '',
    `Assembly: \`${opts.asmId}\``,
    `Full block: \`${blockMp4}\``,
    '',
    '## Pattern (this block)',
    opts.merged
      ? 'INTRO(+CLIP1_SETUP merged) → clip → REACTION(+CLIP2_SETUP merged) → clip → CLIP2_REACTION'
      : 'INTRO → CLIP1_SETUP → clip → REACTION → CLIP2_SETUP → clip → CLIP2_REACTION',
    opts.handoff ? `→ **${opts.handoff}_INTRO** (handoff test)` : '',
    '',
    '## Boundary clips',
    ...report.joins.map((j) => `- **${j.from} → ${j.to}** (${j.policyName}) — \`clips/${path.basename(j.clip)}\``),
    '',
    'Review intro→setup and reaction joins first; lock policy before full show reassemble.',
  ].filter(Boolean).join('\n'));

  console.log(`\n→ ${outDir}`);
  console.log(`→ ${blockMp4}`);

  if (opts.gemini) {
    const { qaStreamerBlockReport } = require('../lib/soup_stitch_gemini_qa');
    console.log('\n[gemini-stitch-qa] reviewing boundary clips...');
    const summary = await qaStreamerBlockReport(path.join(outDir, 'block_report.json'));
    if (!summary.overallPass) {
      console.log('[gemini-stitch-qa] FAIL — see gemini_qa_report.md for failed joins');
      process.exitCode = 2;
    }
  }

  if (opts.metrics) {
    const { scoreStreamerBlockJoins } = require('../lib/soup_join_visual_metrics');
    console.log('\n[join-metrics] objective visual scoring...');
    const summary = await scoreStreamerBlockJoins(path.join(outDir, 'block_report.json'));
    for (const r of summary.results) {
      const v = r.visual || {};
      console.log(`  ${r.from}→${r.to}: score=${v.score ?? '—'} pass=${v.pass ? 'YES' : 'NO'} issues=${(v.issues || []).join(',') || 'none'} tailMotion=${v.metrics?.tailMotion ?? '—'}`);
    }
    if (!summary.overallPass) {
      console.log('[join-metrics] FAIL — see visual_metrics_report.json');
      process.exitCode = process.exitCode || 2;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
