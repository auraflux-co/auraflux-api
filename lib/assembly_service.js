'use strict';
/**
 * assembly_service.js — C1 API minimal assembly service
 *
 * Produces an assembled video from source clip URLs for C1 API jobs.
 * This is the bridge between Portal 1 (script QA) and Portal 3a (assembly QA).
 *
 * Pipeline position (C1 API):
 *   Portal 0 → script_gen_service → Portal 1 → assembly_service → Portal 3a → ...
 *
 * Current capability (MVP): concat-only assembly — downloads source clips and
 * stitches them with FFmpeg without TTS narration. Produces a review-quality
 * output that Portal 3a can QA. TTS narration overlay is a follow-up task (CPD-240).
 *
 * Sets on jobSpec (mutates in place):
 *   - assembledPath:     local tmp file path (portal3a reads this)
 *   - assembledVideoUrl: R2 public URL (portal4 / staging-assets reads this)
 *   - outputPath:        alias for assembledPath
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execFile } = require('child_process');
const axios    = require('axios');
const { ffmpegPath, ffprobePath }  = require('./ffmpeg_utils');
const { uploadToR2 }  = require('./storage');
const { logError }    = require('./error_logger');
// CPD-480: Central FFmpeg encoding presets and filter helpers.
const { buildFilterComplex, buildFilterChain, AFORMAT_48K, KEYFRAME_WEB, AVOID_NEG_TS, LOUDNORM_R128, PROFILE_HIGH_41 } = require('./ffmpeg_builder');
const { recordSourceSegments, recordSourceUrl, initManifest } = require('./services/processing_manifest');

const TMP_DIR = os.tmpdir();

// CPD-479: Assembly semaphore — one assembleForJob at a time on 512 MB Render instance.
let _assemblySemaphoreHeld = false;
const _assemblySemaphoreQueue = [];

function _withAssemblySemaphore(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _assemblySemaphoreHeld = true;
      fn().then(resolve, reject).finally(() => {
        _assemblySemaphoreHeld = false;
        const next = _assemblySemaphoreQueue.shift();
        if (next) next();
      });
    };
    if (_assemblySemaphoreHeld) {
      console.log(`[assembly_service] semaphore: queuing job (${_assemblySemaphoreQueue.length + 1} waiting)`);
      _assemblySemaphoreQueue.push(run);
    } else {
      run();
    }
  });
}

/**
 * Assemble source clips for a C1 job into a single video.
 *
 * @param {object} jobSpec - mutated in place with assembledPath, assembledVideoUrl, outputPath
 * @returns {Promise<{ assembledPath: string, assembledVideoUrl: string }>}
 */
async function assembleForJob(jobSpec) {
  const jobId = jobSpec.jobId || `asm_${Date.now()}`;

  // ── Step 1: Gather source paths (URL-based or WAN gen local files) ────────
  const wanLocalPaths = _extractWanLocalPaths(jobSpec);
  if (wanLocalPaths.length) {
    // WAN gen path: files are already on disk — skip download, re-encode WebP → MP4
    console.log(`[assembly_service] ${jobId}: assembling ${wanLocalPaths.length} WAN gen clip(s) from local disk`);
    const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
    await _encodeWanToMp4(wanLocalPaths, outputPath);

    let assembledVideoUrl;
    try {
      const fileName = `assembled_${jobId}.mp4`;
      assembledVideoUrl = await uploadToR2(outputPath, fileName, { folder: `outputs/${jobId}` });
    } catch (uploadErr) {
      console.warn(`[assembly_service] ${jobId}: R2 upload failed (will use local path): ${uploadErr.message}`);
      assembledVideoUrl = null;
    }

    jobSpec.assembledPath     = outputPath;
    jobSpec.outputPath        = outputPath;
    jobSpec.assembledVideoUrl = assembledVideoUrl || `file://${outputPath}`;
    if (!jobSpec.state) jobSpec.state = {};
    if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
    if (assembledVideoUrl) jobSpec.state.savedOutputs.r2VideoUrl = assembledVideoUrl;
    jobSpec.state.savedOutputs.assembledPath = outputPath;
    if (assembledVideoUrl) jobSpec.state.savedOutputs.cleanVideoUrl = assembledVideoUrl;
    // CPD-486: Track output file size for encode_bitrate grader check (TikTok 287MB limit).
    try { jobSpec.state.savedOutputs.outputSizeBytes = require('fs').statSync(outputPath).size; } catch (_e) {}

    console.log(`[assembly_service] ${jobId}: WAN assembled → ${outputPath} (${_fileSizeMb(outputPath).toFixed(1)} MB)`);
    return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
  }

  // ── CPD-278: Customer clip spec — honour customer-defined timestamps and order ─
  const clipSpec = jobSpec.clipSpec;
  if (clipSpec?.mode === 'extract' && Array.isArray(clipSpec.clips) && clipSpec.clips.length) {
    return await _assembleExtractClipSpec(jobId, jobSpec, clipSpec);
  }
  if (clipSpec?.mode === 'compact' && Array.isArray(clipSpec.clips) && clipSpec.clips.length) {
    return await _assembleCompactClipSpec(jobId, jobSpec, clipSpec);
  }

  // CPD-528: upload-entry — customer-uploaded file already on disk, skip download entirely.
  const uploadLocalPaths = _extractUploadLocalPaths(jobSpec);
  if (uploadLocalPaths.length) {
    console.log(`[assembly_service] ${jobId}: upload-entry — using ${uploadLocalPaths.length} local file(s) from disk`);
    const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
    if (uploadLocalPaths.length === 1 && uploadLocalPaths[0].match(/\.mp4$/i)) {
      // Single MP4 upload — copy directly; no re-encode needed.
      require('fs').copyFileSync(uploadLocalPaths[0], outputPath);
    } else {
      await _concatClips(uploadLocalPaths, outputPath);
    }
    let assembledVideoUrl;
    try {
      assembledVideoUrl = await uploadToR2(outputPath, `assembled_${jobId}.mp4`, { folder: `outputs/${jobId}` });
    } catch (_e) {
      console.warn(`[assembly_service] ${jobId}: R2 upload failed for upload-entry (non-fatal): ${_e.message}`);
      assembledVideoUrl = null;
    }
    jobSpec.assembledPath     = outputPath;
    jobSpec.outputPath        = outputPath;
    jobSpec.assembledVideoUrl = assembledVideoUrl || `file://${outputPath}`;
    if (!jobSpec.state) jobSpec.state = {};
    if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
    if (assembledVideoUrl) jobSpec.state.savedOutputs.r2VideoUrl = assembledVideoUrl;
    jobSpec.state.savedOutputs.assembledPath = outputPath;
    if (assembledVideoUrl) jobSpec.state.savedOutputs.cleanVideoUrl = assembledVideoUrl;
    try { jobSpec.state.savedOutputs.outputSizeBytes = require('fs').statSync(outputPath).size; } catch (_e) {}
    console.log(`[assembly_service] ${jobId}: upload-entry assembled → ${outputPath}`);
    return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
  }

  const urls = _extractSourceUrls(jobSpec);
  if (!urls.length) throw new Error('[assembly_service] No source URLs to assemble');

  console.log(`[assembly_service] ${jobId}: assembling ${urls.length} clip(s)`);

  // ── Step 2: Download each clip to tmp ────────────────────────────────────
  const localPaths = await _downloadClips(jobId, urls);

  // CPD-270: For multi-clip COMPACT jobs, save individual clip durations so the
  // TTS mixing step can align per-story TTS sections to their corresponding clips.
  // CPD-419: Also store segmentDurations for YouTube chapter markers (portal5 consumes this).
  // Probe durations here before the clips are deleted after assembly.
  const _orderItems = jobSpec.order?.inputs?.items || [];
  const clipDurs = [];
  for (const lp of localPaths) {
    const d = await _getVideoDuration(lp).catch(() => null);
    clipDurs.push(d || 0);
  }
  if (localPaths.length > 1) {
    jobSpec.clipDurations = clipDurs;
    console.log(`[assembly_service] ${jobId}: clip durations → [${clipDurs.map((d) => d.toFixed(1) + 's').join(', ')}]`);
  }
  // Segment labels: use streamer/title from order items if available, otherwise generic labels.
  const _segmentDurations = clipDurs.map((dur, idx) => {
    const item = _orderItems[idx] || {};
    const label = item.title || item.streamer || item.label || `Segment ${idx + 1}`;
    return { label, durationSeconds: Math.round(dur) };
  });
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
  jobSpec.state.savedOutputs.segmentDurations = _segmentDurations;

  // Write clip segment timestamps to processingManifest for QA / chapter generation
  try {
    initManifest(jobSpec);
    const sourceUrls = _orderItems.map((it) => it.url || it.localPath || it.r2Url).filter(Boolean);
    // Record each source URL
    for (let i = 0; i < sourceUrls.length; i++) {
      recordSourceUrl(jobSpec, sourceUrls[i], clipDurs[i] || null);
    }
    // Record segment cut points
    let outputCursor = 0;
    const segments = clipDurs.map((dur, idx) => {
      const item  = _orderItems[idx] || {};
      const seg = {
        sourceUrl:       sourceUrls[idx] || item.url || null,
        extractStartSec: item.startSec   ?? 0,
        extractEndSec:   (item.startSec  ?? 0) + dur,
        outputStartSec:  outputCursor,
        label:           item.title || item.streamer || `Clip ${idx + 1} of ${clipDurs.length}`,
      };
      outputCursor += dur;
      return seg;
    });
    recordSourceSegments(jobSpec, segments);
  } catch (_manifestErr) {
    // Never let manifest writes break assembly delivery
  }

  // ── Step 3: FFmpeg concat ────────────────────────────────────────────────
  const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
  // CPD-510: use xfade transitions when ordered
  const _wantsTransitions = !!(jobSpec.addOns?.effects?.transitions || jobSpec.effects?.transitions);
  if (_wantsTransitions && localPaths.length > 1) {
    const _tStyle = jobSpec.addOns?.effects?.transitionStyle || 'crossfade';
    await _concatClipsWithTransitions(localPaths, outputPath, { transitionStyle: _tStyle });
  } else {
    await _concatClips(localPaths, outputPath);
  }

  // ── Step 4: Upload assembled video to R2 ────────────────────────────────
  const fileName = `assembled_${jobId}.mp4`;
  let assembledVideoUrl;
  try {
    assembledVideoUrl = await uploadToR2(outputPath, fileName, { folder: `outputs/${jobId}` });
  } catch (uploadErr) {
    console.warn(`[assembly_service] ${jobId}: R2 upload failed (will use local path): ${uploadErr.name}: ${uploadErr.message}`);
    assembledVideoUrl = null;
  }

  // ── Step 5: Mutate jobSpec ───────────────────────────────────────────────
  jobSpec.assembledPath     = outputPath;
  jobSpec.outputPath        = outputPath;
  jobSpec.assembledVideoUrl = assembledVideoUrl || `file://${outputPath}`;

  // Write R2 URL into state.savedOutputs so portal4/5 and the API can read it
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
  if (assembledVideoUrl) jobSpec.state.savedOutputs.r2VideoUrl = assembledVideoUrl;
  jobSpec.state.savedOutputs.assembledPath = outputPath;

  // CPD-426: Persist the pre-chrome clean video URL separately so it can be
  // reused as source input for re-processing with different features — no
  // re-fetch from Twitch/YouTube needed. r2VideoUrl is overwritten later by
  // the chromed final output; cleanVideoUrl is never overwritten.
  if (assembledVideoUrl) jobSpec.state.savedOutputs.cleanVideoUrl = assembledVideoUrl;

  // Clean up downloaded clips (not the assembled output — portal3a needs it)
  for (const lp of localPaths) {
    try { if (lp !== outputPath) fs.unlinkSync(lp); } catch (_) {}
  }

  // CPD-178: Apply 9:16 vertical crop for vertical_reel / short-form social platform jobs.
  // Twitch clips are native 16:9 — scale+crop to 1080x1920 for TikTok/Instagram delivery.
  const _profile  = jobSpec.productionProfile || '';
  const _format   = jobSpec.format || jobSpec.order?.format || '';
  const _platforms = (jobSpec.platforms || jobSpec.order?.publish?.platforms || []);
  // CPD-258: youtube + format=short = YouTube Shorts → 9:16 vertical.
  // youtube_shorts is a platform alias for the same case.
  // broadcast_desk profile does not imply 16:9 when format is short for short-form platforms.
  const _needsVertical = (
    _profile === 'vertical_reel' ||
    (_format === 'short' && _platforms.some((p) => ['tiktok', 'instagram', 'youtube', 'youtube_shorts'].includes(String(p).toLowerCase())))
  );
  if (_needsVertical) {
    const croppedPath = outputPath.replace('.mp4', '_9x16.mp4');
    try {
      await _applyVerticalCrop(outputPath, croppedPath);
      fs.renameSync(croppedPath, outputPath);
      console.log(`[assembly_service] ${jobId}: 9:16 vertical crop applied`);

      // Mark portrait as applied so applyPostProcessingEffects skips blur-pad re-processing.
      if (!jobSpec.state) jobSpec.state = {};
      if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
      jobSpec.state.savedOutputs.layoutPortraitApplied = true;

      // CPD-184: Re-upload cropped file to R2 — initial upload was pre-crop (16:9).
      // The outputUrl must point to the 9:16 version for E2E QA and portal4 review.
      try {
        const croppedFileName = `assembled_${jobId}_9x16.mp4`;
        const croppedUrl = await uploadToR2(outputPath, croppedFileName, { folder: `outputs/${jobId}` });
        jobSpec.assembledVideoUrl = croppedUrl;
        jobSpec.state.savedOutputs.r2VideoUrl = croppedUrl;
        // CPD-486: Update size after crop (portrait is the final deliverable).
        try { jobSpec.state.savedOutputs.outputSizeBytes = require('fs').statSync(outputPath).size; } catch (_e) {}
        console.log(`[assembly_service] ${jobId}: cropped 9:16 video re-uploaded to R2`);
      } catch (uploadErr) {
        console.warn(`[assembly_service] ${jobId}: cropped R2 re-upload failed (using original URL) — ${uploadErr.message}`);
      }
    } catch (cropErr) {
      console.warn(`[assembly_service] ${jobId}: vertical crop failed (using original) — ${cropErr.message}`);
    }
  }

  console.log(`[assembly_service] ${jobId}: assembled → ${outputPath} (${_fileSizeMb(outputPath).toFixed(1)} MB)`);
  return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Re-encode animated PNG (APNG) or WebP file(s) from WAN generation into a single MP4.
 * FFmpeg's apng demuxer handles APNG animation natively.
 * Stream copy cannot be used — animated image formats are not compatible with the MP4 container.
 */
function _encodeWanToMp4(localPaths, outputPath) {
  return new Promise((resolve, reject) => {
    if (localPaths.length === 0) return reject(new Error('No WAN clips to encode'));

    const encodeArgs = (inputPath) => [
      '-i', inputPath,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];

    if (localPaths.length === 1) {
      execFile(ffmpegPath(), encodeArgs(localPaths[0]), { timeout: 120000 }, (err) => {
        if (err) return reject(new Error(`FFmpeg WebP→MP4 failed: ${err.message}`));
        resolve();
      });
      return;
    }

    // Multiple WAN clips: encode each to mp4 first, then concat
    const tmpMp4s = localPaths.map((_, i) => outputPath.replace(/\.mp4$/, `_part${i}.mp4`));
    const encodeAll = localPaths.map((p, i) =>
      new Promise((res, rej) =>
        execFile(ffmpegPath(), encodeArgs(p).slice(0, -2).concat(['-y', tmpMp4s[i]]),
          { timeout: 120000 }, (err) => err ? rej(new Error(`Part ${i} encode failed: ${err.message}`)) : res())
      )
    );

    Promise.all(encodeAll)
      .then(() => _concatClips(tmpMp4s, outputPath))
      .then(() => {
        for (const t of tmpMp4s) { try { fs.unlinkSync(t); } catch (_) {} }
        resolve();
      })
      .catch(reject);
  });
}

function _extractWanLocalPaths(jobSpec) {
  const items = jobSpec.order?.inputs?.items || [];
  return items
    .filter((item) => item.localPath && (item.sourceType === 'wan_gen' || item.genType))
    .map((item) => item.localPath)
    .filter((p) => {
      try { return fs.existsSync(p); } catch (_) { return false; }
    });
}

function _extractSourceUrls(jobSpec) {
  const cfgUrls = (jobSpec.sourceConfig?.urls || []).filter(Boolean);
  if (cfgUrls.length) return cfgUrls;

  const ordered = (jobSpec.orderedClipUrls || [])
    .map((c) => c.url || c.clipUrl)
    .filter(Boolean);
  if (ordered.length) return ordered;

  const itemUrls = (jobSpec.order?.inputs?.items || [])
    .map((item) => item.url || item.videoUrl || item.clipUrl)
    .filter(Boolean);
  if (itemUrls.length) return itemUrls;

  const singleUrl = jobSpec.order?.inputs?.url;
  if (singleUrl) return [singleUrl];

  return [];
}

// CPD-528: Resolve upload-entry items that have localPath but no URL.
// Called by assembleForJob before the URL-download path so uploaded files
// are processed directly from disk without an unnecessary network round-trip.
function _extractUploadLocalPaths(jobSpec) {
  const items = jobSpec.order?.inputs?.items || [];
  return items
    .filter((item) => item.localPath && !item.url && !item.videoUrl && !item.sourceType)
    .map((item) => item.localPath)
    .filter((p) => {
      try { return require('fs').existsSync(p); } catch (_) { return false; }
    });
}

// CPD-339: Detect Twitch clip page URLs that require yt-dlp for download.
// Direct CDN (nauth) URLs are blocked from Render; page URLs (clips.twitch.tv/slug,
// twitch.tv/channel/clip/slug) require yt-dlp to authenticate with Twitch's API.
function _isTwitchClipPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return (
    /^https?:\/\/clips\.twitch\.tv\/[^/]+/.test(url) ||
    /^https?:\/\/(?:www\.)?twitch\.tv\/[^/]+\/clip\//.test(url)
  );
}

