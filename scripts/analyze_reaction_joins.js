#!/usr/bin/env node
'use strict';

/**
 * Export reaction→setup join windows (post-crowd) for operator review.
 *
 * Usage:
 *   node scripts/analyze_reaction_joins.js \
 *     --video output/twitch_soup_....mp4 \
 *     --job-id script_twitch_1782513992551 \
 *     --asm-id asm_script_twitch_1782513992551_r39
 */

if (!process.env.USE_LOCAL_FFMPEG) process.env.USE_LOCAL_FFMPEG = '1';

const fs = require('fs');
const path = require('path');
const {
  loadCandidateRundownFromAsm,
  recalcTimelineWithXfade,
  refineJoinTimestamp,
} = require('../lib/soup_boundary_compare');
const { soupJoinTransition } = require('../lib/assembly');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath } = require('../lib/ffmpeg_utils');

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = { video: null, jobId: null, asmId: null, windowSec: 3, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--video') out.video = argv[++i];
    else if (a === '--job-id') out.jobId = argv[++i];
    else if (a === '--asm-id') out.asmId = argv[++i];
    else if (a === '--window') out.windowSec = Number(argv[++i]) || 3;
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  return out;
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

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.video || !opts.jobId || !opts.asmId) {
    console.error('Usage: --video <mp4> --job-id <id> --asm-id <asm_id>');
    process.exit(1);
  }
  const videoPath = path.resolve(opts.video);
  if (!fs.existsSync(videoPath)) {
    console.error(`Not found: ${videoPath}`);
    process.exit(1);
  }

  const rundown = await loadCandidateRundownFromAsm(opts.jobId, opts.asmId);
  const entries = recalcTimelineWithXfade(rundown.entries);
  const joins = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const from = entries[i];
    const to = entries[i + 1];
    if (!/_REACTION$/i.test(from.segmentLabel || from.label || '')) continue;
    if (!/_SETUP/i.test(to.segmentLabel || to.label || '')) continue;
    const spec = soupJoinTransition('avatar', 'avatar', from.segmentLabel || from.label, to.segmentLabel || to.label);
    joins.push({ from, to, atSec: from.endSec, spec });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.outDir || path.join('logs', `reaction_joins_${opts.asmId}_${stamp}`));
  const clipsDir = path.join(outDir, 'clips');
  const tmpDir = path.join(outDir, '_tmp');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const report = [];
  for (let j = 0; j < joins.length; j++) {
    const { from, to, atSec, spec } = joins[j];
    const refined = await refineJoinTimestamp(videoPath, atSec, 2, tmpDir);
    const at = refined.atSec;
    const slug = `${from.segmentLabel || 'reaction'}_to_${to.segmentLabel || 'setup'}`.replace(/[^a-zA-Z0-9]+/g, '_');
    const clipPath = path.join(clipsDir, `${String(j + 1).padStart(2, '0')}_${slug}.mp4`);
    await extractClip(videoPath, at, opts.windowSec, clipPath);
    report.push({
      index: j + 1,
      from: from.segmentLabel || from.label,
      to: to.segmentLabel || to.label,
      timestamp: from.endTimestamp,
      atSec: at,
      joinPolicy: spec,
      clip: clipPath,
    });
    console.log(`${j + 1}. ${from.endTimestamp} ${from.segmentLabel} → ${to.segmentLabel}  (${path.basename(clipPath)})`);
  }

  fs.writeFileSync(path.join(outDir, 'reaction_joins.json'), JSON.stringify({ video: videoPath, asmId: opts.asmId, joins: report }, null, 2));
  fs.writeFileSync(path.join(outDir, 'README.md'), [
    '# Reaction → setup join review clips',
    '',
    `Video: \`${videoPath}\``,
    `Assembly: \`${opts.asmId}\``,
    '',
    'Each clip is ~6s centered on the join **after crowd reaction** (reaction → next setup).',
    'Listen for crowd tail bleed / audio pop; watch for pose jump into setup.',
    '',
    'Log timestamps here for the next tuning pass.',
    '',
    ...report.map((r) => `- **${r.timestamp}** ${r.from} → ${r.to} — \`clips/${path.basename(r.clip)}\``),
  ].join('\n'));

  console.log(`\n→ ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
