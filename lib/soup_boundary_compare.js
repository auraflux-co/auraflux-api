'use strict';

/** Localhost QA tool — prefer system ffmpeg (Docker wrapper optional). */
if (!process.env.FFMPEG_PATH && !process.env.USE_LOCAL_FFMPEG) {
  process.env.USE_LOCAL_FFMPEG = '1';
}

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath, ffprobePath, filterFfmpegPath, probeMp4DecodeIntegrity } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');
const { measurePairVideoQuality } = require('./video_quality_metrics');

const execFileAsync = promisify(execFile);

/** Avatar joins — highest value for xfade tuning (HeyGen pose resets). */
const PRIORITY_FEATURES = new Set([
  'avatar_segment',
  'bobby_reaction',
  'bobby_intro',
  'studio_laugh',
]);

const XFADE_SEC_DEFAULT = 0.22;

function parseArgs(argv) {
  const out = {
    baseline: null,
    candidate: null,
    jobId: null,
    rundown: null,
    candidateAsmId: null,
    outDir: null,
    windowSec: 2.0,
    allBoundaries: false,
    maxClips: 40,
    xfadeSec: XFADE_SEC_DEFAULT,
    dualTimeline: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--candidate') out.candidate = argv[++i];
    else if (a === '--job-id') out.jobId = argv[++i];
    else if (a === '--rundown') out.rundown = argv[++i];
    else if (a === '--candidate-asm-id') out.candidateAsmId = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--window') out.windowSec = Number(argv[++i]) || 2.0;
    else if (a === '--all-boundaries') out.allBoundaries = true;
    else if (a === '--max-clips') out.maxClips = Number(argv[++i]) || 40;
    else if (a === '--xfade-sec') out.xfadeSec = Number(argv[++i]) || XFADE_SEC_DEFAULT;
    else if (a === '--dual-timeline') out.dualTimeline = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.candidateAsmId) out.dualTimeline = true;
  return out;
}

function loadRundownFromJob(jobId, repoRoot) {
  const root = repoRoot || path.join(__dirname, '..');
  let card = null;
  try {
    const { loadJob } = require('./db');
    card = loadJob(jobId);
  } catch (_) { /* sqlite optional */ }
  if (!card) {
    const jobsPath = path.join(root, 'data', 'jobs.json');
    if (fs.existsSync(jobsPath)) {
      card = JSON.parse(fs.readFileSync(jobsPath, 'utf8'))[jobId];
    }
  }
  if (!card) return null;

  if (card.postAssemblyRundown?.entries?.length) return card.postAssemblyRundown;

  const candidates = [];
  if (card.postAssemblyRundownPath && fs.existsSync(card.postAssemblyRundownPath)) {
    candidates.push(card.postAssemblyRundownPath);
  }
  const asmId = card.assemblyId || card.lastAsmId;
  if (asmId) {
    candidates.push(path.join(root, 'output', `${asmId}_post_rundown.json`));
  }
  try {
    const outDir = path.join(root, 'output');
    for (const f of fs.readdirSync(outDir).filter((n) => n.includes(jobId) && n.endsWith('_post_rundown.json'))) {
      candidates.push(path.join(outDir, f));
    }
  } catch (_) { /* non-fatal */ }

  for (const p of candidates) {
    try {
      const r = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (r?.entries?.length) return r;
    } catch (_) { /* try next */ }
  }
  return null;
}

function loadRundown(opts, repoRoot) {
  if (opts.rundown) {
    return JSON.parse(fs.readFileSync(path.resolve(opts.rundown), 'utf8'));
  }
  if (opts.jobId) {
    const r = loadRundownFromJob(opts.jobId, repoRoot);
    if (!r) throw new Error(`No post-assembly rundown for job ${opts.jobId} — run assembly or scripts/rebuild_soup_rundown.js`);
    return r;
  }
  throw new Error('Pass --rundown <json> or --job-id <id>');
}

/**
 * Build join points from rundown timeline entries.
 * @returns {Array<{ index, atSec, timestamp, fromLabel, toLabel, fromFeature, toFeature, priority }>}
 */