// CPD-899: Detect Twitch ephemeral CDN URLs (cloudfront.net/nauth/) that may have
// expired between portal0 validation and assembly download. Route these through
// yt-dlp to re-resolve a fresh CDN URL at download time.
function _isTwitchCdnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /cloudfront\.net\/nauth\//.test(url) || /clips-media-assets2\.twitch\.tv/.test(url);
}

// CPD-869: Detect Twitch VOD page URLs (twitch.tv/videos/NNNNN).
// yt-dlp can extract the best-quality stream from a VOD broadcast page.
function _isTwitchVodUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /twitch\.tv\/videos\/\d+/.test(url);
}

// CPD-351: Detect Kick page URLs that require yt-dlp for download.
// Matches: kick.com/{channel}/clips/{id} (yt-dlp kick:clips extractor)
//          kick.com/{channel}/videos/{id} (yt-dlp kick:vod extractor)
//          kick.com/clip/{id} (legacy format — yt-dlp falls back to generic HTTP)
//          kick.com/video/{id} (legacy format)
function _isKickPageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https?:\/\/(?:www\.)?kick\.com\//.test(url) &&
    /\/(clips?|videos?|vod)\//.test(url);
}

// CPD-351: Detect YouTube watch URLs that require yt-dlp for download.
function _isYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /youtube\.com\/watch|youtu\.be\//.test(url);
}

// Extract a Twitch clip slug from any clip URL format.
// Handles: clips.twitch.tv/Slug, twitch.tv/clips/Slug, twitch.tv/channel/clip/Slug
function _extractTwitchSlug(url) {
  if (!url) return '';
  const m = url.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/clips\/|twitch\.tv\/[^/]+\/clip\/)([^?&/]+)/);
  return m ? m[1] : '';
}

// Detect and trim a frozen tail from a downloaded clip file.
// Twitch clip captures commonly end with several seconds of static last-frame
// (the capture keeps recording after the action ends). When multiple such clips
// are concatenated the frozen tails appear mid-video and trigger Portal 3a's
// freeze detector as hard fails.
//
// Strategy: run freezedetect on the raw clip. If any freeze event extends to
// within 2 s of the clip end, the clip is re-encoded (stream-copy) to cut at
// the freeze_start point. The trimmed file replaces the original in-place.
// This is non-fatal — if detection or trimming fails the original is kept.
async function _trimFrozenTail(clipPath, jobId, clipIndex) {
  const FFMPEG = ffmpegPath();
  let dur = 0;
  try { dur = await _getVideoDuration(clipPath); } catch (_) { return; }
  if (!dur || dur < 5) return; // too short to be worth scanning

  // Detect freezes with d=3s threshold
  const freezeOutput = await new Promise((resolve) => {
    const proc = require('child_process').spawn(
      FFMPEG,
      ['-i', clipPath, '-vf', 'freezedetect=n=0.003:d=3', '-f', 'null', '-'],
      { timeout: 60000 }
    );
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => resolve(stderr));
    proc.on('error', () => resolve(''));
  });

  const startMs = [...freezeOutput.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const endMs   = [...freezeOutput.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  if (!startMs.length) return;

  // Find the first freeze event whose end reaches the clip's final 2 s
  let trimAt = null;
  for (let i = 0; i < startMs.length; i++) {
    const freezeEnd = endMs[i] ?? dur;
    if (freezeEnd >= dur - 2 && startMs[i] >= 3) {
      trimAt = startMs[i];
      break;
    }
  }
  if (!trimAt) return; // no tail freeze found

  const trimmedPath = clipPath.replace(/\.mp4$/, `_notail.mp4`);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG,
        ['-i', clipPath, '-t', String(trimAt), '-c', 'copy', '-avoid_negative_ts', '1', '-y', trimmedPath],
        { timeout: 60000 },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
    fs.renameSync(trimmedPath, clipPath);
    console.log(`[assembly_service] ${jobId}: clip ${clipIndex + 1} frozen tail trimmed ${dur.toFixed(1)}s → ${trimAt.toFixed(1)}s`);
  } catch (trimErr) {
    console.warn(`[assembly_service] ${jobId}: clip ${clipIndex + 1} tail-trim failed (non-fatal) — ${trimErr.message.slice(0, 80)}`);
    try { if (fs.existsSync(trimmedPath)) fs.unlinkSync(trimmedPath); } catch (_) {}
  }
}

// CPD-967: Self-healing repair — excise frozen segments from an assembled video.
//
// Called by the Portal 3a repair intervention when hard_fail detects frozen frames
// mid-video. Runs freezedetect on the assembled output, identifies frozen segments
// that portal3a would flag (start >=3s, end <= dur-8s — same skip windows as portal3a),
// and cuts them out using FFmpeg's trim/atrim filter_complex approach.
//
// Returns the repaired output path, or null if there is nothing to cut
// (all freezes are in skip windows, or the video is already too short).
// The original file is NOT deleted; caller updates jobSpec.assembledPath.
async function repairFrozenSegmentsInAssembled(assembledPath, jobId) {
  const FFMPEG = ffmpegPath();
  const spawn  = require('child_process').spawn;

  let dur = 0;
  try { dur = await _getVideoDuration(assembledPath); } catch (_) { return null; }
  if (!dur || dur < 10) return null;

  // Scan for frozen segments
  const freezeOut = await new Promise((resolve) => {
    const proc = spawn(
      FFMPEG,
      ['-i', assembledPath, '-vf', 'freezedetect=n=0.003:d=3', '-f', 'null', '-'],
      { timeout: 120000 }
    );
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => resolve(stderr));
    proc.on('error', () => resolve(''));
  });

  const starts = [...freezeOut.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends   = [...freezeOut.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m)   => parseFloat(m[1]));
  if (!starts.length) return null;

  // Apply the same skip windows portal3a uses so we only cut what portal3a actually flags:
  // - start < 3s: intro/startup artifacts
  // - freeze_end > dur - 8s: clip-capture static tail (handled by _trimFrozenTail at source)
  const frozen = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const e = ends[i] ?? dur;
    if (s < 3) continue;
    if (e > dur - 8) continue;
    frozen.push({ s, e });
  }

  if (!frozen.length) {
    console.log(`[assembly_repair] ${jobId}: freezes detected but all are in skip windows — nothing to excise`);
    return null;
  }

  // Build keep segments by inverting the frozen list
  const keepSegments = [];
  let cursor = 0;
  for (const { s, e } of frozen) {
    if (s - cursor >= 3) keepSegments.push({ from: cursor, to: s });
    cursor = e;
  }
  if (dur - cursor >= 3) keepSegments.push({ from: cursor, to: dur });

  if (!keepSegments.length) {
    console.log(`[assembly_repair] ${jobId}: all content is within frozen segments — cannot repair`);
    return null;
  }

  const repairedPath = assembledPath.replace(/\.mp4$/, `_repaired_${Date.now()}.mp4`);
  const n = keepSegments.length;

  // Build filter_complex: trim+atrim each segment, then concat
  const filterParts = [];
  const inputLabels = [];
  keepSegments.forEach(({ from, to }, idx) => {
    filterParts.push(`[0:v]trim=start=${from}:end=${to},setpts=PTS-STARTPTS[v${idx}]`);
    filterParts.push(`[0:a]atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS[a${idx}]`);
    inputLabels.push(`[v${idx}][a${idx}]`);
  });
  filterParts.push(`${inputLabels.join('')}concat=n=${n}:v=1:a=1[outv][outa]`);
  const filterComplex = filterParts.join(';');

  try {
    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG,
        [
          '-i', assembledPath,
          '-filter_complex', filterComplex,
          '-map', '[outv]', '-map', '[outa]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          '-y', repairedPath,
        ],
        { timeout: 300000 },
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
    const removedSec = frozen.reduce((acc, { s, e }) => acc + (e - s), 0).toFixed(1);
    console.log(`[assembly_repair] ${jobId}: repaired — excised ${frozen.length} frozen segment(s) (${removedSec}s) → ${repairedPath}`);
    return repairedPath;
  } catch (err) {
    console.warn(`[assembly_repair] ${jobId}: repair failed — ${err.message.slice(0, 120)}`);
    try { if (fs.existsSync(repairedPath)) fs.unlinkSync(repairedPath); } catch (_) {}
    return null;
  }
}

// Call Twitch GQL directly (public client ID, no auth token required) to obtain a
// signed CDN URL for a clip. This is the same mechanism cwn-c0 uses and works from
// any IP including Render datacenters — the sig+token in the URL params are the auth.
async function _resolveTwitchClipGql(slug) {
  const gqlBody = [{
    operationName: 'VideoAccessToken_Clip',
    variables: { slug },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11'
      }
    }
  }];
  const resp = await axios.post('https://gql.twitch.tv/gql', gqlBody, {
    headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
    timeout: 15000
  });
  const clip = resp.data?.[0]?.data?.clip;
  if (!clip) throw new Error('Twitch GQL: clip not found in response');
  const token = clip.playbackAccessToken;
  const qualities = clip.videoQualities || [];
  if (!qualities.length) throw new Error('Twitch GQL: no video qualities returned');
  // Prefer 720p, fall back to 480p, then best available
  const best = qualities.find(q => q.quality === '720')
             || qualities.find(q => q.quality === '480')
             || qualities[0];
  return `${best.sourceURL}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`;
}

