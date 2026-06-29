'use strict';

/**
 * Pre-stitch segment prep for scene-reset hold-cut joins.
 * Trims trailing motion so hold-freeze lands on a stable frame (matches 1:50 handoff feel).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');
const { detectHeyGenPauseWindow } = require('./studio_laughter');

const execFileAsync = promisify(execFile);

const MOTION_THRESHOLD = 0.95;
const TAIL_WINDOW_SEC = 0.5;
const MIN_TRIM_SEC = 0.06;
const MAX_TRIM_SEC = 0.45;

async function probeDuration(filePath) {
  return (await probeDurationSec(filePath)) || 0;
}

async function extractPng(videoPath, atSec, outPng) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Math.max(0, atSec).toFixed(4),
    '-i', path.resolve(videoPath),
    '-frames:v', '1', '-update', '1',
    path.resolve(outPng),
  ], { timeout: 60000 });
}

/** Pixel-diff motion between consecutive frames in the tail window. */
async function tailMotionSamples(videoPath, endSec, windowSec = TAIL_WINDOW_SEC, fps = 10) {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'soup_tail_'));
  const script = `
import subprocess, sys, os, json
from PIL import Image
video, end, window, fps, tmp = sys.argv[1:6]
end=float(end); window=float(window); fps=float(fps)
n=max(2, int(window*fps))
samples=[]
prev=None
for i in range(n):
    t=max(0, end-window+i/fps)
    fp=os.path.join(tmp, f"f{i}.png")
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss',f'{t:.4f}',
      '-i',video,'-frames:v','1','-update','1',fp], check=False)
    if not os.path.exists(fp):
        continue
    data=list(Image.open(fp).convert('L').resize((480,270)).getdata())
    if prev is not None:
        diff=sum(abs(a-b) for a,b in zip(data,prev))/len(data)
        samples.append({"t": t, "diff": round(diff, 3)})
    prev=data
print(json.dumps(samples))
`;
  const { stdout } = await execFileAsync('python3', [
    '-c', script,
    path.resolve(videoPath),
    String(endSec),
    String(windowSec),
    String(fps),
    td,
  ], { timeout: 120000 });
  try { fs.rmSync(td, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  return JSON.parse(stdout.trim() || '[]');
}

/**
 * Find trim point: last timestamp in tail where motion to next frame is calm.
 * @returns {{ trimAt: number, tailMotion: number, trimmed: boolean, reason: string }}
 */
async function findStableTailTrimPoint(videoPath, {
  windowSec = TAIL_WINDOW_SEC,
  motionThreshold = MOTION_THRESHOLD,
} = {}) {
  const dur = await probeDuration(videoPath);
  if (dur < 0.8) {
    return { trimAt: dur, tailMotion: 0, trimmed: false, reason: 'too_short' };
  }
  const samples = await tailMotionSamples(videoPath, dur, windowSec);
  if (samples.length < 2) {
    return { trimAt: dur, tailMotion: 0, trimmed: false, reason: 'no_samples' };
  }
  const avgMotion = samples.reduce((s, x) => s + x.diff, 0) / samples.length;

  if (avgMotion > 2.5) {
    const trimAt = Math.max(dur * 0.70, dur - 0.48);
    return {
      trimAt: Math.round(trimAt * 1000) / 1000,
      tailMotion: Math.round(avgMotion * 100) / 100,
      trimmed: true,
      reason: 'trim_high_motion_tail',
    };
  }
  if (avgMotion > 2.0) {
    const trimAt = Math.max(dur * 0.72, dur - 0.42);
    return {
      trimAt: Math.round(trimAt * 1000) / 1000,
      tailMotion: Math.round(avgMotion * 100) / 100,
      trimmed: true,
      reason: 'trim_high_motion_tail',
    };
  }
  if (avgMotion > 1.2) {
    const trimAt = Math.max(dur * 0.78, dur - 0.2);
    return {
      trimAt: Math.round(trimAt * 1000) / 1000,
      tailMotion: Math.round(avgMotion * 100) / 100,
      trimmed: true,
      reason: 'trim_moderate_motion_tail',
    };
  }

  if (avgMotion <= motionThreshold) {
    return { trimAt: dur, tailMotion: Math.round(avgMotion * 100) / 100, trimmed: false, reason: 'already_stable' };
  }

  let trimAt = dur;
  const minSample = samples.reduce((best, s) => (s.diff < best.diff ? s : best), samples[0]);
  trimAt = Math.min(dur, minSample.t + 2 / 10);
  const trimAmt = dur - trimAt;
  if (trimAmt < MIN_TRIM_SEC) {
    return { trimAt: dur, tailMotion: Math.round(avgMotion * 100) / 100, trimmed: false, reason: 'trim_too_small' };
  }
  if (trimAmt > MAX_TRIM_SEC) {
    trimAt = dur - MAX_TRIM_SEC;
  }
  if (trimAt < dur * 0.75) {
    trimAt = dur;
    return { trimAt: dur, tailMotion: Math.round(avgMotion * 100) / 100, trimmed: false, reason: 'trim_too_aggressive' };
  }
  return {
    trimAt: Math.round(trimAt * 1000) / 1000,
    tailMotion: Math.round(avgMotion * 100) / 100,
    trimmed: trimAt < dur - 0.02,
    reason: 'trimmed_trailing_motion',
  };
}

async function trimSegmentVideo(videoPath, trimAtSec, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', path.resolve(videoPath),
    '-t', trimAtSec.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    path.resolve(outPath),
  ], { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
  return outPath;
}

/**
 * Trim left segment tail before hold-cut when avatar is still moving.
 */
async function prepLeftForSceneReset(leftPath, {
  tmpDir = path.join(os.tmpdir(), 'soup_prep'),
  label = '',
  logFn = null,
  force = false,
} = {}) {
  const log = (m) => { if (logFn) logFn(m); };
  const plan = await findStableTailTrimPoint(leftPath);
  let finalPlan = { ...plan };
  const dur = await probeDuration(leftPath);
  if (/_CLIP[12]_REACTION$/i.test(String(label))) {
    const reactionTrim = Math.max(dur * 0.78, dur - 0.18);
    if (!finalPlan.trimmed || reactionTrim < finalPlan.trimAt) {
      finalPlan = {
        trimAt: Math.round(reactionTrim * 1000) / 1000,
        tailMotion: plan.tailMotion,
        trimmed: true,
        reason: 'trim_scene_reset_reaction',
      };
    }
  } else if (/^[A-Z][A-Z0-9]*_INTRO$/i.test(String(label))) {
    const pause = await detectHeyGenPauseWindow(leftPath, { targetPauseSec: 4 });
    if (pause && pause.start > 0.5 && pause.start < dur - 1 && !pause.hasSpeechAfter) {
      // Legacy intro with trailing break — cut before hold, not at hold end
      finalPlan = {
        trimAt: Math.round(pause.start * 1000) / 1000,
        tailMotion: plan.tailMotion,
        trimmed: true,
        reason: 'trim_intro_speech_end',
      };
    }
    // Speech-only intros: keep findStableTailTrimPoint result (no forced 68% chop)
  }
  if (!finalPlan.trimmed && !force) {
    return { path: leftPath, temp: null, plan: finalPlan };
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const stem = path.basename(leftPath, path.extname(leftPath)).replace(/\W/g, '_').slice(0, 48);
  const outPath = path.join(tmpDir, `${stem}_stable_${Date.now()}.mp4`);
  await trimSegmentVideo(leftPath, finalPlan.trimAt, outPath);
  log(`  🎯 stable-tail prep ${label || stem}: ${finalPlan.reason} trim ${finalPlan.trimAt.toFixed(2)}s (motion ${finalPlan.tailMotion})`);
  return { path: outPath, temp: outPath, plan: { ...finalPlan, trimmed: true } };
}

/**
 * Skip leading HeyGen pause on SETUP segments ([scene hold] legacy renders).
 * Gold path 150: incoming speaks from frame 1 — no opening break.
 */
async function prepRightSkipLeadingHold(rightPath, {
  tmpDir = path.join(os.tmpdir(), 'soup_prep'),
  label = '',
  logFn = null,
} = {}) {
  const log = (m) => { if (logFn) logFn(m); };
  if (!/_CLIP\d+_SETUP$/i.test(String(label))) {
    return { path: rightPath, temp: null, plan: { trimmed: false, reason: 'not_setup' } };
  }
  const pause = await detectHeyGenPauseWindow(rightPath, { targetPauseSec: 4 });
  if (!pause || pause.start > 0.35 || pause.duration < 2) {
    return { path: rightPath, temp: null, plan: { trimmed: false, reason: 'no_leading_pause' } };
  }
  const dur = await probeDuration(rightPath);
  const skipTo = Math.min(pause.end, dur - 0.5);
  if (skipTo < 0.3) {
    return { path: rightPath, temp: null, plan: { trimmed: false, reason: 'skip_too_short' } };
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const stem = path.basename(rightPath, path.extname(rightPath)).replace(/\W/g, '_').slice(0, 48);
  const outPath = path.join(tmpDir, `${stem}_noshold_${Date.now()}.mp4`);
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', skipTo.toFixed(3),
    '-i', path.resolve(rightPath),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    path.resolve(outPath),
  ], { timeout: 300000, maxBuffer: 50 * 1024 * 1024 });
  log(`  🎯 skip leading hold ${label || stem}: from ${skipTo.toFixed(2)}s (${Math.round(pause.duration * 100) / 100}s pause)`);
  return {
    path: outPath,
    temp: outPath,
    plan: { trimmed: true, skipTo, pauseDur: pause.duration, reason: 'skip_setup_leading_hold' },
  };
}

module.exports = {
  MOTION_THRESHOLD,
  TAIL_WINDOW_SEC,
  findStableTailTrimPoint,
  tailMotionSamples,
  trimSegmentVideo,
  prepLeftForSceneReset,
  prepRightSkipLeadingHold,
};