function boundariesFromRundown(rundown, { allBoundaries = false, minSegmentSec = 2.5 } = {}) {
  const entries = rundown?.entries || [];
  const bounds = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const from = entries[i];
    const to = entries[i + 1];
    if (to.feature === 'credits_outro' && from.feature === 'credits_outro') continue;
    // Cold open → INTRO is an intentional hard cut (bookends), not xfade QA.
    if (from.feature === 'cold_open' && to.feature === 'bobby_intro') continue;
    const fromDur = Number(from.durationSec) || (from.endSec - from.startSec);
    const toDur = Number(to.durationSec) || (to.endSec - to.startSec);
    if (minSegmentSec > 0 && (fromDur < minSegmentSec || toDur < minSegmentSec)) continue;
    const atSec = Number(from.endSec);
    if (!Number.isFinite(atSec) || atSec <= 0) continue;
    const priority = PRIORITY_FEATURES.has(from.feature)
      || PRIORITY_FEATURES.has(to.feature)
      || (from.feature === 'twitch_clip' && PRIORITY_FEATURES.has(to.feature));
    if (!allBoundaries && !priority && from.feature === 'twitch_clip' && to.feature === 'twitch_clip') {
      continue;
    }
    bounds.push({
      index: bounds.length + 1,
      atSec,
      timestamp: from.endTimestamp || formatTs(atSec),
      fromLabel: from.label || from.segmentLabel || from.feature,
      toLabel: to.label || to.segmentLabel || to.feature,
      fromFeature: from.feature,
      toFeature: to.feature,
      priority: !!priority,
    });
  }
  return bounds;
}

/**
 * Recalculate entry timestamps assuming xfade between body segments.
 * cold_open → next segment stays a hard cut (no overlap subtract on cold open end).
 */
function recalcTimelineWithXfade(entries, { xfadeSec = XFADE_SEC_DEFAULT } = {}) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const dur = Number(e.durationSec) || Math.max(0, Number(e.endSec) - Number(e.startSec));
    const startSec = i === 0 ? 0 : out[i - 1].endSec;
    const hasXfadeAfter = i < entries.length - 1 && e.feature !== 'credits_outro';
    const xfadeAfter = hasXfadeAfter && e.feature !== 'cold_open' && e.feature !== 'twitch_clip';
    const endSec = startSec + dur - (xfadeAfter ? xfadeSec : 0);
    out.push({
      ...e,
      startSec: Math.round(startSec * 1000) / 1000,
      endSec: Math.round(endSec * 1000) / 1000,
      durationSec: Math.round(dur * 10) / 10,
      timestamp: formatTs(startSec),
      endTimestamp: formatTs(endSec),
    });
  }
  return out;
}

/** Pair baseline (hard-cut) joins with candidate (xfade) joins by segment label order. */
function boundariesFromDualRundown(baselineRundown, candidateRundown, opts = {}) {
  const {
    allBoundaries = false,
    minSegmentSec = 2.5,
    xfadeSec = XFADE_SEC_DEFAULT,
  } = opts;
  const baseEntries = baselineRundown?.entries || [];
  const candRaw = candidateRundown?.entries || [];
  const candEntries = recalcTimelineWithXfade(candRaw, { xfadeSec });
  const bounds = [];

  for (let i = 0; i < baseEntries.length - 1; i++) {
    const fromB = baseEntries[i];
    const toB = baseEntries[i + 1];
    const fromC = candEntries[i];
    const toC = candEntries[i + 1];
    if (!fromB || !toB || !fromC || !toC) continue;
    if (toB.feature === 'credits_outro' && fromB.feature === 'credits_outro') continue;
    if (fromB.feature === 'cold_open' && toB.feature === 'bobby_intro') continue;

    const fromDur = Number(fromB.durationSec) || (fromB.endSec - fromB.startSec);
    const toDur = Number(toB.durationSec) || (toB.endSec - toB.startSec);
    if (minSegmentSec > 0 && (fromDur < minSegmentSec || toDur < minSegmentSec)) continue;

    const priority = PRIORITY_FEATURES.has(fromB.feature)
      || PRIORITY_FEATURES.has(toB.feature)
      || (fromB.feature === 'twitch_clip' && PRIORITY_FEATURES.has(toB.feature));
    if (!allBoundaries && !priority && fromB.feature === 'twitch_clip' && toB.feature === 'twitch_clip') {
      continue;
    }

    bounds.push({
      index: bounds.length + 1,
      atSec: Number(fromB.endSec),
      candidateAtSec: Number(fromC.endSec),
      timestamp: fromB.endTimestamp || formatTs(fromB.endSec),
      candidateTimestamp: fromC.endTimestamp || formatTs(fromC.endSec),
      fromLabel: fromB.label || fromB.segmentLabel || fromB.feature,
      toLabel: toB.label || toB.segmentLabel || toB.feature,
      fromFeature: fromB.feature,
      toFeature: toB.feature,
      priority: !!priority,
      timelineDeltaSec: Math.round((Number(fromC.endSec) - Number(fromB.endSec)) * 1000) / 1000,
    });
  }
  return bounds;
}