// Download a Twitch clip by resolving a fresh signed CDN URL via GQL then streaming
// directly via axios. No yt-dlp needed — the signed URL works from any IP.
async function _downloadTwitchClipDirect(jobId, url, destPath) {
  const slug = _extractTwitchSlug(url);
  if (!slug) throw new Error(`Cannot extract Twitch slug from: ${url.slice(0, 100)}`);
  console.log(`[assembly_service] ${jobId}: resolving Twitch clip via GQL (slug: ${slug})`);
  const mp4Url = await _resolveTwitchClipGql(slug);
  console.log(`[assembly_service] ${jobId}: downloading Twitch clip from signed CDN URL`);
  return _downloadFile(mp4Url, destPath);
}

async function _downloadWithYtdlp(jobId, url, destPath) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const extraArgs = [];
  const proxyUrl = process.env.YTDLP_PROXY;
  if (proxyUrl) {
    extraArgs.push('--proxy', proxyUrl);
    console.log(`[assembly_service] ${jobId}: routing yt-dlp clip download through proxy`);
  } else if (_isYouTubeUrl(url)) {
    // CPD-353: YouTube bot-detection bypass — ANDROID_VR client avoids datacenter IP blocks
    // on Render without requiring cookies or proxy. Same approach as extractVodClips.
    extraArgs.push('--extractor-args', 'youtube:player_client=ANDROID_VR,ANDROID,tv_embedded');
    console.log(`[assembly_service] ${jobId}: using ANDROID_VR client for YouTube clip download`);
  }
  console.log(`[assembly_service] ${jobId}: downloading clip via yt-dlp: ${url.slice(0, 80)}`);
  return new Promise((resolve, reject) => {
    execFile(
      ytdlp,
      [
        '--format', 'best[height<=720]/best[height<=480]/best',
        '--output', destPath,
        '--no-playlist',
        '--no-warnings',
        '--merge-output-format', 'mp4',
        ...extraArgs,
        url,
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          // CPD-446: Surface YouTube IP-block errors clearly rather than as cryptic yt-dlp fails.
          // Render datacenter IPs are blocked by YouTube bot detection. Set YTDLP_PROXY to route
          // YouTube downloads through a residential proxy, or use Twitch/Kick sources instead.
          const ytBlocked = _isYouTubeUrl(url) &&
            (stderr || err.message || '').match(/bot|sign in|confirm|429|403|unavailable|blocked/i);
          if (ytBlocked) {
            return reject(new Error(
              `[YOUTUBE_IP_BLOCKED] YouTube download failed — Render datacenter IPs are blocked by YouTube bot detection. ` +
              `Set YTDLP_PROXY env var to route through a residential proxy, or replace this job source with a Twitch/Kick clip.`
            ));
          }
          return reject(new Error(`yt-dlp clip download failed: ${err.message}`));
        }
        resolve();
      }
    );
  });
}

// CPD-869: Download the first 90 seconds of a Twitch VOD broadcast page via yt-dlp.
// Full VODs can be hours long; --download-sections caps the segment so assembly
// gets a real video with a valid duration without downloading gigabytes.
async function _downloadTwitchVodSection(jobId, url, destPath) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const extraArgs = [];
  const proxyUrl = process.env.YTDLP_PROXY;
  if (proxyUrl) extraArgs.push('--proxy', proxyUrl);
  return new Promise((resolve, reject) => {
    execFile(
      ytdlp,
      [
        '--format', 'best[height<=720]/best[height<=480]/best',
        '--download-sections', '*00:00:00-00:01:30',
        '--output', destPath,
        '--no-playlist',
        '--no-warnings',
        '--merge-output-format', 'mp4',
        ...extraArgs,
        url,
      ],
      { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`yt-dlp VOD section download failed: ${err.message.slice(0, 120)}`));
        resolve();
      }
    );
  });
}

// CPD-353: Download a Kick clip by re-fetching its CDN URL via Apify at assembly time.
// Kick page URLs (kick.com/{channel}/clips/{id}) are Cloudflare-blocked from Render's
// datacenter IPs — yt-dlp cannot extract the stream URL. Apify runs on residential
// infrastructure and returns the direct CDN URL. We then download from CDN directly,
// bypassing both Cloudflare and any yt-dlp dependency.
async function _downloadKickClip(jobId, pageUrl, destPath) {
  const match = pageUrl.match(/kick\.com\/([^/?#]+)\/clips\/([^/?#]+)/);
  if (!match) {
    console.log(`[assembly_service] ${jobId}: can't parse Kick channel/clipId from URL — falling back to yt-dlp`);
    return _downloadWithYtdlp(jobId, pageUrl, destPath);
  }
  const [, channel, clipId] = match;

  const apifyToken = process.env.APIFY_API_TOKEN;
  if (apifyToken) {
    try {
      const { fetchKickContent } = require('./clients/kick_apify');
      console.log(`[assembly_service] ${jobId}: fetching fresh Kick CDN URL via Apify for clip ${clipId} (channel: ${channel})`);
      const items = await fetchKickContent(channel, 'clip', 20);
      const clip  = items.find((item) => item.id === clipId || (item.url || '').includes(clipId));
      if (clip?.cdnUrl) {
        console.log(`[assembly_service] ${jobId}: resolved Kick CDN URL — downloading directly (no yt-dlp)`);
        return _downloadFile(clip.cdnUrl, destPath);
      }
      console.warn(`[assembly_service] ${jobId}: Apify returned ${items.length} clips but clip ${clipId} not found — falling back to yt-dlp`);
    } catch (err) {
      console.warn(`[assembly_service] ${jobId}: Apify CDN lookup failed (${err.message.slice(0, 80)}) — falling back to yt-dlp`);
    }
  }

  return _downloadWithYtdlp(jobId, pageUrl, destPath);
}

async function _downloadClips(jobId, urls) {
  const localPaths = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    // If the URL is already a local path (VOD-extracted clips), use it directly
    const localPath = url.startsWith('file://') ? url.replace(/^file:\/\//, '') : null;
    if (localPath || url.startsWith('/tmp/') || url.startsWith('/var/')) {
      const resolvedPath = localPath || url;
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`[assembly_service] Local clip not found: ${resolvedPath}`);
      }
      localPaths.push(resolvedPath);
      console.log(`[assembly_service] Using local clip ${i + 1}/${urls.length}: ${resolvedPath}`);
      continue;
    }
    const tmpPath = path.join(TMP_DIR, `clip_${jobId}_${i}.mp4`);
    try {
      if (_isTwitchCdnUrl(url)) {
        // CPD-899: Legacy stored CDN URL (cloudfront.net/nauth/). Try direct download;
        // if expired/403, extract the slug from the token param and re-resolve via GQL.
        console.log(`[assembly_service] ${jobId}: Twitch CDN URL — attempting direct download, GQL fallback on failure`);
        try {
          await _downloadFile(url, tmpPath);
        } catch (_cdnErr) {
          console.warn(`[assembly_service] ${jobId}: CDN download failed (${_cdnErr.message.slice(0, 60)}) — re-resolving via GQL`);
          await _downloadTwitchClipDirect(jobId, url, tmpPath);
        }
      } else if (_isTwitchClipPageUrl(url)) {
        // Use direct GQL → signed CDN URL download. No yt-dlp, no rate-limit delays.
        await _downloadTwitchClipDirect(jobId, url, tmpPath);
      } else if (_isTwitchVodUrl(url)) {
        // CPD-869: Twitch VOD broadcast URLs (twitch.tv/videos/NNNNN) — yt-dlp with
        // --download-sections to extract just the first 90s. Full VODs are hours long;
        // for a clips job the first segment is sufficient source material.
        console.log(`[assembly_service] ${jobId}: Twitch VOD URL — downloading first 90s via yt-dlp: ${url.slice(0, 80)}`);
        let ytdlpVodErr;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            console.log(`[assembly_service] ${jobId}: yt-dlp VOD retry ${attempt}/2 after 30s for clip ${i}`);
            await new Promise((r) => setTimeout(r, 30000));
          }
          try {
            await _downloadTwitchVodSection(jobId, url, tmpPath);
            ytdlpVodErr = null;
            break;
          } catch (err) {
            ytdlpVodErr = err;
            console.log(`[assembly_service] ${jobId}: yt-dlp VOD attempt ${attempt + 1} failed: ${err.message.slice(0, 80)}`);
          }
        }
        if (ytdlpVodErr) throw ytdlpVodErr;
      } else if (_isKickPageUrl(url)) {
        // CPD-353: Kick page URLs — re-fetch CDN URL via Apify at assembly time.
        // yt-dlp is Cloudflare-blocked from Render's datacenter IPs for kick.com.
        // Apify runs on residential infra and returns the direct CDN video URL.
        await _downloadKickClip(jobId, url, tmpPath);
      } else if (_isYouTubeUrl(url)) {
        // YouTube watch URLs require yt-dlp. _downloadWithYtdlp uses ANDROID_VR client
        // as a bot-detection bypass when no proxy is configured.
        console.log(`[assembly_service] ${jobId}: YouTube URL — downloading via yt-dlp (ANDROID_VR): ${url.slice(0, 80)}`);
        await _downloadWithYtdlp(jobId, url, tmpPath);
      } else if (url.includes('.m3u8')) {
        // CPD-350: HLS playlist URLs — yt-dlp handles natively and muxes to mp4.
        console.log(`[assembly_service] ${jobId}: HLS stream detected — downloading via yt-dlp: ${url.slice(0, 80)}`);
        await _downloadWithYtdlp(jobId, url, tmpPath);
      } else {
        await _downloadFile(url, tmpPath);
      }
      // CPD-245: Validate downloaded clip has non-zero duration.
      // 360p Twitch CDN clips may download without HTTP error but produce 0-duration files.
      const clipDur = await _getVideoDuration(tmpPath).catch(() => 0);
      if (!clipDur || clipDur < 0.5) {
        logError('ASSEMBLY_DOWNLOAD_INVALID', new Error(`0-duration clip`), { jobId, url, index: i });
        throw new Error(`[assembly_service] Downloaded clip ${i} has invalid duration (${clipDur}s): ${url.slice(0, 80)}`);
      }
      // Trim frozen tails before concat — Twitch clip captures often end with several
      // seconds of static last-frame after the action ends. When assembled these tails
      // appear mid-video and hard-fail Portal 3a's freeze detector.
      await _trimFrozenTail(tmpPath, jobId, i).catch((e) =>
        console.warn(`[assembly_service] ${jobId}: _trimFrozenTail threw (non-fatal) — ${e.message.slice(0, 80)}`)
      );
      localPaths.push(tmpPath);
      console.log(`[assembly_service] Downloaded clip ${i + 1}/${urls.length} (${clipDur.toFixed(1)}s): ${url.slice(0, 80)}`);
    } catch (err) {
      logError('ASSEMBLY_DOWNLOAD_FAILED', err, { jobId, url, index: i });
      throw new Error(`[assembly_service] Failed to download clip ${i}: ${err.message}`);
    }
  }
  return localPaths;
}

function _downloadFile(url, destPath, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    // Hard wall-clock timeout — guards against stalled HTTP streams
    const timer = setTimeout(() => {
      finish(new Error(`Download timed out after ${timeoutMs / 1000}s: ${url.slice(0, 80)}`));
    }, timeoutMs);

    axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5 })
      .then((response) => {
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        writer.on('finish', () => finish(null));
        writer.on('error', finish);
        response.data.on('error', finish);
      })
      .catch(finish);
  });
}

