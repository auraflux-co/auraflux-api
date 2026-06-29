'use strict';

/**
 * Objective visual QA for Soup hold-cut / scene-reset joins.
 * Complements Gemini — scores dip depth, tail motion, pose jump (what humans see as "flash").
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath, ffprobePath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');

const execFileAsync = promisify(execFile);

const PASS = {
  dipDepthMin: 0.85,
  tailMotionMax: 1.5,
  poseJumpSsimMin: 0.85,
  postCutLumaDeltaMax: 8,
  freezeStabilitySsimMin: 0.90,
};

async function probeDuration(filePath) {
  const d = await probeDurationSec(filePath);
  return d || 0;
}

async function extractPng(videoPath, atSec, outPng) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const abs = path.isAbsolute(videoPath) ? videoPath : path.resolve(path.join(__dirname, '..'), videoPath);
  const out = path.resolve(outPng);
  try {
    await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', Math.max(0, atSec).toFixed(4),
      '-i', abs,
      '-frames:v', '1', '-update', '1',
      out,
    ], { timeout: 60000 });
  } catch (e) {
    throw new Error(`extractPng ffmpeg: ${(e.stderr || e.message || '').toString().slice(0, 200)}`);
  }
  if (!fs.existsSync(out)) throw new Error(`extractPng failed: ${out}`);
}

async function pngSsim(pngA, pngB) {
  const { stderr } = await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'info',
    '-i', pngA, '-i', pngB,
    '-lavfi', 'ssim', '-f', 'null', '-',
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const m = String(stderr || '').match(/All:([\d.]+)/);
  return m ? Number(m[1]) : null;
}

/** Mean luma + fraction of pixels near black (0–16). */
async function pngLumaStats(pngPath) {
  const { stdout } = await execFileAsync('python3', ['-c', `
import json, sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('L')
d = list(im.getdata())
n = len(d) or 1
print(json.dumps({"mean": sum(d)//n, "pct_black": round(sum(1 for x in d if x < 16)/n, 4)}))
`, pngPath], { timeout: 30000 });
  return JSON.parse(stdout.trim());
}

/** Average frame-to-frame diff in last windowSec of segment (higher = still moving). */
async function tailMotionEnergy(videoPath, endSec, windowSec = 0.4, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const abs = path.isAbsolute(videoPath) ? videoPath : path.resolve(path.join(__dirname, '..'), videoPath);
  const fps = 10;
  const n = Math.max(2, Math.round(windowSec * fps));
  const script = `
import subprocess, re, sys, os, tempfile
from PIL import Image
video, end, window, fps, n, tmp = sys.argv[1:7]
end=float(end); window=float(window); fps=float(fps); n=int(n)
diffs=[]
prev=None
for i in range(n):
    t=max(0, end-window+i/fps)
    fp=os.path.join(tmp, f"f{i}.png")
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss',f'{t:.4f}','-i',video,'-frames:v','1','-update','1',fp], check=False)
    if not os.path.exists(fp):
        continue
    data=list(Image.open(fp).convert('L').resize((480,270)).getdata())
    if prev is not None:
        diffs.append(sum(abs(a-b) for a,b in zip(data,prev))/len(data))
    prev=data
print(round(sum(diffs)/len(diffs),2) if diffs else 0)
`;
  const td = fs.mkdtempSync(path.join(tmpDir, 'mot_'));
  const { stdout } = await execFileAsync('python3', ['-c', script, abs, String(endSec), String(windowSec), String(fps), String(n), td], { timeout: 120000 });
  return parseFloat(stdout.trim()) || 0;
}

/**
 * Score a scene-reset join from left/right segment files (pre-stitch).
 * dipSec/holdSec must match soupSceneResetHoldCut policy.
 */