async function loadCandidateRundownFromAsm(jobId, asmId, repoRoot) {
  const { loadJob } = require('./db');
  const { rebuildPostAssemblyRundownFromTmpSegments } = require('./twitch_bookends');
  const { injectStudioLaughterSegments } = require('./studio_laughter');
  const root = repoRoot || path.join(__dirname, '..');

  let card = null;
  try { card = loadJob(jobId); } catch (_) { /* optional */ }
  if (!card) {
    card = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs.json'), 'utf8'))[jobId];
  }
  if (!card) throw new Error(`Job not found: ${jobId}`);

  const videoJobs = (card.heygen?.videoJobs || []).filter((v) => v.status === 'completed' || v.video_url);
  const avatarByName = {};
  for (const seg of videoJobs) avatarByName[seg.sceneName || seg.scene] = seg;

  const orderedClipUrls = card.orderedClipUrls || [];
  const scriptScenes = card.script?.scenes || [];
  const segmentData = [];
  let clipIdx = 0;
  for (const scene of scriptScenes) {
    if (scene.type === 'source_clip') continue;
    const sceneKey = scene.name || scene.id;
    const avatarSeg = avatarByName[sceneKey];
    if (avatarSeg?.video_url) {
      segmentData.push({ url: avatarSeg.video_url, label: sceneKey, type: 'avatar' });
      if (scene.hasClipInsert) {
        const clip = orderedClipUrls[clipIdx++];
        if (clip?.url || clip?.clipUrl) {
          segmentData.push({
            url: clip.clipUrl || clip.url,
            label: clip.label || `${sceneKey}_CLIP`,
            type: 'source_clip',
          });
        }
      }
    }
  }
  injectStudioLaughterSegments(segmentData, card.contentType || 'twitch', { customerId: card.customerId || 'c0' });

  const old = card.postAssemblyRundown || {};
  return rebuildPostAssemblyRundownFromTmpSegments({
    asmId,
    probeAsmId: asmId,
    jobId,
    card,
    segsToProcess: segmentData,
    coldOpenSec: old.coldOpenSec || card.coldOpenSec || 0,
    bodySecBeforeCredits: null,
    creditsSec: 0,
    mainMp4Path: null,
    verifyResult: { decodeOk: true },
    customerId: card.customerId || 'c0',
  });
}

function formatTs(sec) {
  const s = Math.max(0, Math.floor(sec));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function safeSlug(s, max = 48) {
  return String(s || 'join')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max);
}

async function probeMediaSpecs(videoPath) {
  const { stdout } = await execFileAsync(ffprobePath(), [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    videoPath,
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const fmt = data.format || {};
  const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (data.streams || []).find((s) => s.codec_type === 'audio') || {};
  const fps = v.avg_frame_rate && v.avg_frame_rate.includes('/')
    ? (() => {
      const [n, d] = v.avg_frame_rate.split('/').map(Number);
      return d ? Math.round((n / d) * 1000) / 1000 : null;
    })()
    : null;
  return {
    path: videoPath,
    durationSec: fmt.duration != null ? Number(fmt.duration) : null,
    sizeBytes: fmt.size != null ? Number(fmt.size) : null,
    bitrateKbps: fmt.bit_rate != null ? Math.round(Number(fmt.bit_rate) / 1000) : null,
    video: {
      codec: v.codec_name || null,
      width: v.width || null,
      height: v.height || null,
      fps,
      pixFmt: v.pix_fmt || null,
    },
    audio: {
      codec: a.codec_name || null,
      sampleRate: a.sample_rate != null ? Number(a.sample_rate) : null,
      channels: a.channels || null,
    },
  };
}

/**
 * VMAF + SSIM + PSNR on shared timeline start (trim to shorter file).
 * Full-overlap VMAF skipped by default — timeline shift makes scores misleading.
 */
async function measureOverlapVideoMetrics(baselinePath, candidatePath, overlapSec, statsDir, { includeVmaf = false } = {}) {
  const dur = Math.max(1, overlapSec - 0.05);
  const metrics = await measurePairVideoQuality(baselinePath, candidatePath, {
    durationSec: dur,
    statsDir,
    prefix: 'overlap',
    includeVmaf,
    vmafSubsample: 8,
  });
  return {
    overlapSec: Math.round(dur * 10) / 10,
    vmafMean: metrics.vmafMean,
    ssimMean: metrics.ssimMean,
    psnrMeanDb: metrics.psnrMeanDb,
    vmafLog: metrics.vmafLog,
    ssimLog: metrics.ssimLog,
    psnrLog: metrics.psnrLog,
    note: 'Overlap metrics compare first N seconds of both masters (trimmed). Different stitch lengths shift content — use per-boundary VMAF/SSIM for join QA.',
  };
}

/** VMAF + SSIM + PSNR on time-aligned windows (baseline vs candidate may differ when dual-timeline). */
async function measureWindowPairQuality(baselinePath, candidatePath, baselineAtSec, candidateAtSec, windowSec, tmpDir, statsDir, tag) {
  const startB = Math.max(0, baselineAtSec - windowSec);
  const startC = Math.max(0, candidateAtSec - windowSec);
  const dur = windowSec * 2;
  const bWin = path.join(tmpDir, `${tag}_base_win.mp4`);
  const cWin = path.join(tmpDir, `${tag}_cand_win.mp4`);
  const trim = async (inp, ss, out) => execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', ss.toFixed(3), '-t', dur.toFixed(3),
    '-i', inp,
    '-an', '-vf', 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-y', out,
  ], { timeout: 120000 });
  await trim(baselinePath, startB, bWin);
  await trim(candidatePath, startC, cWin);
  const metrics = await measurePairVideoQuality(bWin, cWin, {
    statsDir,
    prefix: tag,
    includeVmaf: true,
    vmafSubsample: 4,
    timeoutMs: 300000,
  });
  return {
    windowSec: dur,
    windowVmaf: metrics.vmafMean,
    windowSsim: metrics.ssimMean,
    windowPsnrDb: metrics.psnrMeanDb,
    vmafLog: metrics.vmafLog,
    ssimLog: metrics.ssimLog,
    psnrLog: metrics.psnrLog,
  };
}