function _concatClips(localPaths, outputPath) {
  return new Promise((resolve, reject) => {
    if (localPaths.length === 0) return reject(new Error('No clips to concat'));

    // Single clip: stream copy (remux only) — no re-encode, near-instant, no CPU/RAM overhead.
    if (localPaths.length === 1) {
      const args = [
        '-i', localPaths[0],
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', outputPath,
      ];
      execFile(ffmpegPath(), args, { timeout: 60000 }, (err) => {
        if (err) return reject(new Error(`FFmpeg remux failed: ${err.message}`));
        resolve();
      });
      return;
    }

    // CPD-232: Use the FFmpeg concat FILTER (not the concat demuxer) for multi-clip assembly.
    //
    // Root cause history:
    // - CPD-229: concat demuxer -c:a copy drops audio from clips with different sample rates.
    // - CPD-230: concat demuxer -c:v copy produces undecodable video when H264 params differ.
    // - CPD-231: concat demuxer with scale filter still fails — the demuxer initialises its
    //   stream parameters from the first clip and cannot re-initialise when subsequent clips
    //   have different resolutions (e.g. 1920×1080 followed by 640×360). FFmpeg stops
    //   encoding at the transition boundary with exit code 0 (no error raised), so the
    //   fallback path is never triggered. Result: assembled file = clip 1 only (26s of 71s).
    //
    // Fix: load each clip as a separate input and use the filter_complex concat filter.
    // The concat filter normalises each clip independently before concatenating so
    // different resolutions, frame rates, sample rates, and codec parameters are all handled.
    // scale+setsar normalises resolution; aformat normalises audio; then concat joins N clips.

    // CPD-234: Use 720p for filter_complex concat to avoid encode timeout on Render.
    // 1080p CRF22 for 4 clips (161s) took ~34min — 3.4x over the 600s execFile timeout.
    // Twitch source clips are already compressed; 720p preserves quality adequately.
    const CONCAT_W = 1280;
    const CONCAT_H = 720;

    const inputs = localPaths.flatMap((p) => ['-i', p]);

    // CPD-262: fps=30 normalises frame rate before scale so clips with mixed fps
    // (e.g. 1080p@60fps + 360p@30fps) don't cause the concat filter to fail or
    // fall back to the concat demuxer (which silently produces only clip 1).
    //
    // CPD-484: setpts=PTS-STARTPTS resets each clip's PTS to start at 0 before
    // the concat filter. Clips from different sources (HLS VOD segments, local
    // files, yt-dlp downloads) often have non-zero starting PTS — the concat
    // filter assumes each input stream starts at 0, so mismatched PTS causes
    // A/V drift and discontinuities at segment boundaries.
    // asetpts=PTS-STARTPTS does the same for audio.
    const vFilters = localPaths.map((_, i) =>
      `[${i}:v]fps=30,setpts=PTS-STARTPTS,scale=${CONCAT_W}:${CONCAT_H}:force_original_aspect_ratio=decrease,` +
      `pad=${CONCAT_W}:${CONCAT_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v${i}]`
    );
    const aFilters = localPaths.map((_, i) =>
      `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
    );
    const concatInputRefs = localPaths.map((_, i) => `[v${i}][a${i}]`).join('');
    const concatFilter = `${concatInputRefs}concat=n=${localPaths.length}:v=1:a=1[vout][aout]`;

    const filterComplex = [...vFilters, ...aFilters, concatFilter].join('; ');

    const primaryArgs = [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-threads', '2',
      // CPD-484: avoid_negative_ts make_zero — shifts mux timeline so the
      // earliest PTS is 0. HLS/concat inputs can produce negative PTS values
      // that cause MP4 muxer reordering or drift.
      ...AVOID_NEG_TS,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];

    // CPD-225: Audio normalization after multi-clip concat.
    // CPD-484: Replace dynaudnorm with loudnorm (EBU R128 -16 LUFS).
    // dynaudnorm is a frame-level dynamic compressor — it smooths clip-to-clip
    // volume jumps but can introduce pumping artefacts and over-compress quiet clips.
    // loudnorm applies a linear gain to hit -16 LUFS integrated (YouTube's target is
    // -14 LUFS; -16 gives a small headroom buffer) with a -1.5 dBTP true peak limit
    // to prevent clipping during AAC encoding. This is the broadcast/streaming standard
    // (Netflix, YouTube, Spotify all use EBU R128 variants).
    // Video stream is copied (fast, already normalised by libx264 in concat step).
    function _applyAudioNorm(concatPath, cb) {
      const normPath = concatPath.replace(/\.mp4$/, '_audnorm.mp4');
      const normArgs = [
        '-i', concatPath,
        '-c:v', 'copy',
        '-af', LOUDNORM_R128,
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', normPath,
      ];
      execFile(ffmpegPath(), normArgs, { timeout: 180000 }, (normErr) => {
        if (normErr) {
          console.warn(`[assembly_service] audio normalize failed (using raw concat): ${normErr.message.slice(0, 80)}`);
          return cb();
        }
        try { fs.renameSync(normPath, concatPath); } catch (_) {}
        cb();
      });
    }

    execFile(ffmpegPath(), primaryArgs, { timeout: 900000 }, (err) => {
      if (!err) {
        return _applyAudioNorm(outputPath, resolve);
      }
      // filter_complex concat failed — fall back to 720p concat demuxer re-encode
      const listPath = outputPath.replace(/\.mp4$/, '_list.txt');
      const listContent = localPaths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
      fs.writeFileSync(listPath, listContent);
      console.warn(`[assembly_service] filter_complex concat failed (${err.message.slice(0, 80)}), falling back to 720p demuxer re-encode`);
      const fallbackArgs = [
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        '-threads', '2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
        // CPD-484: loudnorm replaces dynaudnorm on fallback path too.
        '-af', LOUDNORM_R128,
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outputPath,
      ];
      execFile(ffmpegPath(), fallbackArgs, { timeout: 900000 }, (err2) => {
        try { fs.unlinkSync(listPath); } catch (_) {}
        if (err2) return reject(new Error(`FFmpeg concat failed: ${err2.message}`));
        resolve();
      });
    });
  });
}

/**
 * CPD-510: Concat clips with xfade crossfade transitions between each cut.
 * Requires: all clips normalised to same resolution before concat.
 * Falls back to regular _concatClips on any error.
 */
async function _concatClipsWithTransitions(localPaths, outputPath, opts = {}) {
  if (localPaths.length <= 1) {
    return _concatClips(localPaths, outputPath);
  }

  const TRANS_DUR   = 0.5; // seconds per transition
  const XFADE_MAP   = { crossfade: 'fade', fade_black: 'fadeblack', wipe_left: 'wipeleft', dissolve: 'dissolve' };
  const transition  = XFADE_MAP[opts.transitionStyle] || 'fade';

  // Probe durations — needed to compute xfade offsets
  let clipDurs;
  try {
    clipDurs = await Promise.all(localPaths.map((p) => _getVideoDuration(p).catch(() => 0)));
  } catch (_) {
    return _concatClips(localPaths, outputPath);
  }

  const CONCAT_W = 1280;
  const CONCAT_H = 720;

  const inputs = localPaths.flatMap((p) => ['-i', p]);

  // Per-clip normalization filters
  const vFilters = localPaths.map((_, i) =>
    `[${i}:v]fps=30,setpts=PTS-STARTPTS,scale=${CONCAT_W}:${CONCAT_H}:force_original_aspect_ratio=decrease,` +
    `pad=${CONCAT_W}:${CONCAT_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[nv${i}]`
  );
  const aFilters = localPaths.map((_, i) =>
    `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[na${i}]`
  );

  // Chain xfade/acrossfade between each adjacent pair
  const xFilters  = [];
  const xaFilters = [];
  let vRef = 'nv0';
  let aRef = 'na0';
  let cumDur = clipDurs[0];

  for (let i = 1; i < localPaths.length; i++) {
    const offset  = Math.max(0, cumDur - TRANS_DUR);
    const nextVRef = i < localPaths.length - 1 ? `xv${i}` : 'vout';
    const nextARef = i < localPaths.length - 1 ? `xa${i}` : 'aout';
    xFilters.push(
      `[${vRef}][nv${i}]xfade=transition=${transition}:duration=${TRANS_DUR}:offset=${offset.toFixed(3)}[${nextVRef}]`
    );
    xaFilters.push(
      `[${aRef}][na${i}]acrossfade=d=${TRANS_DUR}[${nextARef}]`
    );
    vRef = nextVRef;
    aRef = nextARef;
    cumDur += clipDurs[i] - TRANS_DUR;
  }

  const filterComplex = [...vFilters, ...aFilters, ...xFilters, ...xaFilters].join('; ');

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      [
        ...inputs,
        '-filter_complex', filterComplex,
        '-map', '[vout]', '-map', '[aout]',
        '-threads', '2',
        ...AVOID_NEG_TS,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outputPath,
      ],
      { timeout: 900000 },
      (err) => {
        if (err) {
          console.warn(`[assembly_service] xfade transitions failed, falling back to plain concat: ${err.message.slice(0, 120)}`);
          return _concatClips(localPaths, outputPath).then(resolve).catch(reject);
        }
        resolve();
      },
    );
  });
}

function _fileSizeMb(filePath) {
  try { return fs.statSync(filePath).size / 1024 / 1024; } catch (_) { return 0; }
}

/**
 * CPD-178: Scale a 16:9 video to 9:16 (1080x1920) via center crop.
 * Standard approach for Twitch → TikTok/Instagram short-form delivery.
 */
function _applyVerticalCrop(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      [
        '-i', inputPath,
        // CPD-472: cap to 720x1280 — 1080x1920 OOM-kills Render 512MB starter tier.
        '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
        '-threads', '2',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', outputPath,
      ],
      { timeout: 300000 },
      (err) => {
        if (err) return reject(new Error(`Vertical crop failed: ${err.message}`));
        resolve();
      },
    );
  });
}

/**
 * CPD-185 / CPD-214: Burn broadcast chrome overlay onto a video using FFmpeg drawtext.
 *
 * Broadcast chrome package (per-format):
 *   - Top bar: dark background + show name centred
 *   - Top accent line: indigo brand colour strip (8px)
 *   - Lower-third: semi-transparent dark bar in bottom 25% + show name + "via AuraFlux" label
 *   - Bottom accent bar: thick brand colour strip (10px)
 *   - AuraFlux corner mark: bottom-right watermark
 *
 * Gemini QA checks for: lower-thirds, colour bar, show name. All three are now present.
 *
 * @param {string} inputPath   - source video path
 * @param {string} outputPath  - destination path
 * @param {object} [opts]
 * @param {string} [opts.showName]    - show name displayed in chrome (default: 'AuraFlux')
 * @param {string} [opts.streamerName] - optional streamer/creator label in lower-third
 * @param {boolean} [opts.isVertical] - true for 9:16 (1080×1920) layout
 * @returns {Promise<void>}
 */
async function _applyChrome(inputPath, outputPath, opts = {}) {
  // CPD-480: Probe color info before encoding so we can apply bt709 tags safely.
  // Only tag SDR sources — HDR/10-bit sources must NOT receive bt709 tags.
  const _colorInfo = await _probeColorInfo(inputPath).catch(() => ({ isHDR: false }));
  const _colorArgs = _colorInfo.isHDR
    ? [] // HDR: no color tag override (deferred to future tonemap ticket)
    : ['-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709'];

  // CPD-481: Dynamic timeout — 4× video duration, minimum 10 min.
  const _durationSecs    = opts.durationSecs || 0;
  const _encodeTimeoutMs = Math.max(600000, _durationSecs * 4000);

  // CPD-482: Write show name and streamer label to temp text files so drawtext
  // uses textfile= instead of text=. This handles any Unicode/special characters
  // (apostrophes, accents, colons) in streamer names without FFmpeg filter
  // expression escaping. text= strips or breaks on these characters.
  const _showTxtPath  = inputPath.replace('.mp4', '_chrome_show.txt');
  const _labelTxtPath = inputPath.replace('.mp4', '_chrome_label.txt');

  return new Promise((resolve, reject) => {
    const rawName    = (opts.showName    || 'AuraFlux').slice(0, 40);
    const streamer   = (opts.streamerName || '').slice(0, 30);
    const isVertical = opts.isVertical || false;
    // CPD-479: when true, blur-pad portrait reframe is merged into this single pass
    const needsPortraitReframe = opts.needsPortraitReframe || false;

    // CPD-227: Resolve font
    const fontFile = [
      require('path').join(__dirname, '../assets/fonts/BarlowCondensed-SemiBold.ttf'),
      require('path').join(__dirname, '../assets/fonts/BarlowCondensed-Regular.ttf'),
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ].find((f) => { try { return require('fs').existsSync(f); } catch { return false; } }) || '';
    const fontAttr = fontFile ? `:fontfile=${fontFile}` : '';

    // CPD-509: customer brand logo overrides the committed asset.
    // opts.brandLogoPath is set by pipeline_assembly.js when brand.image_url is available.
    const BRAND_LOGO_PATH = require('path').join(__dirname, '../assets/brand_logo.png');
    const logoPath = opts.brandLogoPath && require('fs').existsSync(opts.brandLogoPath)
      ? opts.brandLogoPath
      : (require('fs').existsSync(BRAND_LOGO_PATH) ? BRAND_LOGO_PATH : null);

    // Layout constants
    const topBarH         = isVertical ? 88  : 60;
    const topAccentH      = isVertical ? 8   : 6;
    const topFontSize     = isVertical ? 40  : 30;
    const ltBarH          = isVertical ? 120 : 80;
    const ltBarY          = `h-${ltBarH + 10}`;
    const ltShowFontSize  = isVertical ? 44  : 32;
    const ltLabelFontSize = isVertical ? 28  : 20;
    const ltLabelY        = isVertical ? `h-${ltBarH + 10 - 68}` : `h-${ltBarH + 10 - 48}`;
    const ltShowY         = isVertical ? `h-${ltBarH + 10 - 14}` : `h-${ltBarH + 10 - 10}`;
    const bottomAccentH   = 10;
    const logoW           = isVertical ? 54 : 42;
    const logoOverlayY    = isVertical ? `H-${ltBarH + 10 + 44}` : `H-${ltBarH + 10 + 34}`;
    const logoTextSize    = isVertical ? 28 : 22;
    const logoTextY       = isVertical ? `h-${ltBarH + 10 + 44}` : `h-${ltBarH + 10 + 34}`;

    const labelText = streamer ? `${streamer} \u00b7 via AuraFlux` : 'via AuraFlux';

    // Write text to temp files — drawtext textfile= handles any Unicode/special chars
    try { require('fs').writeFileSync(_showTxtPath, rawName, 'utf8'); } catch (_) {}
    try { require('fs').writeFileSync(_labelTxtPath, labelText, 'utf8'); } catch (_) {}

    // Chrome drawbox/drawtext filters applied to a named stream
    // textfile= is used for user-supplied text (streamer names, show names) to
    // avoid FFmpeg filter expression escaping issues with apostrophes, accents, colons.
    const baseFilters = [
      `drawbox=x=0:y=0:w=iw:h=${topBarH}:color=0x0f172a@0.95:t=fill`,
      `drawbox=x=0:y=${topBarH}:w=iw:h=${topAccentH}:color=0x6366f1@1.0:t=fill`,
      `drawtext=textfile='${_showTxtPath}':fontsize=${topFontSize}:fontcolor=white:x=(w-text_w)/2:y=(${topBarH}-text_h)/2${fontAttr}`,
      `drawbox=x=0:y=${ltBarY}:w=iw:h=${ltBarH}:color=0x0f172a@0.88:t=fill`,
      `drawbox=x=0:y=${ltBarY}:w=12:h=${ltBarH}:color=0x6366f1@1.0:t=fill`,
      `drawtext=textfile='${_showTxtPath}':fontsize=${ltShowFontSize}:fontcolor=white:x=28:y=${ltShowY}${fontAttr}`,
      `drawtext=textfile='${_labelTxtPath}':fontsize=${ltLabelFontSize}:fontcolor=0xc7d2fe@0.9:x=28:y=${ltLabelY}${fontAttr}`,
      `drawbox=x=0:y=h-${bottomAccentH}:w=iw:h=${bottomAccentH}:color=0x6366f1@0.95:t=fill`,
    ].join(',');

    // CPD-479: Build filter_complex.
    // Portrait jobs (needsPortraitReframe=true): blur-pad 16:9->9:16 + chrome in one pass.
    // Landscape jobs: scale-to-max-720p (OOM guard, CPD-472) + chrome.
    let execArgs;
    if (needsPortraitReframe) {
      const portraitSteps = [
        '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=20[bg]',
        '[0:v]scale=720:-2:force_original_aspect_ratio=decrease[fg]',
        '[bg][fg]overlay=(W-w)/2:(H-h)/2[reframed]',
      ].join(';');
      let fc;
      if (logoPath) {
        fc = [
          portraitSteps,
          `[reframed]${baseFilters}[base]`,
          `[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.85[logo]`,
          `[base][logo]overlay=x=W-w-20:y=${logoOverlayY}[vout]`,
        ].join(';');
        execArgs = ['-i', inputPath, '-i', logoPath, '-filter_complex', fc, '-map', '[vout]', '-map', '0:a?'];
      } else {
        const ftxt = `drawtext=text='AuraFlux':fontsize=${logoTextSize}:fontcolor=white@0.75:x=w-text_w-20:y=${logoTextY}${fontAttr}`;
        fc = [portraitSteps, `[reframed]${baseFilters},${ftxt}[vout]`].join(';');
        execArgs = ['-i', inputPath, '-filter_complex', fc, '-map', '[vout]', '-map', '0:a?'];
      }
    } else if (logoPath) {
      // Landscape + logo: scale to max 720p (CPD-472 OOM guard), then chrome + logo overlay
      const fc = [
        `[0:v]scale=-2:min(ih\\,720)[scaled]`,
        `[scaled]${baseFilters}[base]`,
        `[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.85[logo]`,
        `[base][logo]overlay=x=W-w-20:y=${logoOverlayY}[vout]`,
      ].join(';');
      execArgs = ['-i', inputPath, '-i', logoPath, '-filter_complex', fc, '-map', '[vout]', '-map', '0:a?'];
    } else {
      // Landscape fallback: no logo, simple -vf chain
      const vf = `scale=-2:min(ih\\,720),${baseFilters},drawtext=text='AuraFlux':fontsize=${logoTextSize}:fontcolor=white@0.75:x=w-text_w-20:y=${logoTextY}${fontAttr}`;
      execArgs = ['-i', inputPath, '-vf', vf];
    }

    execFile(
      ffmpegPath(),
      [
        ...execArgs,
        '-threads', '2',
        ..._colorArgs,
        // CPD-482: medium preset (better compression than veryfast; safe with dynamic timeout).
        // KEYFRAME_WEB: forces a keyframe every 2s so YouTube/TikTok players can seek accurately.
        // CPD-484: PROFILE_HIGH_41 (High @ Level 4.1) for maximum mobile/social compatibility.
        // High profile enables B-frames + CABAC (better compression); Level 4.1 covers
        // 1080p30 and 720p60 which is the ceiling for most phones and smart TVs.
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p',
        ...PROFILE_HIGH_41,
        ...KEYFRAME_WEB,
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', outputPath,
      ],
      { timeout: _encodeTimeoutMs },
      (err) => {
        // Clean up drawtext temp text files (CPD-482)
        try { require('fs').unlinkSync(_showTxtPath); } catch (_) {}
        try { require('fs').unlinkSync(_labelTxtPath); } catch (_) {}
        if (err) return reject(new Error(`Chrome overlay failed: ${err.message}`));
        resolve();
      },
    );
  }); // end inner Promise
}

/**
 * CPD-179: Mix an ElevenLabs TTS narration track into an already-assembled video.
 * Ducks original audio to 12%, narration boosted to 2×, mixed to full duration.
 * Returns the output path (overwrites the input via tmp rename) or null on failure.
 *
 * @param {string} videoPath   - path to assembled video
 * @param {string} audioPath   - path to TTS mp3
 * @param {string} [jobId]     - for logging
 * @returns {Promise<string|null>}
 */
/**
 * CPD-219: Get video duration in seconds via ffprobe.
 * Returns null on error (non-fatal).
 */
async function _getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath().replace(/ffmpeg$/, 'ffprobe'),
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const d = parseFloat((stdout || '').trim());
        resolve(isNaN(d) ? null : d);
      }
    );
  });
}

/**
 * CPD-480: Probe video color metadata via ffprobe.
 * Returns { isHDR, colorTransfer, colorPrimaries, colorSpace, pixFmt }.
 * Used to gate bt709 color space tag application — safe only on SDR sources.
 * iPhone Dolby Vision / HDR10 clips have color_transfer=smpte2084/arib-std-b67
 * and must NOT receive bt709 tags (would break color display on all platforms).
 */
async function _probeColorInfo(videoPath) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'quiet', '-select_streams', 'v:0',
       '-show_entries', 'stream=color_transfer,color_primaries,color_space,pix_fmt',
       '-of', 'json', videoPath],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return resolve({ isHDR: false, colorTransfer: 'unknown', colorPrimaries: 'unknown', colorSpace: 'unknown', pixFmt: 'yuv420p' });
        try {
          const data   = JSON.parse(stdout || '{}');
          const stream = (data.streams || [])[0] || {};
          const ct = stream.color_transfer  || 'unknown';
          const cp = stream.color_primaries || 'unknown';
          const cs = stream.color_space     || 'unknown';
          const pf = stream.pix_fmt         || 'unknown';
          // HDR: PQ (smpte2084), HLG (arib-std-b67), bt2020 variants, or any 10-bit pixel format
          const HDR_TRANSFERS = new Set([
            'smpte2084', 'arib-std-b67', 'arib_std_b67',
            'bt2020-10', 'bt2020-12', 'bt2020_10', 'bt2020_12',
            'smpte428', 'smpte2094-40',
          ]);
          const is10bit = /10le|10be|p010|p016|yuv420p10|yuv422p10|yuv444p10/.test(pf);
          const isHDR = HDR_TRANSFERS.has(ct) || is10bit;
          resolve({ isHDR, colorTransfer: ct, colorPrimaries: cp, colorSpace: cs, pixFmt: pf });
        } catch (_) {
          resolve({ isHDR: false, colorTransfer: 'unknown', colorPrimaries: 'unknown', colorSpace: 'unknown', pixFmt: 'yuv420p' });
        }
      }
    );
  });
}

/**
 * CPD-252: Get video STREAM duration (not container duration) via ffprobe.
 * When multi-clip concat produces a video with truncated audio (e.g. clip audio
 * drops at transition), the container format=duration reports the audio track
 * duration (32s) even though the video stream is 161s. We need the video stream
 * duration to correctly pad the audio before TTS mixing.
 * Returns null on error (falls back to _getVideoDuration).
 */
async function _getVideoStreamDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath().replace(/ffmpeg$/, 'ffprobe'),
      ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', videoPath],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const d = parseFloat((stdout || '').trim());
        resolve(isNaN(d) ? null : d);
      }
    );
  });
}

async function mixTtsIntoVideo(videoPath, audioPath, jobId = 'unknown') {
  if (!videoPath || !audioPath) return null;
  if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
    console.warn(`[assembly_service] ${jobId}: TTS mix skipped — file(s) missing`);
    return null;
  }

  // CPD-219: Trim TTS audio to video duration so it cannot overflow and cut off mid-sentence.
  // A 39s clip with a 50s TTS script would previously be cut at 39s, splitting a sentence.
  // We leave a 1s tail (silence) so the last word has a natural end before video cuts.
  //
  // CPD-252: Use the VIDEO STREAM duration (not the container/format duration) because for
  // multi-clip COMPACT concat jobs the audio track may be shorter than the video stream
  // (e.g. 32s audio vs 161s video when a clip's audio drops at a transition boundary).
  // The container format=duration then reports the shorter audio duration, causing TTS to be
  // trimmed to 32s and amix=duration=shortest to cut the mixed output at 32s. Checking the
  // video stream duration first ensures TTS covers the full video.
  const videoStreamDur = await _getVideoStreamDuration(videoPath);
  const containerDur   = await _getVideoDuration(videoPath);
  const videoDur       = (videoStreamDur && videoStreamDur > (containerDur || 0))
    ? videoStreamDur
    : (containerDur || null);

  let effectiveAudioPath = audioPath;
  if (videoDur && videoDur > 2) {
    const trimDur = Math.max(videoDur - 1, 1);
    const trimmedAudio = audioPath.replace(/\.mp3$/, '_trimmed.mp3');
    try {
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath(),
          ['-i', audioPath, '-t', String(trimDur), '-c:a', 'copy', '-y', trimmedAudio],
          { timeout: 30000 },
          (err) => err ? reject(err) : resolve()
        );
      });
      effectiveAudioPath = trimmedAudio;
      console.log(`[assembly_service] ${jobId}: TTS trimmed to ${trimDur.toFixed(1)}s (video=${videoDur.toFixed(1)}s videoStream=${(videoStreamDur||'?')}s container=${(containerDur||'?')}s)`);
    } catch (trimErr) {
      console.warn(`[assembly_service] ${jobId}: TTS trim failed (using full audio): ${trimErr.message}`);
    }
  }

  // CPD-252: Pad video audio track to at least `videoDur` seconds before mixing.
  // When a multi-clip concat produces a shortened audio track (e.g. 32s for a 161s video),
  // amix=duration=shortest would cut the entire output at 32s, silencing TTS and truncating
  // the visual output. apad=pad_dur ensures the video's own audio stream is padded to the
  // full video stream duration before mixing, so duration=shortest uses the padded duration.
  // CPD-261: +7s buffer (up from +2) to prevent TTS cutting off at the very end
  // when videoDur is slightly underestimated relative to the actual stream.
  const audioPadSecs = videoDur ? Math.ceil(videoDur) + 7 : 300;

  const mixedPath = videoPath.replace('.mp4', '_tts_mixed.mp4');
  await new Promise((resolve, reject) => {
    // CPD-484: Replace fixed volume=0.12 duck with sidechaincompress.
    // Fixed 12% is too aggressive — source audio becomes inaudible. Sidechain
    // compressor ducks game audio dynamically only when TTS is actually speaking,
    // and releases naturally during TTS pauses. This sounds like broadcast mixing.
    //
    // Filter graph:
    //   [0:a] game audio → apad to full duration → main input of compressor
    //   [1:a] TTS → asplit:
    //         [sc]  → sidechain trigger for the compressor
    //         [tts] → apad to full duration → mix input
    //   [gamepad][sc] sidechaincompress → [ducked] (game ducks when TTS speaks)
    //   [ducked][ttspad] amix at 1:2.2 weights → [aout]
    //
    // threshold=0.05: compressor kicks in at low TTS signal (quiet narration still ducks)
    // ratio=4: gentle 4:1 reduction (game audio stays ~25% under TTS, not silent)
    // attack=10ms: fast response when TTS starts speaking
    // release=300ms: natural fade-back when TTS pauses (no pumping artefacts)
    // level_sc=0.7: scale sidechain input slightly to tune sensitivity
    const scFilter = [
      `[0:a]apad=pad_dur=${audioPadSecs}[gamepad]`,
      `[1:a]asplit=2[sc][tts]`,
      `[tts]apad=pad_dur=${audioPadSecs}[ttspad]`,
      `[gamepad][sc]sidechaincompress=threshold=0.05:ratio=4:attack=10:release=300:level_sc=0.7[ducked]`,
      `[ducked][ttspad]amix=inputs=2:duration=shortest:dropout_transition=2:weights=1 2.2[aout]`,
    ].join(';');

    execFile(
      ffmpegPath(),
      [
        '-i', videoPath,
        '-i', effectiveAudioPath,
        '-filter_complex', scFilter,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y', mixedPath,
      ],
      { timeout: 300000 },
      (err) => {
        if (err) return reject(new Error(`TTS mix failed: ${err.message}`));
        resolve();
      },
    );
  });

  // Cleanup trimmed file if it was created
  if (effectiveAudioPath !== audioPath) {
    try { fs.unlinkSync(effectiveAudioPath); } catch (_) {}
  }

  try { fs.renameSync(mixedPath, videoPath); } catch (_) {}
  console.log(`[assembly_service] ${jobId}: TTS narration mixed (sidechaincompress duck, narr 2.2×)`);
  return videoPath;
}

/**
 * CPD-181: EXTRACT flow — download a Twitch VOD via yt-dlp and split into N short clips
 * using ffmpeg scene-change detection + fixed-duration windowing.
 *
 * @param {string} vodUrl   - Twitch VOD page URL (twitch.tv/videos/ID)
 * @param {object} opts
 * @param {number} opts.clipCount    - number of clips to extract (default 3)
 * @param {number} opts.maxClipSecs  - max seconds per extracted clip (default 60)
 * @param {string} opts.jobId        - for logging / tmp file naming
 * @returns {Promise<string[]>}      - array of local MP4 paths for extracted clips
 */
async function extractVodClips(vodUrl, opts = {}) {
  // CPD-246: accept optional vodClipTimestamps — [{start_s, end_s, title}] from Twitch Helix
  // popular clips API. When provided, extract from those moments instead of evenly-spaced cuts.
  const { clipCount = 3, maxClipSecs = 60, jobId = `vod_${Date.now()}`, isVertical = false,
          vodClipTimestamps = null } = opts;
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';

  // CPD-186: Use yt-dlp --get-url to resolve the HLS/MP4 stream URL without downloading
  // the full VOD. Then use ffmpeg -ss seek to extract specific clips directly from the
  // stream URL. This avoids downloading a potentially multi-GB file on Render.
  console.log(`[assembly_service] ${jobId}: resolving VOD stream URL from ${vodUrl}`);

  const streamUrl = await new Promise((resolve, reject) => {
    // CPD-200: Use a simpler, more robust format selector for Twitch VODs (HLS-based).
    // Twitch serves HLS streams — `bestvideo[ext=mp4]` selects DASH which often fails
    // with --get-url. Using `best[height<=720]/best[height<=480]/best` selects the
    // native HLS mux which yt-dlp resolves correctly.
    //
    // CPD-290: Render datacenter IPs are on YouTube's bot-detection blocklist.
    //
    // Scaling strategy (preferred → fallback):
    //   1. YTDLP_PROXY — residential proxy URL (e.g. http://user:pass@host:port).
    //      Residential IPs are never blocked. Cost is negligible: yt-dlp --get-url
    //      only fetches ~a few KB of metadata, NOT the actual video. ffmpeg streams
    //      the video directly from YouTube/Twitch CDN without the proxy.
    //      This is the correct multi-tenant solution.
    //
    //   2. YOUTUBE_COOKIES_BASE64 — fallback for single-tenant / testing.
    //      A Netscape cookie file from a logged-in browser, base64-encoded.
    //      Does NOT scale: one account's auth for all users, cookies expire ~2 weeks,
    //      high volume triggers account suspension. Use only during development.
    //
    //   3. ANDROID_VR client — last-resort fallback, may work on some IPs.
    const isYouTube = /youtube\.com|youtu\.be/.test(vodUrl);
    let cookieFilePath = null;
    const extraArgs = [];

    // Priority 1: residential proxy (works for all platforms, scales to N users)
    const proxyUrl = process.env.YTDLP_PROXY;
    if (proxyUrl) {
      extraArgs.push('--proxy', proxyUrl);
      console.log(`[assembly_service] ${jobId}: routing yt-dlp URL resolution through proxy`);
    } else if (isYouTube) {
      // Priority 2: cookie auth (YouTube only, single-tenant stopgap)
      const cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
      if (cookiesB64) {
        cookieFilePath = path.join(TMP_DIR, `yt_cookies_${jobId}.txt`);
        fs.writeFileSync(cookieFilePath, Buffer.from(cookiesB64, 'base64').toString('utf8'));
        extraArgs.push('--cookies', cookieFilePath);
        console.log(`[assembly_service] ${jobId}: using YOUTUBE_COOKIES_BASE64 for auth`);
      } else {
        // Priority 3: ANDROID_VR client — last resort, may work on some IPs
        extraArgs.push('--extractor-args', 'youtube:player_client=ANDROID_VR,ANDROID,tv_embedded');
      }
    }

    execFile(
      ytdlp,
      [
        '--get-url',
        '--format', 'best[height<=720]/best[height<=480]/best',
        '--no-playlist',
        '--no-warnings',
        ...extraArgs,
        vodUrl,
      ],
      { timeout: 90000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (cookieFilePath) try { fs.unlinkSync(cookieFilePath); } catch (_) {}
        if (err) return reject(new Error(`yt-dlp URL resolve failed: ${err.message}`));
        // yt-dlp may return 2 lines for video+audio (DASH) — take the first non-empty one
        const url = (stdout || '').split('\n').find((l) => l.trim().startsWith('http'));
        if (!url) return reject(new Error('yt-dlp returned no stream URL'));
        resolve(url.trim());
      },
    );
  });

  console.log(`[assembly_service] ${jobId}: stream URL resolved (${streamUrl.slice(0, 80)}...)`);

  // Probe VOD duration directly from stream URL
  const vodDurationSecs = await new Promise((resolve) => {
    execFile(
      ffprobePath(),
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        '-timeout', '60000000', // CPD-226: 60s ffprobe timeout (was 30s — Twitch HLS playlists need more time)
        streamUrl,
      ],
      { timeout: 45000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve(0);
        resolve(parseFloat(stdout.trim()) || 0);
      },
    );
  });

  // Fall back to a default duration if probe fails (VOD duration may not be readable from HLS)
  const effectiveDuration = vodDurationSecs > 10 ? vodDurationSecs : 1200; // assume 20 min if unknown
  console.log(`[assembly_service] ${jobId}: VOD duration ${Math.round(effectiveDuration)}s`);

  // CPD-246: Use Twitch popular-clip timestamps when available — these are real highlights
  // chosen by viewers. Fall back to evenly-spaced cuts if no timestamps provided.
  let startSeconds;
  if (vodClipTimestamps && vodClipTimestamps.length >= clipCount) {
    startSeconds = vodClipTimestamps.slice(0, clipCount).map((t) => t.start_s);
    console.log(`[assembly_service] ${jobId}: using ${startSeconds.length} viewer-highlight timestamps: ${startSeconds.join(', ')}s`);
  } else {
    // Evenly-spaced fallback. CPD-226: Skip first 15% to avoid pre-stream title cards.
    // CPD-259: Increase minimum skip — pre-stream animated intros can last 15-25 min.
    // CPD-260: Major streamers (hasanabi, stableronaldo) often have 30-60min pre-show
    // animated waiting screens. Raise skip to 30% / 1800s floor, cap at 45 min.
    // Also clip usableEnd to VOD-600s to avoid end-of-stream cooldown that produces
    // degenerate segments (static image + repeated audio).
    // CPD-264: skipCap=2700s (45 min) still too low for 6h+ VODs with 60min+ intros
    // (stableronaldo). Scale cap to 40% of VOD duration, capped at 3600s (60 min).
    const skipByPercent  = Math.floor(effectiveDuration * 0.30);
    const skipMin        = Math.min(1800, Math.floor(effectiveDuration * 0.20)); // 30-min hard floor
    const skipCap        = Math.min(Math.floor(effectiveDuration * 0.40), 3600); // up to 60 min
    const usableStart = Math.min(Math.max(skipByPercent, skipMin), skipCap);
    const usableEnd   = Math.min(
      Math.floor(effectiveDuration * 0.92),
      effectiveDuration - 600, // always stop 10 min before end to skip outro/cooldown
    );
    const usableDur   = usableEnd - usableStart;
    const interval    = Math.floor(usableDur / clipCount);
    startSeconds = Array.from({ length: clipCount }, (_, i) => usableStart + i * interval);
    console.log(`[assembly_service] ${jobId}: no highlight timestamps — using evenly-spaced cuts (skip=${usableStart}s of ${effectiveDuration}s VOD)`);
  }
  const clipPaths = [];

  for (let i = 0; i < clipCount; i++) {
    const startSec = startSeconds[i];
    const clipPath = path.join(TMP_DIR, `vod_clip_${jobId}_${i}.mp4`);
    console.log(`[assembly_service] ${jobId}: extracting clip ${i + 1}/${clipCount} at ${Math.round(startSec)}s`);
    // CPD-220: 5-min timeout too short for large HLS VODs (7.5h stream = ~2700 segments,
    // playlist parse + segment seek can take 3-8 min). Raised to 15 min.
    //
    // CPD-484: reconnect/genpts flags for HLS stream resilience.
    // HLS segment servers (Twitch, Kick CDNs) can drop connections mid-transfer.
    // -reconnect 1: retry HTTP GET on connection drop
    // -reconnect_streamed 1: retry even for streaming (non-seekable) sources
    // -reconnect_on_network_error 1: retry on network errors (DNS, TCP)
    // -reconnect_delay_max 15: wait up to 15s between retries
    // -fflags +genpts: generate PTS for segments with missing timestamps
    //   (some CDN-served HLS segments have no PTS in the first few frames)
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath(),
        [
          '-fflags', '+genpts',
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_on_network_error', '1',
          '-reconnect_delay_max', '15',
          '-ss', String(startSec),
          '-i', streamUrl,
          '-t', String(maxClipSecs),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
          // CPD-201: For vertical_reel profile, extract 9:16 (1080×1920) clips directly
          // instead of 16:9. This saves a separate crop pass after extraction.
          '-vf', isVertical
            ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
            : 'scale=854:480:force_original_aspect_ratio=decrease',
          '-c:a', 'aac', '-ar', '48000', '-b:a', '96k',
          '-movflags', '+faststart',
          '-y', clipPath,
        ],
        { timeout: 900000 },
        (err) => {
          if (err) return reject(new Error(`Clip ${i} extraction failed: ${err.message}`));
          resolve();
        },
      );
    });
    if (fs.existsSync(clipPath) && _fileSizeMb(clipPath) > 0.1) {
      clipPaths.push(clipPath);
      console.log(`[assembly_service] ${jobId}: clip ${i + 1}/${clipCount} extracted (${_fileSizeMb(clipPath).toFixed(1)} MB)`);
    }
  }

  if (!clipPaths.length) throw new Error('No clips extracted from VOD');
  return clipPaths;
}

/**
 * CPD-270: Per-story TTS alignment for multi-clip COMPACT show_commentary jobs.
 *
 * For 4-clip COMPACT jobs, each STORY section may generate 50-65s of TTS narration.
 * The assembled video is 4×40s = 160s. A single TTS track of 4×55s = 220s gets trimmed
 * to 159s, cutting STORY4 entirely and leaving the final clip without voiceover.
 *
 * Fix: parse the script into per-story text blocks, calculate each story's proportional
 * share of the full TTS audio, then extract + pad/trim each share to its clip's duration.
 * The resulting time-aligned TTS track is mixed into the assembled video.
 *
 * @param {string} videoPath        - assembled (concatenated) video file path
 * @param {string} ttsPath          - full TTS audio file (covering all story sections)
 * @param {string} script           - filled script with === STORY\d+ === markers
 * @param {number[]} clipDurations  - duration of each source clip in seconds
 * @param {string} jobId            - for logging
 * @returns {Promise<string|null>}  - path of the TTS-mixed video, or null on fallback
 */
async function mixAlignedMultiClipTts(videoPath, ttsPath, script, clipDurations, jobId = 'unknown') {
  if (!videoPath || !ttsPath || !script || !clipDurations?.length) return null;
  if (!fs.existsSync(videoPath) || !fs.existsSync(ttsPath)) return null;
  if (clipDurations.length < 2) return null;

  // 1. Parse story sections from script — extract combined spoken text per story
  const storyCharCounts = _parseStoryCharCounts(script);
  if (!storyCharCounts.length || storyCharCounts.length !== clipDurations.length) {
    console.warn(`[assembly_service] ${jobId}: story count (${storyCharCounts.length}) ≠ clip count (${clipDurations.length}) — skipping aligned TTS`);
    return null;
  }

  // 2. Get full TTS audio duration
  const ttsDuration = await _getAudioDuration(ttsPath);
  if (!ttsDuration || ttsDuration < 1) return null;

  // 3. Calculate proportional TTS start/end for each story based on char count ratio
  const totalChars = storyCharCounts.reduce((s, c) => s + c, 0);
  if (totalChars === 0) return null;
  let ttsOffset = 0;
  const storyTtsSegments = storyCharCounts.map((chars) => {
    const proportion = chars / totalChars;
    const segDuration = proportion * ttsDuration;
    const seg = { start: ttsOffset, duration: segDuration };
    ttsOffset += segDuration;
    return seg;
  });

  // 4. For each story, extract its TTS segment and pad/trim to clip duration
  const alignedPaths = [];
  for (let i = 0; i < clipDurations.length; i++) {
    const clipDur = clipDurations[i];
    const { start, duration: segDur } = storyTtsSegments[i];
    const rawSegPath  = path.join(TMP_DIR, `tts_seg_raw_${jobId}_${i}.mp3`);
    const alignedPath = path.join(TMP_DIR, `tts_seg_aligned_${jobId}_${i}.mp3`);
    try {
      // Extract segment from full TTS
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath(),
          ['-ss', String(start.toFixed(3)), '-i', ttsPath, '-t', String(segDur.toFixed(3)), '-c:a', 'copy', '-y', rawSegPath],
          { timeout: 30000 },
          (err) => err ? reject(err) : resolve()
        );
      });
      // Pad or trim to clip duration
      const extractedDur = await _getAudioDuration(rawSegPath).catch(() => segDur);
      if (extractedDur < clipDur - 0.5) {
        // Pad with silence to clip duration
        await new Promise((resolve, reject) => {
          execFile(
            ffmpegPath(),
            ['-i', rawSegPath, '-af', `apad=pad_dur=${(clipDur - extractedDur + 0.5).toFixed(3)}`, '-c:a', 'libmp3lame', '-q:a', '3', '-y', alignedPath],
            { timeout: 30000 },
            (err) => err ? reject(err) : resolve()
          );
        });
      } else if (extractedDur > clipDur + 0.5) {
        // Trim to clip duration
        await new Promise((resolve, reject) => {
          execFile(
            ffmpegPath(),
            ['-i', rawSegPath, '-t', String(clipDur.toFixed(3)), '-c:a', 'copy', '-y', alignedPath],
            { timeout: 30000 },
            (err) => err ? reject(err) : resolve()
          );
        });
      } else {
        fs.copyFileSync(rawSegPath, alignedPath);
      }
      alignedPaths.push(alignedPath);
      console.log(`[assembly_service] ${jobId}: story ${i + 1} TTS aligned: ${extractedDur.toFixed(1)}s → ${clipDur.toFixed(1)}s`);
    } catch (segErr) {
      console.warn(`[assembly_service] ${jobId}: story ${i + 1} TTS segment failed (${segErr.message}) — using silence`);
      // Generate silence for this segment
      const silencePath = path.join(TMP_DIR, `tts_silence_${jobId}_${i}.mp3`);
      await _generateSilenceMp3(silencePath, clipDur);
      alignedPaths.push(silencePath);
    } finally {
      try { fs.unlinkSync(rawSegPath); } catch (_) {}
    }
  }

  // 5. Concatenate aligned segments into one time-matched TTS track
  const concatTtsPath = path.join(TMP_DIR, `tts_aligned_${jobId}.mp3`);
  try {
    await _concatAudioFiles(alignedPaths, concatTtsPath);
  } catch (concatErr) {
    console.warn(`[assembly_service] ${jobId}: aligned TTS concat failed (${concatErr.message}) — falling back`);
    for (const p of alignedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
    return null;
  }
  for (const p of alignedPaths) { try { fs.unlinkSync(p); } catch (_) {} }

  // 6. Mix the aligned TTS into the video (no trim needed — already matched to video duration)
  console.log(`[assembly_service] ${jobId}: mixing aligned multi-clip TTS (${clipDurations.length} sections)`);
  const result = await mixTtsIntoVideo(videoPath, concatTtsPath, jobId);
  try { fs.unlinkSync(concatTtsPath); } catch (_) {}
  return result;
}

/**
 * Parse filled script and return char count of spoken text per STORY section.
 * Each STORY block covers STORY\d+_INTRO, _SETUP, _SUMMARY, _REACTION (not _CLIP, which has no speech).
 * Returns an array with one entry per STORY group (in order).
 */
function _parseStoryCharCounts(script) {
  if (!script) return [];
  const storyMap = {};
  const sectionRegex = /===\s*(STORY(\d+)(?:_\w+)?)\s*===([\s\S]*?)(?====|$)/g;
  let match;
  while ((match = sectionRegex.exec(script)) !== null) {
    const storyNum = parseInt(match[2], 10);
    const sectionText = match[3] || '';
    // Extract spokenText lines (skip source_clip sections)
    const spoken = sectionText
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return t.startsWith('spokenText:') && !t.endsWith('spokenText:');
      })
      .map((line) => line.replace(/^spokenText:\s*/i, '').trim())
      .join(' ');
    storyMap[storyNum] = (storyMap[storyNum] || '') + spoken;
  }
  if (!Object.keys(storyMap).length) return [];
  const maxStory = Math.max(...Object.keys(storyMap).map(Number));
  const result = [];
  for (let i = 1; i <= maxStory; i++) {
    result.push((storyMap[i] || '').length || 50); // default 50 chars if story empty
  }
  return result;
}

function _getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath().replace(/ffmpeg$/, 'ffprobe'),
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        const d = parseFloat((stdout || '').trim());
        resolve(isNaN(d) ? null : d);
      }
    );
  });
}

function _generateSilenceMp3(outputPath, durationSecs) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`, '-t', String(durationSecs.toFixed(3)), '-c:a', 'libmp3lame', '-q:a', '3', '-y', outputPath],
      { timeout: 15000 },
      (err) => err ? reject(new Error(`Silence gen failed: ${err.message}`)) : resolve()
    );
  });
}

function _concatAudioFiles(audioPaths, outputPath) {
  return new Promise((resolve, reject) => {
    if (!audioPaths.length) return reject(new Error('No audio files to concat'));
    if (audioPaths.length === 1) {
      fs.copyFileSync(audioPaths[0], outputPath);
      return resolve();
    }
    const listPath = outputPath.replace(/\.mp3$/, '_list.txt');
    fs.writeFileSync(listPath, audioPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}' `).join('\n'));
    execFile(
      ffmpegPath(),
      ['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-q:a', '3', '-y', outputPath],
      { timeout: 60000 },
      (err) => {
        try { fs.unlinkSync(listPath); } catch (_) {}
        if (err) return reject(new Error(`Audio concat failed: ${err.message}`));
        resolve();
      }
    );
  });
}

// ── CPD-278: Customer-defined clip spec handlers ──────────────────────────────

/**
 * EXTRACT mode — customer marked exact IN/OUT timestamps on a long-form source.
 * Each clipSpec.clips[].{startTime, endTime} becomes one extracted short clip
 * which are then concatenated in clip order.
 *
 * Reuses extractVodClips with vodClipTimestamps populated from the clip spec,
 * bypassing all auto-detection / evenly-spaced logic.
 */
async function _assembleExtractClipSpec(jobId, jobSpec, clipSpec) {
  const sourceUrl = (jobSpec.fetchSpec?.sourceUrls || [])[0] ||
                    (jobSpec.uploadSpec?.fileKeys || [])[0] ||
                    jobSpec.order?.inputs?.url;
  if (!sourceUrl) throw new Error('[assembly_service] EXTRACT clipSpec: no source URL found in jobSpec');

  console.log(`[assembly_service] ${jobId}: EXTRACT mode — ${clipSpec.clips.length} customer-marked clip(s)`);

  // Store feature override metadata on jobSpec for portal QA
  jobSpec.clipSpecUniformFeatures  = clipSpec.uniformFeatures;
  jobSpec.clipSpecFeatureOverrides = clipSpec.featureOverrides || {};

  const vodTimestamps = clipSpec.clips.map((c) => ({
    start_s: c.startTime,
    end_s:   c.endTime,
    title:   c.title || `Clip at ${c.startTime}s`,
  }));

  // extractVodClips handles stream resolution + extraction; pass timestamps directly
  const extractedPaths = await extractVodClips(sourceUrl, {
    clipCount:         vodTimestamps.length,
    maxClipSecs:       Math.max(...vodTimestamps.map((t) => t.end_s - t.start_s), 60),
    jobId,
    isVertical:        (jobSpec.productionProfile === 'vertical_reel' ||
                        (jobSpec.format === 'short')),
    vodClipTimestamps: vodTimestamps,
  });

  if (!extractedPaths.length) throw new Error('[assembly_service] EXTRACT clipSpec: no clips extracted');

  // Probe clip durations for TTS alignment (CPD-270 pattern)
  if (extractedPaths.length > 1) {
    const clipDurs = [];
    for (const p of extractedPaths) {
      const d = await _getVideoDuration(p).catch(() => 0);
      clipDurs.push(d || 0);
    }
    jobSpec.clipDurations = clipDurs;
  }

  const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
  // CPD-510: use xfade transitions when ordered
  const _xWants = !!(jobSpec.addOns?.effects?.transitions || jobSpec.effects?.transitions);
  if (_xWants && extractedPaths.length > 1) {
    await _concatClipsWithTransitions(extractedPaths, outputPath, {
      transitionStyle: jobSpec.addOns?.effects?.transitionStyle || 'crossfade',
    });
  } else {
    await _concatClips(extractedPaths, outputPath);
  }
  for (const p of extractedPaths) { try { fs.unlinkSync(p); } catch (_) {} }

  return await _finaliseAssembly(jobId, jobSpec, outputPath);
}

/**
 * COMPACT mode — customer has N short clips, has defined their assembly order
 * and optional per-clip trim (trimStart / trimEnd in seconds).
 *
 * Clips are sorted by clipSpec.clips[].order, then each is downloaded and
 * trimmed with ffmpeg -ss / -t before concatenation.
 */
async function _assembleCompactClipSpec(jobId, jobSpec, clipSpec) {
  const ordered = [...clipSpec.clips].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  console.log(`[assembly_service] ${jobId}: COMPACT mode — ${ordered.length} clip(s) in customer order [${ordered.map((c) => c.order ?? 0).join(', ')}]`);

  // Store feature override metadata on jobSpec for portal QA
  jobSpec.clipSpecUniformFeatures  = clipSpec.uniformFeatures;
  jobSpec.clipSpecFeatureOverrides = clipSpec.featureOverrides || {};

  const trimmedPaths = [];
  for (let i = 0; i < ordered.length; i++) {
    const clip = ordered[i];
    const rawPath = path.join(TMP_DIR, `compact_raw_${jobId}_${i}.mp4`);
    const trimPath = path.join(TMP_DIR, `compact_trim_${jobId}_${i}.mp4`);

    // CPD-284: Detect platform watch-page URLs — use yt-dlp via extractVodClips
    // instead of direct HTTP download (watch pages are HTML, not video files).
    // Covers: Twitch VODs, Twitch clips (clips.twitch.tv or twitch.tv/clip/),
    //         Kick VODs, YouTube watch/short URLs.
    const _isPlatformUrl = /twitch\.tv\/videos\/|clips\.twitch\.tv\/|twitch\.tv\/clip\/|kick\.com\/video\/|youtube\.com\/watch|youtu\.be\//.test(clip.url);

    if (_isTwitchClipPageUrl(clip.url)) {
      // Resolve a fresh signed CDN URL via Twitch GQL and download directly via axios.
      // No yt-dlp, no rate-limit delays — GQL signed URLs work from any IP including Render.
      await _downloadTwitchClipDirect(jobId, clip.url, rawPath);
      console.log(`[assembly_service] ${jobId}: COMPACT clip ${i + 1} downloaded via GQL+CDN: ${clip.url.slice(0, 60)}`);
    } else if (_isPlatformUrl) {
      // VOD / YouTube / Kick — extract segment using timestamp range via extractVodClips.
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      const _ts = [{ start_s: clip.trimStart || 0, end_s: clip.trimEnd || (clip.trimStart || 0) + 60, title: clip.title || `clip_${i}` }];
      let _extractErr;
      let _extractedPath;
      for (let _attempt = 0; _attempt < 3; _attempt++) {
        if (_attempt > 0) {
          console.log(`[assembly_service] ${jobId}: extractVodClips retry ${_attempt}/2 after 8s backoff for COMPACT clip ${i + 1}`);
          await new Promise((r) => setTimeout(r, 8000));
        }
        try {
          const [ep] = await extractVodClips(clip.url, {
            clipCount: 1,
            maxClipSecs: clip.trimEnd ? (clip.trimEnd - (clip.trimStart || 0)) : 60,
            jobId,
            isVertical: false,
            vodClipTimestamps: _ts,
          });
          if (!ep) throw new Error(`extractVodClips returned empty for COMPACT clip ${i + 1}`);
          _extractedPath = ep;
          _extractErr = null;
          break;
        } catch (err) {
          _extractErr = err;
          console.log(`[assembly_service] ${jobId}: extractVodClips attempt ${_attempt + 1} failed for COMPACT clip ${i + 1}: ${err.message.slice(0, 80)}`);
        }
      }
      if (_extractErr) throw _extractErr;
      fs.renameSync(_extractedPath, rawPath);
      console.log(`[assembly_service] ${jobId}: COMPACT clip ${i + 1} extracted via yt-dlp from ${clip.url.slice(0, 60)}`);
    } else if (clip.url.includes('.m3u8')) {
      // CPD-350: Kick HLS clips — download via yt-dlp, same as _downloadClips path.
      console.log(`[assembly_service] ${jobId}: COMPACT clip ${i + 1} HLS detected — downloading via yt-dlp: ${clip.url.slice(0, 80)}`);
      await _downloadWithYtdlp(jobId, clip.url, rawPath);
    } else if (clip.url.startsWith('/') || clip.url.startsWith('file://')) {
      const local = clip.url.replace(/^file:\/\//, '');
      if (!fs.existsSync(local)) throw new Error(`[assembly_service] COMPACT: local clip not found: ${local}`);
      fs.copyFileSync(local, rawPath);
    } else {
      await _downloadFile(clip.url, rawPath);
    }

    const rawDur = await _getVideoDuration(rawPath).catch(() => 0);
    if (!rawDur || rawDur < 0.5) {
      throw new Error(`[assembly_service] COMPACT: invalid clip ${i} duration (${rawDur}s): ${clip.url.slice(0, 80)}`);
    }
    console.log(`[assembly_service] ${jobId}: clip ${i + 1}/${ordered.length} downloaded (${rawDur.toFixed(1)}s): ${clip.title || ''}`);

    const needsTrim = (clip.trimStart > 0) || (clip.trimEnd !== null && clip.trimEnd !== undefined);
    if (needsTrim) {
      const ss = clip.trimStart || 0;
      const duration = clip.trimEnd ? (clip.trimEnd - ss) : (rawDur - ss);
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegPath(),
          [
            // CPD-482: -ss AFTER -i for accurate seek on local MP4 files.
            // Fast seek (-ss before -i) can land up to one GOP early/late;
            // output seek decodes from the previous keyframe and discards frames
            // until the exact timestamp — frame-accurate at the cost of CPU.
            '-i', rawPath,
            '-ss', String(ss),
            '-t', String(Math.max(duration, 0.5)),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', trimPath,
          ],
          { timeout: 300000 },
          (err) => err ? reject(new Error(`Trim failed for clip ${i}: ${err.message}`)) : resolve(),
        );
      });
      try { fs.unlinkSync(rawPath); } catch (_) {}
      console.log(`[assembly_service] ${jobId}: clip ${i + 1} trimmed (${ss}s–${clip.trimEnd ?? 'end'})`);
      trimmedPaths.push(trimPath);
    } else {
      fs.renameSync(rawPath, trimPath);
      trimmedPaths.push(trimPath);
    }
  }

  // Probe clip durations for TTS alignment (CPD-270 pattern)
  if (trimmedPaths.length > 1) {
    const clipDurs = [];
    for (const p of trimmedPaths) {
      const d = await _getVideoDuration(p).catch(() => 0);
      clipDurs.push(d || 0);
    }
    jobSpec.clipDurations = clipDurs;
    console.log(`[assembly_service] ${jobId}: COMPACT clip durations → [${clipDurs.map((d) => d.toFixed(1) + 's').join(', ')}]`);
  }

  const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
  // CPD-510: use xfade transitions when ordered
  const _xWantsC = !!(jobSpec.addOns?.effects?.transitions || jobSpec.effects?.transitions);
  if (_xWantsC && trimmedPaths.length > 1) {
    await _concatClipsWithTransitions(trimmedPaths, outputPath, {
      transitionStyle: jobSpec.addOns?.effects?.transitionStyle || 'crossfade',
    });
  } else {
    await _concatClips(trimmedPaths, outputPath);
  }
  for (const p of trimmedPaths) { try { fs.unlinkSync(p); } catch (_) {} }

  return await _finaliseAssembly(jobId, jobSpec, outputPath);
}