async function scoreSceneResetJoin(leftPathIn, rightPathIn, {
  holdSec = 0.14,
  dipSec = 0.14,
  slateSec = 0.06,
  tmpDir = path.join(__dirname, '..', 'tmp', 'join_metrics'),
  sceneLabel = '',
  toLabel = '',
} = {}) {
  const leftPath = path.resolve(leftPathIn);
  const rightPath = path.resolve(rightPathIn);
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) {
    return { pass: false, error: 'missing_segment' };
  }
  fs.mkdirSync(tmpDir, { recursive: true });
  const tag = path.basename(leftPath).replace(/\W/g, '_').slice(0, 40);

  const { prepLeftForSceneReset } = require('./soup_segment_prep');
  const label = sceneLabel || path.basename(leftPath);
  const prepped = await prepLeftForSceneReset(leftPath, {
    tmpDir: path.join(tmpDir, tag),
    label,
  });
  const leftScored = prepped.path;

  const leftDur = await probeDuration(leftScored);
  const slate = Math.max(0.04, slateSec);
  const cutSec = leftDur + holdSec;
  const slateCenter = cutSec + slate / 2;

  const pngLast = path.join(tmpDir, `${tag}_last.png`);
  const pngFirst = path.join(tmpDir, `${tag}_first.png`);
  const pngFreezeA = path.join(tmpDir, `${tag}_freeze_a.png`);
  const pngFreezeB = path.join(tmpDir, `${tag}_freeze_b.png`);
  await extractPng(leftScored, Math.max(0.01, leftDur - 0.15), pngLast);
  await extractPng(rightPath, 0.04, pngFirst);
  await extractPng(leftScored, Math.max(0.01, leftDur - 0.38), pngFreezeA);
  await extractPng(leftScored, Math.max(0.01, leftDur - 0.04), pngFreezeB);

  const [poseJumpSsim, freezeStabilitySsim, lastLuma, firstLuma, tailMotion] = await Promise.all([
    pngSsim(pngLast, pngFirst),
    pngSsim(pngFreezeA, pngFreezeB),
    pngLumaStats(pngLast),
    pngLumaStats(pngFirst),
    tailMotionEnergy(leftScored, leftDur, 0.4, path.join(tmpDir, `${tag}_mot`)),
  ]);

  let dipPctBlack = null;
  let dipMean = lastLuma.mean;
  const mergedOut = path.join(tmpDir, `${tag}_pair.mp4`);
  const useHardCut = !holdSec && !slateSec;
  try {
    const { mergeTwoWithHoldCut, mergeTwoWithCut, mergeTwoWithXfade } = require('./assembly');
    if (useHardCut) {
      await mergeTwoWithXfade(leftScored, rightPath, mergedOut, {
        videoDur: 0.22,
        audioDur: 0.22,
        fadeReactionTail: /_CLIP1_REACTION$/i.test(label) || /_CLIP2_REACTION$/i.test(label),
        reactionTailFadeSec: 0.35,
        prepStableTail: false,
      });
    } else {
      await mergeTwoWithHoldCut(leftScored, rightPath, mergedOut, {
        holdSec, dipSec, slateSec: slate, audioCrossfadeSec: 0.2, prepStableTail: false,
      });
      const dipPng = path.join(tmpDir, `${tag}_slate.png`);
      await extractPng(mergedOut, Math.max(0, slateCenter), dipPng);
      const dipStats = await pngLumaStats(dipPng);
      dipPctBlack = dipStats.pct_black;
      dipMean = dipStats.mean;
    }
  } catch (e) {
    return { pass: false, error: e.message.slice(0, 200) };
  }

  const postCutLumaDelta = Math.abs((firstLuma.mean || 0) - (lastLuma.mean || 0));
  const joinKind = /_INTRO$/i.test(label) && /_CLIP1_SETUP$/i.test(toLabel)
    ? 'intro_to_setup'
    : /_CLIP1_REACTION$/i.test(label)
      ? 'reaction_to_setup'
      : /_CLIP2_REACTION$/i.test(label)
        ? 'handoff'
        : 'scene_reset';
  const thresholds = {
    ...PASS,
    poseJumpSsimMin: joinKind === 'intro_to_setup' ? 0.72 : joinKind === 'reaction_to_setup' ? 0.80 : PASS.poseJumpSsimMin,
  };

  const issues = [];
  if (tailMotion > thresholds.tailMotionMax) issues.push('left_tail_motion');
  if (dipPctBlack != null && dipPctBlack < thresholds.dipDepthMin) issues.push('weak_dip');
  if (freezeStabilitySsim != null && freezeStabilitySsim < thresholds.freezeStabilitySsimMin) issues.push('unstable_freeze');
  if (joinKind !== 'intro_to_setup' && poseJumpSsim != null && poseJumpSsim < thresholds.poseJumpSsimMin) issues.push('pose_jump');
  if (postCutLumaDelta > thresholds.postCutLumaDeltaMax) issues.push('luma_jump');

  const score = Math.max(0, Math.min(100, Math.round(
    100
    - Math.max(0, tailMotion - thresholds.tailMotionMax) * 12
    - (dipPctBlack != null ? Math.max(0, thresholds.dipDepthMin - dipPctBlack) * 80 : 0)
    - (freezeStabilitySsim != null ? Math.max(0, thresholds.freezeStabilitySsimMin - freezeStabilitySsim) * 150 : 0)
    - (joinKind !== 'intro_to_setup' && poseJumpSsim != null ? Math.max(0, thresholds.poseJumpSsimMin - poseJumpSsim) * 120 : 0)
    - Math.max(0, postCutLumaDelta - thresholds.postCutLumaDeltaMax) * 1.5
  )));

  return {
    pass: issues.length === 0,
    score,
    issues,
    metrics: {
      leftDur: Math.round(leftDur * 1000) / 1000,
      cutSec: Math.round(cutSec * 1000) / 1000,
      tailMotion,
      dipPctBlack,
      dipMean,
      poseJumpSsim,
      freezeStabilitySsim,
      joinKind,
      postCutLumaDelta,
      lastLumaMean: lastLuma.mean,
      firstLumaMean: firstLuma.mean,
      prepPlan: prepped.plan,
    },
    thresholds,
  };
}

