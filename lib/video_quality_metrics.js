'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath } = require('./ffmpeg_utils');

const execFileAsync = promisify(execFile);

/** Parse mean SSIM / PSNR from ffmpeg lavfi stderr. */
function parseMetric(stderr, re) {
  const m = String(stderr || '').match(re);
  return m ? Number(m[1]) : null;
}

function parseVmafMean(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const mean = data?.pooled_metrics?.vmaf?.mean;
    return Number.isFinite(mean) ? Math.round(mean * 1000) / 1000 : null;
  } catch (_) {
    return null;
  }
}

function escapeFilterPath(p) {
  return String(p).replace(/:/g, '\\:');
}

function scalePairChain({ width = 960, height = 540, fps = 30 } = {}) {
  const scale = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`;
  return `[0:v]${scale}[d];[1:v]${scale}[r]`;
}

/**
 * VMAF + SSIM + PSNR — distorted (input 0) vs reference (input 1).
 * Netflix VMAF: 0–100 (100 = indistinguishable). SSIM: 0–1. PSNR: dB.
 */
async function measurePairVideoQuality(referencePath, distortedPath, {
  durationSec = null,
  statsDir,
  prefix = 'pair',
  width = 960,
  height = 540,
  vmafSubsample = 4,
  includeVmaf = true,
  timeoutMs = 600000,
} = {}) {
  if (!statsDir) throw new Error('statsDir required');
  fs.mkdirSync(statsDir, { recursive: true });

  const vmafLog = path.join(statsDir, `${prefix}_vmaf.json`);
  const ssimLog = path.join(statsDir, `${prefix}_ssim.txt`);
  const psnrLog = path.join(statsDir, `${prefix}_psnr.txt`);
  const tArgs = durationSec != null
    ? ['-t', Math.max(0.5, durationSec - 0.05).toFixed(3)]
    : [];
  const scaleChain = scalePairChain({ width, height });

  let vmafMean = null;
  if (includeVmaf) {
    try {
      await execFileAsync(ffmpegPath(), [
        '-hide_banner', '-loglevel', 'error',
        ...tArgs, '-i', distortedPath,
        ...tArgs, '-i', referencePath,
        '-filter_complex', `${scaleChain};[d][r]libvmaf=log_path=${escapeFilterPath(vmafLog)}:log_fmt=json:n_subsample=${vmafSubsample}`,
        '-f', 'null', '-',
      ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      vmafMean = parseVmafMean(vmafLog);
    } catch (_) { /* optional */ }
  }

  let ssimMean = null;
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'info',
      ...tArgs, '-i', distortedPath,
      ...tArgs, '-i', referencePath,
      '-filter_complex', `${scaleChain};[d][r]ssim=stats_file=${escapeFilterPath(ssimLog)}[v]`,
      '-map', '[v]', '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    ssimMean = parseMetric(stderr, /All:([\d.]+)/)
      || parseMetric(stderr, /SSIM\s+Y:([\d.]+)/);
  } catch (_) { /* optional */ }

  let psnrMeanDb = null;
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'info',
      ...tArgs, '-i', distortedPath,
      ...tArgs, '-i', referencePath,
      '-filter_complex', `${scaleChain};[d][r]psnr=stats_file=${escapeFilterPath(psnrLog)}[v]`,
      '-map', '[v]', '-f', 'null', '-',
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    psnrMeanDb = parseMetric(stderr, /average:([\d.]+)/i);
  } catch (_) { /* optional */ }

  return {
    vmafMean,
    ssimMean,
    psnrMeanDb,
    vmafLog: fs.existsSync(vmafLog) ? vmafLog : null,
    ssimLog: fs.existsSync(ssimLog) ? ssimLog : null,
    psnrLog: fs.existsSync(psnrLog) ? psnrLog : null,
    resolution: `${width}x${height}`,
    vmafSubsample,
  };
}

module.exports = {
  parseMetric,
  parseVmafMean,
  measurePairVideoQuality,
  scalePairChain,
};
