'use strict';

/**
 * CPD-1281 — Variable speed ramp segments with setpts + atempo A/V sync.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

function clampFactor(f) {
  const n = Number(f);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(0.25, Math.min(4, n));
}

/** atempo only accepts 0.5–2.0; chain for extremes. */
function buildAtempoChain(factor) {
  const s = clampFactor(factor);
  if (Math.abs(s - 1) < 0.01) return null;
  const parts = [];
  let remaining = s;
  while (remaining > 2.0 + 1e-6) {
    parts.push('atempo=2.0');
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-6) {
    parts.push('atempo=0.5');
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts.join(',');
}

function buildSetpts(factor) {
  const s = clampFactor(factor);
  if (Math.abs(s - 1) < 0.01) return null;
  return `setpts=${(1 / s).toFixed(6)}*PTS`;
}

/**
 * Normalize speed ramp config.
 * Accepts:
 *   [{ startSec, endSec, factor }]
 *   { enabled, ramps: [...] }
 *   { enabled, speedRamp: 1.5 }  // constant (whole clip)
 */
function normalizeSpeedRamps(cfg, { durationSec = null } = {}) {
  if (!cfg) return [];
  if (cfg.enabled === false) return [];

  if (Array.isArray(cfg)) {
    return normalizeSpeedRamps({ ramps: cfg }, { durationSec });
  }

  const constant = cfg.speedRamp != null ? clampFactor(cfg.speedRamp)
    : (cfg.factor != null ? clampFactor(cfg.factor) : null);
  const raw = Array.isArray(cfg.ramps) ? cfg.ramps : (Array.isArray(cfg.segments) ? cfg.segments : []);

  const out = [];
  for (const r of raw) {
    const startSec = Number(r?.startSec ?? r?.atSec ?? r?.t);
    const endSec = Number(r?.endSec ?? (Number.isFinite(startSec) ? startSec + Number(r?.duration || 0) : NaN));
    const factor = clampFactor(r?.factor ?? r?.speed);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue;
    if (Math.abs(factor - 1) < 0.01) continue;
    out.push({ startSec: Math.max(0, startSec), endSec, factor });
  }
  out.sort((a, b) => a.startSec - b.startSec);

  if (!out.length && constant != null && Math.abs(constant - 1) >= 0.01) {
    const end = durationSec != null ? Number(durationSec) : 9999;
    if (end > 0) out.push({ startSec: 0, endSec: end, factor: constant });
  }
  return out;
}

/**
 * Expand ramps into a full coverage plan [0, duration) with factor 1 gaps filled.
 */
function buildSpeedPlan(ramps, durationSec) {
  const dur = Math.max(0.04, Number(durationSec) || 0);
  const list = normalizeSpeedRamps(ramps, { durationSec: dur });
  if (!list.length) return [{ startSec: 0, endSec: dur, factor: 1 }];

  const plan = [];
  let cursor = 0;
  for (const r of list) {
    const start = Math.max(cursor, Math.min(dur, r.startSec));
    const end = Math.max(start, Math.min(dur, r.endSec));
    if (start > cursor + 0.02) {
      plan.push({ startSec: cursor, endSec: start, factor: 1 });
    }
    if (end > start + 0.02) {
      plan.push({ startSec: start, endSec: end, factor: r.factor });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < dur - 0.02) {
    plan.push({ startSec: cursor, endSec: dur, factor: 1 });
  }
  return plan.filter((p) => p.endSec > p.startSec + 0.02);
}

function runFfmpeg(args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function probeDuration(inputPath) {
  const { probeDurationSec } = require('./clip_comp_tts');
  return probeDurationSec(inputPath);
}

/**
 * Apply timed speed ramps (video setpts + audio atempo) then concat.
 */
async function applySpeedRamps(inputPath, outputPath, ramps, { log = null, previewFast = false } = {}) {
  const durationSec = await probeDuration(inputPath);
  const plan = buildSpeedPlan(ramps, durationSec);
  const needsWork = plan.some((p) => Math.abs(p.factor - 1) >= 0.01);
  if (!needsWork || plan.length === 0) {
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }

  // Single constant factor for whole clip — one pass.
  if (plan.length === 1) {
    const f = plan[0].factor;
    const vf = buildSetpts(f);
    const af = buildAtempoChain(f);
    const enc = previewFast
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
    const args = ['-i', inputPath];
    if (vf) args.push('-vf', vf);
    if (af) args.push('-af', af);
    args.push(
      ...enc, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    );
    await runFfmpeg(args);
    if (log) log(`[speed-ramps] CPD-1281 constant ${f}×`);
    return outputPath;
  }

  const tmpStem = `${outputPath}.speedseg`;
  const parts = [];
  const enc = previewFast
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];

  for (let i = 0; i < plan.length; i++) {
    const seg = plan[i];
    const slice = `${tmpStem}_${i}.mp4`;
    const dur = seg.endSec - seg.startSec;
    const vf = buildSetpts(seg.factor);
    const af = buildAtempoChain(seg.factor);
    const args = [
      '-ss', String(seg.startSec),
      '-i', inputPath,
      '-t', String(dur),
      '-map', '0:v:0',
      '-map', '0:a:0?',
    ];
    if (vf) args.push('-vf', vf);
    if (af) args.push('-af', af);
    args.push(
      ...enc, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', slice,
    );
    await runFfmpeg(args);
    parts.push(slice);
  }

  if (parts.length === 1) {
    fs.renameSync(parts[0], outputPath);
    return outputPath;
  }

  const listPath = `${tmpStem}_concat.txt`;
  fs.writeFileSync(
    listPath,
    parts.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n'),
  );
  await runFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outputPath,
  ]);
  for (const p of parts) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
  try { fs.unlinkSync(listPath); } catch (_) { /* ignore */ }
  if (log) log(`[speed-ramps] CPD-1281 ${plan.length} segment(s)`);
  return outputPath;
}

/** Constant-factor filter fragments for assembly_effects registry. */
function constantSpeedFilters(factor) {
  const f = clampFactor(factor);
  if (Math.abs(f - 1) < 0.01) return { vf: null, af: null };
  return { vf: buildSetpts(f), af: buildAtempoChain(f) };
}

module.exports = {
  clampFactor,
  buildAtempoChain,
  buildSetpts,
  normalizeSpeedRamps,
  buildSpeedPlan,
  applySpeedRamps,
  constantSpeedFilters,
};