/** Score all scene-reset joins from a streamer block report. */
async function scoreStreamerBlockJoins(reportPath, { tmpDir, log = console.log } = {}) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const results = [];
  for (const j of (report.joins || [])) {
    if (j.policyName !== 'hold_cut' && j.policy?.mode !== 'hold_cut' && !j.policy?.sceneReset) continue;
    const clipDir = path.dirname(reportPath);
    const blockMp4 = report.blockMp4;
    const leftIdx = j.index - 1;
    const labels = report._segmentLabels;
    log(`[join-metrics] ${j.from} → ${j.to}...`);
    const row = {
      ...j,
      visual: null,
    };
    if (report._segmentFiles && report._segmentFiles[leftIdx] && report._segmentFiles[j.index]) {
      row.visual = await scoreSceneResetJoin(
        report._segmentFiles[leftIdx],
        report._segmentFiles[j.index],
        {
          holdSec: 0,
          dipSec: 0,
          slateSec: 0,
          tmpDir: path.join(tmpDir || path.join(clipDir, 'metrics'), j.from),
          sceneLabel: j.from || (labels && labels[leftIdx]) || '',
          toLabel: j.to || (labels && labels[j.index]) || '',
        },
      );
    } else if (blockMp4 && fs.existsSync(blockMp4)) {
      row.visual = await scoreJoinFromBlock(blockMp4, j.atSec, {
        holdSec: j.policy?.holdSec ?? 0.1,
        dipSec: j.policy?.dipSec ?? 0.05,
        tmpDir: path.join(tmpDir || path.join(clipDir, 'metrics'), `block_${j.index}`),
      });
    }
    results.push(row);
  }
  const passed = results.filter((r) => r.visual?.pass).length;
  const summary = {
    streamer: report.streamer,
    asmId: report.asmId,
    reviewedAt: new Date().toISOString(),
    total: results.length,
    passed,
    overallPass: passed === results.length,
    results,
  };
  const outPath = reportPath.replace(/block_report\.json$/, 'visual_metrics_report.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  return summary;
}

/** Fallback: sample stitched block around join timestamp. */
async function scoreJoinFromBlock(blockMp4, atSec, { holdSec, dipSec, tmpDir } = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const dipAt = atSec + holdSec - dipSec / 2;
  const pngDip = path.join(tmpDir, 'dip.png');
  const pngPre = path.join(tmpDir, 'pre.png');
  const pngPost = path.join(tmpDir, 'post.png');
  await extractPng(blockMp4, Math.max(0, atSec - 0.05), pngPre);
  await extractPng(blockMp4, Math.max(0, dipAt), pngDip);
  await extractPng(blockMp4, atSec + holdSec + 0.05, pngPost);
  const [pre, dip, post, jump] = await Promise.all([
    pngLumaStats(pngPre),
    pngLumaStats(pngDip),
    pngLumaStats(pngPost),
    pngSsim(pngPre, pngPost),
  ]);
  const issues = [];
  if (dip.pct_black < PASS.dipDepthMin) issues.push('weak_dip');
  if (jump != null && jump < PASS.poseJumpSsimMin) issues.push('pose_jump');
  return {
    pass: issues.length === 0,
    score: Math.round(100 - issues.length * 25),
    issues,
    metrics: { dipPctBlack: dip.pct_black, poseJumpSsim: jump, preMean: pre.mean, dipMean: dip.mean, postMean: post.mean },
    source: 'block_sample',
  };
}

module.exports = {
  PASS,
  scoreSceneResetJoin,
  scoreStreamerBlockJoins,
  scoreJoinFromBlock,
  tailMotionEnergy,
};
