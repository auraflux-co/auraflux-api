#!/usr/bin/env node
'use strict';

/**
 * Objective stitch QA — VMAF, SSIM, PSNR via FFmpeg (no manual viewing).
 *
 * Usage:
 *   node scripts/measure_stitch_quality.js \
 *     --reference output/baseline.mp4 \
 *     --distorted output/candidate.mp4 \
 *     [--duration 60] [--ss 0] [--out-dir logs/vmaf_run] [--no-vmaf]
 *
 * Input order matches FFmpeg libvmaf: --distorted is encoded output, --reference is source.
 */

if (!process.env.FFMPEG_PATH && !process.env.USE_LOCAL_FFMPEG) {
  process.env.USE_LOCAL_FFMPEG = '1';
}

const fs = require('fs');
const path = require('path');
const { measurePairVideoQuality } = require('../lib/video_quality_metrics');

function parseArgs(argv) {
  const out = {
    reference: null,
    distorted: null,
    durationSec: null,
    ssSec: 0,
    outDir: null,
    includeVmaf: true,
    width: 960,
    height: 540,
    vmafSubsample: 4,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reference') out.reference = argv[++i];
    else if (a === '--distorted') out.distorted = argv[++i];
    else if (a === '--duration') out.durationSec = Number(argv[++i]);
    else if (a === '--ss') out.ssSec = Number(argv[++i]) || 0;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--no-vmaf') out.includeVmaf = false;
    else if (a === '--width') out.width = Number(argv[++i]) || 960;
    else if (a === '--height') out.height = Number(argv[++i]) || 540;
    else if (a === '--vmaf-subsample') out.vmafSubsample = Number(argv[++i]) || 4;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/measure_stitch_quality.js \\
  --reference original_reference.mp4 \\
  --distorted your_improved_clip.mp4 \\
  [--duration 60] [--ss 0] [--out-dir logs/vmaf_run] [--no-vmaf]

Metrics (FFmpeg-native):
  VMAF  — Netflix perceptual score 0–100 (100 = perfect vs reference)
  SSIM  — structural similarity 0–1 (1 = identical)
  PSNR  — peak signal-to-noise ratio in dB (higher = closer)

For shifted timelines (xfade reassemble), trim with --ss/--duration or use
scripts/compare_soup_boundary_cuts.js for per-join windows.`);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!opts.reference || !opts.distorted) {
    console.error('Required: --reference and --distorted');
    process.exit(1);
  }

  const referencePath = path.resolve(opts.reference);
  const distortedPath = path.resolve(opts.distorted);
  if (!fs.existsSync(referencePath)) {
    console.error(`Reference not found: ${referencePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(distortedPath)) {
    console.error(`Distorted not found: ${distortedPath}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.outDir || path.join('logs', `stitch_quality_${stamp}`));
  const statsDir = path.join(outDir, 'stats');
  fs.mkdirSync(statsDir, { recursive: true });

  let refInput = referencePath;
  let distInput = distortedPath;
  let measureDur = opts.durationSec;

  if (opts.ssSec > 0 || opts.durationSec != null) {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const { ffmpegPath } = require('../lib/ffmpeg_utils');
    const execFileAsync = promisify(execFile);
    const tmpDir = path.join(outDir, '_trim');
    fs.mkdirSync(tmpDir, { recursive: true });
    const trimOne = async (inp, out) => {
      const args = ['-hide_banner', '-loglevel', 'error'];
      if (opts.ssSec > 0) args.push('-ss', opts.ssSec.toFixed(3));
      if (opts.durationSec != null) args.push('-t', opts.durationSec.toFixed(3));
      args.push('-i', inp, '-c', 'copy', '-y', out);
      await execFileAsync(ffmpegPath(), args, { timeout: 120000 });
    };
    refInput = path.join(tmpDir, 'reference_trim.mp4');
    distInput = path.join(tmpDir, 'distorted_trim.mp4');
    await trimOne(referencePath, refInput);
    await trimOne(distortedPath, distInput);
    measureDur = opts.durationSec;
  }

  console.log(`Measuring ${path.basename(distortedPath)} vs ${path.basename(referencePath)}…`);
  const metrics = await measurePairVideoQuality(refInput, distInput, {
    durationSec: measureDur,
    statsDir,
    prefix: 'full',
    width: opts.width,
    height: opts.height,
    vmafSubsample: opts.vmafSubsample,
    includeVmaf: opts.includeVmaf,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    reference: referencePath,
    distorted: distortedPath,
    ssSec: opts.ssSec,
    durationSec: opts.durationSec,
    vmafMean: metrics.vmafMean,
    ssimMean: metrics.ssimMean,
    psnrMeanDb: metrics.psnrMeanDb,
    statsDir,
    logs: {
      vmaf: metrics.vmafLog,
      ssim: metrics.ssimLog,
      psnr: metrics.psnrLog,
    },
  };

  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(summary, null, 2));

  console.log('\n✅ Objective quality metrics');
  console.log(`   VMAF:  ${metrics.vmafMean ?? '—'} / 100`);
  console.log(`   SSIM:  ${metrics.ssimMean ?? '—'} (1.0 = identical)`);
  console.log(`   PSNR:  ${metrics.psnrMeanDb ?? '—'} dB`);
  console.log(`\n   Logs → ${statsDir}`);
  console.log(`   JSON → ${path.join(outDir, 'metrics.json')}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