/** Export PCM wav windows for Audacity A/V sync spot-check. */
async function extractBoundaryAudioWav(videoPath, atSec, windowSec, outWav) {
  const start = Math.max(0, atSec - windowSec);
  const dur = windowSec * 2;
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', start.toFixed(3), '-t', dur.toFixed(3),
    '-i', videoPath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    '-y', outWav,
  ], { timeout: 60000 });
}

/** Scene-change count near join center — xfade → low spike count; hard cut → sharp spike. */
async function measureJoinSceneSpike(videoPath, atSec, windowSec, tmpDir, tag) {
  const start = Math.max(0, atSec - windowSec);
  const dur = windowSec * 2;
  const clip = path.join(tmpDir, `${tag}_scene.mp4`);
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', start.toFixed(3), '-t', dur.toFixed(3),
    '-i', videoPath, '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-y', clip,
  ], { timeout: 120000 });
  const { stderr } = await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'info',
    '-i', clip,
    '-vf', 'select=gt(scene\\,0.25),showinfo', '-f', 'null', '-',
  ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const pts = [...String(stderr || '').matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const center = windowSec;
  const nearJoin = pts.filter((t) => Math.abs(t - center) < 0.35);
  return {
    sceneChangesInWindow: pts.length,
    sceneSpikesNearJoin: nearJoin.length,
    likelyHardCut: nearJoin.length >= 2,
  };
}

/** Refine join timestamp by local jump-score minimum (handles xfade timeline drift). */
async function refineJoinTimestamp(videoPath, approxSec, windowSec = 1.5, tmpDir) {
  const start = Math.max(0, approxSec - windowSec);
  const end = approxSec + windowSec;
  let best = { atSec: approxSec, jumpScore: Infinity, ssimNear: null };
  for (let t = start; t <= end; t += 0.05) {
    try {
      const r = await boundaryJumpScore(videoPath, t, tmpDir, `ref_${t.toFixed(2)}`);
      if (r.jumpScore != null && r.jumpScore < best.jumpScore) {
        best = { atSec: Math.round(t * 1000) / 1000, jumpScore: r.jumpScore, ssimNear: r.ssimNear };
      }
    } catch (_) { /* skip */ }
  }
  return best;
}

async function extractPng(videoPath, atSec, outPng) {
  const dur = await probeDurationSec(videoPath);
  const t = Math.max(0, Math.min(atSec, dur - 0.05));
  await execFileAsync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-ss', t.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-y', outPng,
  ], { timeout: 60000 });
}