/**
 * Shared finalise step — applies vertical crop, uploads to R2, mutates jobSpec.
 * Extracted from assembleForJob so EXTRACT and COMPACT handlers reuse it.
 */
async function _finaliseAssembly(jobId, jobSpec, outputPath) {
  let assembledVideoUrl;
  try {
    const fileName = `assembled_${jobId}.mp4`;
    assembledVideoUrl = await uploadToR2(outputPath, fileName, { folder: `outputs/${jobId}` });
  } catch (uploadErr) {
    console.warn(`[assembly_service] ${jobId}: R2 upload failed — ${uploadErr.message}`);
    assembledVideoUrl = null;
  }

  jobSpec.assembledPath     = outputPath;
  jobSpec.outputPath        = outputPath;
  jobSpec.assembledVideoUrl = assembledVideoUrl || `file://${outputPath}`;
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
  if (assembledVideoUrl) jobSpec.state.savedOutputs.r2VideoUrl = assembledVideoUrl;
  jobSpec.state.savedOutputs.assembledPath = outputPath;
  if (assembledVideoUrl) jobSpec.state.savedOutputs.cleanVideoUrl = assembledVideoUrl;

  // Apply 9:16 vertical crop if needed (same logic as main assembleForJob)
  const _profile   = jobSpec.productionProfile || '';
  const _format    = jobSpec.format || jobSpec.order?.format || '';
  const _platforms = (jobSpec.platforms || jobSpec.order?.publish?.platforms || []);
  const _needsVertical = (
    _profile === 'vertical_reel' ||
    (_format === 'short' && _platforms.some((p) => ['tiktok', 'instagram', 'youtube', 'youtube_shorts'].includes(String(p).toLowerCase())))
  );
  if (_needsVertical) {
    const croppedPath = outputPath.replace('.mp4', '_9x16.mp4');
    try {
      await _applyVerticalCrop(outputPath, croppedPath);
      fs.renameSync(croppedPath, outputPath);
      const croppedUrl = await uploadToR2(outputPath, `assembled_${jobId}_9x16.mp4`, { folder: `outputs/${jobId}` }).catch(() => null);
      if (croppedUrl) {
        jobSpec.assembledVideoUrl = croppedUrl;
        jobSpec.state.savedOutputs.r2VideoUrl = croppedUrl;
      }
      console.log(`[assembly_service] ${jobId}: 9:16 vertical crop applied (clipSpec path)`);
    } catch (cropErr) {
      console.warn(`[assembly_service] ${jobId}: vertical crop failed — ${cropErr.message}`);
    }
  }

  console.log(`[assembly_service] ${jobId}: assembled → ${outputPath} (${_fileSizeMb(outputPath).toFixed(1)} MB)`);
  return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
}

