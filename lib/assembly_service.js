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
const { ffmpegPath }  = require('./ffmpeg_utils');
const { uploadToR2 }  = require('./storage');
const { logError }    = require('./error_logger');

const TMP_DIR = os.tmpdir();

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

    console.log(`[assembly_service] ${jobId}: WAN assembled → ${outputPath} (${_fileSizeMb(outputPath).toFixed(1)} MB)`);
    return { assembledPath: outputPath, assembledVideoUrl: jobSpec.assembledVideoUrl };
  }

  const urls = _extractSourceUrls(jobSpec);
  if (!urls.length) throw new Error('[assembly_service] No source URLs to assemble');

  console.log(`[assembly_service] ${jobId}: assembling ${urls.length} clip(s)`);

  // ── Step 2: Download each clip to tmp ────────────────────────────────────
  const localPaths = await _downloadClips(jobId, urls);

  // ── Step 3: FFmpeg concat ────────────────────────────────────────────────
  const outputPath = path.join(TMP_DIR, `assembled_${jobId}.mp4`);
  await _concatClips(localPaths, outputPath);

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

  // Clean up downloaded clips (not the assembled output — portal3a needs it)
  for (const lp of localPaths) {
    try { if (lp !== outputPath) fs.unlinkSync(lp); } catch (_) {}
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

async function _downloadClips(jobId, urls) {
  const localPaths = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const tmpPath = path.join(TMP_DIR, `clip_${jobId}_${i}.mp4`);
    try {
      await _downloadFile(url, tmpPath);
      localPaths.push(tmpPath);
      console.log(`[assembly_service] Downloaded clip ${i + 1}/${urls.length}: ${url.slice(0, 80)}`);
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
    // Avoids OOM on constrained instances when multiple jobs run concurrently.
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

    // Multiple clips: use concat demuxer
    const listPath = outputPath.replace(/\.mp4$/, '_list.txt');
    const listContent = localPaths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    const args = [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];

    execFile(ffmpegPath(), args, { timeout: 300000 }, (err) => {
      try { fs.unlinkSync(listPath); } catch (_) {}
      if (err) return reject(new Error(`FFmpeg concat failed: ${err.message}`));
      resolve();
    });
  });
}

function _fileSizeMb(filePath) {
  try { return fs.statSync(filePath).size / 1024 / 1024; } catch (_) { return 0; }
}

module.exports = { assembleForJob };