/** Lower SSIM ≈ sharper jump between frames 30ms apart at boundary. */
async function boundaryJumpScore(videoPath, atSec, tmpDir, tag) {
  const t0 = Math.max(0, atSec - 0.03);
  const t1 = Math.max(0, atSec + 0.03);
  const pngA = path.join(tmpDir, `${tag}_a.png`);
  const pngB = path.join(tmpDir, `${tag}_b.png`);
  await extractPng(videoPath, t0, pngA);
  await extractPng(videoPath, t1, pngB);
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'info',
      '-i', pngA,
      '-i', pngB,
      '-lavfi', 'ssim',
      '-f', 'null', '-',
    ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    const m = String(stderr || '').match(/All:([\d.]+)/);
    const ssim = m ? Number(m[1]) : null;
    return {
      ssimNear: ssim,
      jumpScore: ssim != null ? Math.round((1 - ssim) * 1000) / 1000 : null,
      likelyHardCut: ssim != null && ssim < 0.72,
    };
  } finally {
    for (const p of [pngA, pngB]) {
      try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
  }
}

async function buildSideBySideClip(baselinePath, candidatePath, baselineAtSec, candidateAtSec, windowSec, outPath) {
  const startB = Math.max(0, baselineAtSec - windowSec);
  const startC = Math.max(0, candidateAtSec - windowSec);
  const dur = windowSec * 2;
  const fcPlain = [
    `[0:v]trim=start=${startB}:duration=${dur},setpts=PTS-STARTPTS,scale=960:-2[v0]`,
    `[1:v]trim=start=${startC}:duration=${dur},setpts=PTS-STARTPTS,scale=960:-2[v1]`,
    '[v0][v1]vstack=inputs=2[vout]',
  ].join(';');
  const drawBaseline = "drawtext=text='BASELINE':x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55";
  const drawCandidate = "drawtext=text='CANDIDATE':x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55";
  const fcLabeled = [
    `[0:v]trim=start=${startB}:duration=${dur},setpts=PTS-STARTPTS,scale=960:-2,${drawBaseline}[v0]`,
    `[1:v]trim=start=${startC}:duration=${dur},setpts=PTS-STARTPTS,scale=960:-2,${drawCandidate}[v1]`,
    '[v0][v1]vstack=inputs=2[vout]',
  ].join(';');

  const run = async (bin, fc) => execFileAsync(bin, [
    '-hide_banner', '-loglevel', 'error',
    '-i', baselinePath,
    '-i', candidatePath,
    '-filter_complex', fc,
    '-map', '[vout]',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-y', outPath,
  ], { timeout: 120000 });

  try {
    await run(filterFfmpegPath(), fcLabeled);
  } catch (_) {
    await run(ffmpegPath(), fcPlain);
  }
}