// CPD-479: Wrap assembleForJob with semaphore so at most one heavy assembly
// runs concurrently on the 512 MB Render instance.
const _assembleForJobRaw = assembleForJob;
async function assembleForJobQueued(jobSpec) {
  return _withAssemblySemaphore(() => _assembleForJobRaw(jobSpec));
}

// ── CPD-405: Compilation Carousel assembly ────────────────────────────────────

const MAX_CAROUSEL_CLIPS = 10;

/**
 * Run FFmpeg carousel assembly for compilation_carousel jobs.
 * Supports three modes:
 *   hstack       — two 9:16 clips scaled and merged side-by-side into a single video
 *   concat       — clips joined end-to-end (copy if same resolution/fps, re-encode otherwise)
 *   image_frames — extract frames every N seconds as JPEG, zipped with a manifest
 *
 * Mutates jobSpec:  assembledPath, outputPath, assembledVideoUrl,
 *                   state.savedOutputs.r2VideoUrl, state.carousel (mode, frameCount, zipPath)
 *
 * @param {object} jobSpec
 * @returns {object} { assembledPath, assembledVideoUrl }
 */
async function assembleCarousel(jobSpec) {
  const jobId = jobSpec.jobId || `carousel_${Date.now()}`;
  const mode  = jobSpec.carouselMode || 'concat';
  const logErr = (...a) => { try { require('./utils/logger').logError(...a); } catch { /* non-fatal */ } };

  // ── Step 1: Resolve source URLs ──────────────────────────────────────────
  const urls = _extractSourceUrls(jobSpec);
  if (!urls.length) throw new Error(`[carousel:${jobId}] No source URLs found in jobSpec`);
  if (urls.length > MAX_CAROUSEL_CLIPS) {
    throw new Error(`[carousel:${jobId}] Too many clips (${urls.length} > ${MAX_CAROUSEL_CLIPS}) — reduce source count`);
  }

  console.log(`[carousel:${jobId}] mode=${mode}, clips=${urls.length}`);

  // ── Step 2: Download clips ───────────────────────────────────────────────
  const localPaths = await _downloadClips(jobId, urls);

  // ── Step 3: FFmpeg assembly based on mode ────────────────────────────────
  let outputPath;
  let carouselMeta = { mode, clipCount: localPaths.length };

  if (mode === 'hstack') {
    if (localPaths.length < 2) throw new Error(`[carousel:${jobId}] hstack requires at least 2 clips`);
    outputPath = path.join(TMP_DIR, `carousel_${jobId}.mp4`);
    const [a, b] = localPaths;
    const ffArgs = [
      '-y',
      '-i', a, '-i', b,
      '-filter_complex',
      '[0:v]scale=1080:1920,setsar=1[v0];[1:v]scale=1080:1920,setsar=1[v1];' +
      '[v0][v1]hstack=inputs=2[v];[0:a][1:a]amix=inputs=2[a]',
      '-map', '[v]', '-map', '[a]',
      '-ac', '2', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
      '-c:a', 'aac', '-b:a', '128k',
      outputPath,
    ];
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath(), ffArgs, { timeout: 300_000 }, (err) => err ? reject(err) : resolve());
    });
    carouselMeta.layout = 'side_by_side';

  } else if (mode === 'image_frames') {
    const archiver   = (() => { try { return require('archiver'); } catch { return null; } })();
    if (!archiver) throw new Error(`[carousel:${jobId}] archiver package not available — run npm install archiver`);
    const frameDir = path.join(TMP_DIR, `carousel_frames_${jobId}`);
    fs.mkdirSync(frameDir, { recursive: true });

    const frameIntervalSecs = Number(jobSpec.carouselFrameInterval) || 5;
    const frameManifest = [];

    for (let i = 0; i < localPaths.length; i++) {
      const clipFramePattern = path.join(frameDir, `clip${i}_frame_%d.jpg`);
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath(), [
          '-y', '-i', localPaths[i],
          '-vf', `fps=1/${frameIntervalSecs}`,
          clipFramePattern,
        ], { timeout: 120_000 }, (err) => err ? reject(err) : resolve());
      });
      const clipFrames = fs.readdirSync(frameDir)
        .filter((f) => f.startsWith(`clip${i}_frame_`) && f.endsWith('.jpg'))
        .sort()
        .map((f) => path.join(frameDir, f));
      clipFrames.forEach((fp, fi) => {
        frameManifest.push({ clip: i, frame: fi, path: fp, filename: path.basename(fp) });
      });
    }

    const manifestPath = path.join(frameDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ jobId, mode: 'image_frames', frames: frameManifest }, null, 2));
    frameManifest.push({ clip: -1, frame: -1, path: manifestPath, filename: 'manifest.json' });

    const zipPath = path.join(TMP_DIR, `carousel_${jobId}.zip`);
    await new Promise((resolve, reject) => {
      const output  = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const item of frameManifest) {
        archive.file(item.path, { name: item.filename });
      }
      archive.finalize();
    });

    outputPath = zipPath;
    carouselMeta.frameCount   = frameManifest.filter((f) => f.clip >= 0).length;
    carouselMeta.frameInterval = frameIntervalSecs;
    carouselMeta.zipPath      = zipPath;
    console.log(`[carousel:${jobId}] image_frames: ${carouselMeta.frameCount} frames → ${zipPath}`);

  } else {
    // concat (default)
    outputPath = path.join(TMP_DIR, `carousel_${jobId}.mp4`);

    // Probe first clip to get reference resolution/fps
    let refW, refH, refFps;
    await new Promise((resolve) => {
      execFile(ffprobePath(), [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate',
        '-of', 'json', localPaths[0],
      ], { timeout: 15000 }, (err, stdout) => {
        if (!err) {
          try {
            const d = JSON.parse(stdout);
            const s = d.streams?.[0] || {};
            refW = parseInt(s.width  || '0', 10);
            refH = parseInt(s.height || '0', 10);
            const fpsParts = (s.r_frame_rate || '30/1').split('/');
            refFps = Math.round(parseInt(fpsParts[0], 10) / parseInt(fpsParts[1] || '1', 10));
          } catch (_e) { /* ignore */ }
        }
        resolve();
      });
    });

    const needsReencode = refW && localPaths.length > 1 && await (async () => {
      for (const p of localPaths.slice(1)) {
        const r = await new Promise((res) => {
          execFile(ffprobePath(), [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', p,
          ], { timeout: 10000 }, (err, stdout) => {
            if (err) return res(true);
            try {
              const d = JSON.parse(stdout);
              const s = d.streams?.[0] || {};
              return res(parseInt(s.width || '0', 10) !== refW || parseInt(s.height || '0', 10) !== refH);
            } catch { res(true); }
          });
        });
        if (r) return true;
      }
      return false;
    })();

    if (needsReencode) {
      console.log(`[carousel:${jobId}] concat: mismatched resolutions — re-encoding all clips to ${refW}x${refH}`);
      // Scale all clips to ref resolution, then concat
      const scaledPaths = [];
      for (let i = 0; i < localPaths.length; i++) {
        const sp = path.join(TMP_DIR, `carousel_scaled_${jobId}_${i}.mp4`);
        await new Promise((resolve, reject) => {
          execFile(ffmpegPath(), [
            '-y', '-i', localPaths[i],
            '-vf', `scale=${refW}:${refH}:force_original_aspect_ratio=decrease,pad=${refW}:${refH}:(ow-iw)/2:(oh-ih)/2`,
            '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
            '-c:a', 'aac', '-b:a', '128k', sp,
          ], { timeout: 180_000 }, (err) => err ? reject(err) : resolve());
        });
        scaledPaths.push(sp);
      }
      await _concatClips(scaledPaths, outputPath);
      scaledPaths.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
    } else {
      // Same resolution — direct stream copy concat
      const listPath = path.join(TMP_DIR, `concat_${jobId}.txt`);
      fs.writeFileSync(listPath, localPaths.map((p) => `file '${p}'`).join('\n'));
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath(), [
          '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c', 'copy', outputPath,
        ], { timeout: 300_000 }, (err) => err ? reject(err) : resolve());
      });
      try { fs.unlinkSync(listPath); } catch (_) {}
    }
    carouselMeta.resolution = refW ? `${refW}x${refH}` : 'unknown';
    carouselMeta.reencoded  = !!needsReencode;
  }

  // ── Step 4: Upload to R2 and mutate jobSpec ──────────────────────────────
  const isZip    = outputPath.endsWith('.zip');
  const r2Folder = `outputs/${jobId}`;
  const r2Name   = isZip ? `carousel_${jobId}.zip` : `assembled_${jobId}.mp4`;
  let assembledVideoUrl;
  try {
    assembledVideoUrl = await uploadToR2(outputPath, r2Name, { folder: r2Folder });
  } catch (uploadErr) {
    logErr('CAROUSEL_R2_UPLOAD_FAIL', uploadErr, { jobId });
    assembledVideoUrl = null;
  }

  jobSpec.assembledPath     = outputPath;
  jobSpec.outputPath        = outputPath;
  jobSpec.assembledVideoUrl = assembledVideoUrl || `file://${outputPath}`;
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
  if (assembledVideoUrl) jobSpec.state.savedOutputs.r2VideoUrl = assembledVideoUrl;
  jobSpec.state.savedOutputs.assembledPath = outputPath;
  if (assembledVideoUrl) jobSpec.state.savedOutputs.cleanVideoUrl = assembledVideoUrl;
  jobSpec.state.carousel = carouselMeta;

  console.log(`[carousel:${jobId}] complete → ${outputPath} (mode=${mode})`);
  return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
}

async function assembleCarouselQueued(jobSpec) {
  return _withAssemblySemaphore(() => assembleCarousel(jobSpec));
}

module.exports = { assembleForJob: assembleForJobQueued, assembleCarousel: assembleCarouselQueued, mixTtsIntoVideo, mixAlignedMultiClipTts, extractVodClips, applyChrome: _applyChrome, repairFrozenSegmentsInAssembled };