function buildMarkdownReport(report) {
  const lines = [
    '# Soup stitch QA report',
    '',
    `- Job: \`${report.jobId || '—'}\``,
    `- Baseline: \`${report.baseline}\``,
    `- Candidate: \`${report.candidate}\``,
    `- Review clip length: **${report.windowSec * 2}s** each (${report.windowSec}s before + after join)`,
    report.dualTimeline ? `- **Dual timeline**: baseline @ r35 hard-cut marks, candidate @ r38 xfade-adjusted marks` : '',
    '',
    '## FFprobe — technical metadata',
    '',
    '| | Baseline | Candidate |',
    '|---|----------|-----------|',
    `| Duration | ${report.baselineProbe?.durationSec}s | ${report.candidateProbe?.durationSec}s |`,
    `| Resolution | ${report.baselineProbe?.video?.width}×${report.baselineProbe?.video?.height} | ${report.candidateProbe?.video?.width}×${report.candidateProbe?.video?.height} |`,
    `| FPS | ${report.baselineProbe?.video?.fps} | ${report.candidateProbe?.video?.fps} |`,
    `| Video codec | ${report.baselineProbe?.video?.codec} | ${report.candidateProbe?.video?.codec} |`,
    `| Audio | ${report.baselineProbe?.audio?.codec} @ ${report.baselineProbe?.audio?.sampleRate}Hz ${report.baselineProbe?.audio?.channels}ch | ${report.candidateProbe?.audio?.codec} @ ${report.candidateProbe?.audio?.sampleRate}Hz ${report.candidateProbe?.audio?.channels}ch |`,
    `| Bitrate | ${report.baselineProbe?.bitrateKbps} kbps | ${report.candidateProbe?.bitrateKbps} kbps |`,
    '',
    '## Decode integrity (full-file FFmpeg decode)',
    '',
    `- Baseline: ${report.baselineIntegrity?.ok ? '✅ OK' : '❌ ' + (report.baselineIntegrity?.errors || []).join('; ')}`,
    `- Candidate: ${report.candidateIntegrity?.ok ? '✅ OK' : '❌ ' + (report.candidateIntegrity?.errors || []).join('; ')}`,
    '',
    '## Overlap objective metrics (first shared timeline)',
    '',
    `- Overlap trimmed to **${report.overlapMetrics?.overlapSec}s** (shorter of both files)`,
    `- Mean VMAF: ${report.overlapMetrics?.vmafMean ?? '— (skipped — use per-boundary)'} / 100`,
    `- Mean SSIM: ${report.overlapMetrics?.ssimMean ?? '—'} (1.0 = identical pixels)`,
    `- Mean PSNR: ${report.overlapMetrics?.psnrMeanDb ?? '—'} dB`,
    `- Logs: \`${report.overlapMetrics?.vmafLog || '—'}\`, \`${report.overlapMetrics?.ssimLog || '—'}\`, \`${report.overlapMetrics?.psnrLog || '—'}\``,
    `- ${report.overlapMetrics?.note || ''}`,
    '',
    `- Duration delta: **${report.durationDeltaSec >= 0 ? '+' : ''}${report.durationDeltaSec}s** (xfade adds ~0.22s per join; credits/bookends may differ)`,
    `- Boundaries reviewed: ${report.boundaries.length}`,
    `- Flagged hard-cut (candidate): ${report.flagged.length}`,
    '',
    '## Flagged joins (review stacked clips + audio/ first)',
  ];
  if (!report.flagged.length) {
    lines.push('- None — candidate looks smoother or similar at all sampled joins.');
  } else {
    for (const b of report.flagged) {
      lines.push(`- **${b.timestamp}** ${b.fromLabel} → ${b.toLabel} — jump ${b.candidate.jumpScore} (baseline ${b.baseline.jumpScore})${b.clipPath ? ` → \`${path.basename(b.clipPath)}\`` : ''}`);
    }
  }
  lines.push('', '## All boundaries', '');
  lines.push('| # | Base time | Cand time | Join | Scene spikes | VMAF | SSIM | PSNR | Base jump | Cand jump | Δ | Clip |');
  lines.push('|---|-----------|-----------|------|--------------|------|------|------|-----------|-----------|---|------|');
  for (const b of report.boundaries) {
    const candTs = b.candidateTimestamp || b.timestamp;
    lines.push(`| ${b.index} | ${b.timestamp} | ${candTs} | ${b.fromFeature}→${b.toFeature} | ${b.candidateScene?.sceneSpikesNearJoin ?? '—'} | ${b.windowVmaf ?? '—'} | ${b.windowSsim ?? '—'} | ${b.windowPsnrDb ?? '—'} | ${b.baseline.jumpScore ?? '—'} | ${b.candidate.jumpScore ?? '—'} | ${b.jumpDelta ?? '—'} | ${b.clipPath ? path.basename(b.clipPath) : '—'} |`);
  }
  lines.push('', '## Audio sync spot-check', '');
  lines.push('PCM WAV pairs exported to `audio/` — open baseline + candidate in Audacity, align on waveform peaks at each join.');
  lines.push('', '## Stitch method note', '');
  lines.push('- Long-form Soup uses **xfade + acrossfade** in `concatMediaWithTransition()` (~0.22s), not concat demuxer `-c copy`.');
  lines.push('- Concat demuxer requires identical width/height/timebase/FPS across all segments; xfade re-encodes joins intentionally.');
  return lines.join('\n');
}

async function compareSoupBoundaries(opts, repoRoot = path.join(__dirname, '..')) {
  if (!opts.baseline || !opts.candidate) {
    throw new Error('Required: --baseline <mp4> --candidate <mp4>');
  }
  const baselinePath = path.resolve(opts.baseline);
  const candidatePath = path.resolve(opts.candidate);
  if (!fs.existsSync(baselinePath)) throw new Error(`Baseline not found: ${baselinePath}`);
  if (!fs.existsSync(candidatePath)) throw new Error(`Candidate not found: ${candidatePath}`);

  const rundown = loadRundown(opts, repoRoot);
  let boundaries;
  let dualTimeline = false;
  let candidateRundown = null;

  if (opts.dualTimeline && opts.candidateAsmId) {
    candidateRundown = await loadCandidateRundownFromAsm(opts.jobId, opts.candidateAsmId, repoRoot);
    boundaries = boundariesFromDualRundown(rundown, candidateRundown, {
      allBoundaries: opts.allBoundaries,
      xfadeSec: opts.xfadeSec,
    });
    dualTimeline = true;
  } else {
    boundaries = boundariesFromRundown(rundown, { allBoundaries: opts.allBoundaries });
  }
  const priority = boundaries.filter((b) => b.priority);
  if (priority.length) boundaries = priority;
  if (opts.maxClips > 0) boundaries = boundaries.slice(0, opts.maxClips);
  if (!boundaries.length) throw new Error('No boundaries extracted from rundown');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(
    opts.outDir || path.join(repoRoot, 'logs', `boundary_compare_${opts.jobId || 'manual'}_${stamp}`)
  );
  const clipsDir = path.join(outDir, 'clips');
  const audioDir = path.join(outDir, 'audio');
  const statsDir = path.join(outDir, 'stats');
  const tmpDir = path.join(outDir, '_tmp');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const [baselineProbe, candidateProbe, baselineIntegrity, candidateIntegrity] = await Promise.all([
    probeMediaSpecs(baselinePath),
    probeMediaSpecs(candidatePath),
    probeMp4DecodeIntegrity(baselinePath),
    probeMp4DecodeIntegrity(candidatePath),
  ]);

  const baselineDurationSec = baselineProbe.durationSec || await probeDurationSec(baselinePath);
  const candidateDurationSec = candidateProbe.durationSec || await probeDurationSec(candidatePath);
  const overlapSec = Math.min(baselineDurationSec, candidateDurationSec);
  const overlapMetrics = await measureOverlapVideoMetrics(baselinePath, candidatePath, overlapSec, statsDir);
  const maxBoundarySec = Math.min(baselineDurationSec, candidateDurationSec) - 0.25;
  boundaries = boundaries.filter((b) => b.atSec <= maxBoundarySec && (b.candidateAtSec ?? b.atSec) <= maxBoundarySec);
  if (!boundaries.length) throw new Error('No boundaries within both video durations');

  const results = [];
  for (const b of boundaries) {
    const slug = safeSlug(`${b.fromLabel}_to_${b.toLabel}`);
    const clipName = `${String(b.index).padStart(3, '0')}_${b.timestamp.replace(':', '-')}_${slug}.mp4`;
    const clipPath = path.join(clipsDir, clipName);
    const tag = `b${b.index}`;

    let baseJump = { ssimNear: null, jumpScore: null, likelyHardCut: false, error: null };
    let candJump = { ssimNear: null, jumpScore: null, likelyHardCut: false, error: null };
    let candidateScene = null;
    const candAtRaw = b.candidateAtSec ?? b.atSec;
    let candAt = candAtRaw;
    try {
      const refined = await refineJoinTimestamp(candidatePath, candAtRaw, 1.5, tmpDir);
      if (refined.jumpScore != null && refined.jumpScore < 0.2) {
        candAt = refined.atSec;
        b.candidateAtSecRefined = refined.atSec;
        b.candidateJumpRefined = refined.jumpScore;
      }
    } catch (_) { /* optional */ }
    let windowVmaf = null;
    let windowSsim = null;
    let windowPsnrDb = null;
    try {
      baseJump = await boundaryJumpScore(baselinePath, b.atSec, tmpDir, `${tag}_base`);
    } catch (err) {
      baseJump.error = err.message;
    }
    try {
      candJump = await boundaryJumpScore(candidatePath, candAt, tmpDir, `${tag}_cand`);
    } catch (err) {
      candJump.error = err.message;
    }
    try {
      candidateScene = await measureJoinSceneSpike(candidatePath, candAt, opts.windowSec, tmpDir, `${tag}_sc`);
    } catch (_) { /* optional */ }
    try {
      const wq = await measureWindowPairQuality(
        baselinePath, candidatePath, b.atSec, candAt, opts.windowSec, tmpDir, statsDir, tag
      );
      windowVmaf = wq.windowVmaf;
      windowSsim = wq.windowSsim;
      windowPsnrDb = wq.windowPsnrDb;
    } catch (_) { /* optional */ }

    try {
      await extractBoundaryAudioWav(baselinePath, b.atSec, opts.windowSec, path.join(audioDir, `${String(b.index).padStart(3, '0')}_${b.timestamp.replace(':', '-')}_baseline.wav`));
      await extractBoundaryAudioWav(candidatePath, candAt, opts.windowSec, path.join(audioDir, `${String(b.index).padStart(3, '0')}_${(b.candidateTimestamp || b.timestamp).replace(':', '-')}_candidate.wav`));
    } catch (_) { /* optional */ }

    try {
      await buildSideBySideClip(baselinePath, candidatePath, b.atSec, candAt, opts.windowSec, clipPath);
    } catch (err) {
      b.clipError = err.message;
    }

    const jumpDelta = (baseJump.jumpScore != null && candJump.jumpScore != null)
      ? Math.round((candJump.jumpScore - baseJump.jumpScore) * 1000) / 1000
      : null;

    results.push({
      ...b,
      baseline: baseJump,
      candidate: candJump,
      candidateScene,
      windowVmaf,
      windowSsim,
      windowPsnrDb,
      jumpDelta,
      smoother: jumpDelta != null && jumpDelta < -0.05,
      stillHardCut: !!(candJump.likelyHardCut || candidateScene?.likelyHardCut),
      clipPath: fs.existsSync(clipPath) ? clipPath : null,
    });
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  const flagged = results.filter((r) => r.stillHardCut);
  const report = {
    generatedAt: new Date().toISOString(),
    jobId: opts.jobId || rundown.jobId || null,
    asmId: rundown.asmId || null,
    baseline: baselinePath,
    candidate: candidatePath,
    windowSec: opts.windowSec,
    dualTimeline,
    candidateAsmId: opts.candidateAsmId || null,
    xfadeSec: opts.xfadeSec,
    candidateRundownEntries: candidateRundown?.entries?.length || null,
    baselineProbe,
    candidateProbe,
    baselineIntegrity,
    candidateIntegrity,
    overlapMetrics,
    baselineDurationSec: Math.round(baselineDurationSec * 10) / 10,
    candidateDurationSec: Math.round(candidateDurationSec * 10) / 10,
    durationDeltaSec: Math.round((candidateDurationSec - baselineDurationSec) * 10) / 10,
    boundaries: results,
    flagged,
    outDir,
  };

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), buildMarkdownReport(report));

  return report;
}

function printHelp() {
  console.log(`Usage: node scripts/compare_soup_boundary_cuts.js \\
  --baseline output/old_master.mp4 \\
  --candidate output/new_r38.mp4 \\
  --job-id script_twitch_1782513992551 \\
  [--rundown output/asm_*_post_rundown.json] \\
  [--candidate-asm-id asm_script_twitch_*_r38] \\
  [--out-dir logs/my_compare] \\
  [--window 2.0] [--all-boundaries] [--max-clips 40]

When --candidate-asm-id is set, uses dual timeline: baseline joins at hard-cut
rundown marks, candidate joins at xfade-adjusted marks from probed tmp segments.

Extracts side-by-side review clips at each Soup segment join (from post-assembly rundown).
Each clip is ~2× --window seconds (default 4s: 2s before join + 2s after) — long enough to see 0.22s xfade.
Skips cold_open→INTRO (intentional hard cut) and joins where either segment is < 2.5s.

Measurements (FFmpeg-native, no manual viewing):
  ffprobe     — resolution, FPS, codecs, bitrate, A/V stream specs
  decode      — full-file integrity (DTS / corrupt input)
  overlap     — SSIM + PSNR on shared timeline (stats/overlap_*.txt)
  boundaries  — VMAF + SSIM + PSNR per join window, scene spikes, review clips
  audio/      — PCM WAV pairs for Audacity sync spot-check

Ad-hoc full-file metrics:
  node scripts/measure_stitch_quality.js --reference baseline.mp4 --distorted candidate.mp4

Outputs:
  logs/boundary_compare_<job>_<ts>/
    report.json, report.md
    clips/    — stacked BASELINE / CANDIDATE MP4s (~4s default)
    audio/    — baseline + candidate WAV per join
    stats/    — overlap + per-boundary VMAF/SSIM/PSNR logs`);
}

module.exports = {
  parseArgs,
  boundariesFromRundown,
  boundariesFromDualRundown,
  recalcTimelineWithXfade,
  loadCandidateRundownFromAsm,
  loadRundownFromJob,
  compareSoupBoundaries,
  boundaryJumpScore,
  probeMediaSpecs,
  measureOverlapVideoMetrics,
  refineJoinTimestamp,
  formatTs,
  PRIORITY_FEATURES,
};

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  compareSoupBoundaries(opts)
    .then((report) => {
      console.log(`\n✅ Boundary compare complete → ${report.outDir}`);
      console.log(`   Duration: ${report.baselineDurationSec}s → ${report.candidateDurationSec}s (${report.durationDeltaSec >= 0 ? '+' : ''}${report.durationDeltaSec}s)`);
      console.log(`   Boundaries: ${report.boundaries.length} | Flagged hard-cut: ${report.flagged.length}`);
      if (report.flagged.length) {
        console.log('\n   Review first:');
        for (const f of report.flagged.slice(0, 8)) {
          console.log(`   • ${f.timestamp} ${f.fromLabel} → ${f.toLabel} (${path.basename(f.clipPath || '')})`);
        }
      }
      console.log(`\n   Open report: ${path.join(report.outDir, 'report.md')}`);
    })
    .catch((err) => {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    });
}
