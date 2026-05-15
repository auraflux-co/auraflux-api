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

  // CPD-178: Apply 9:16 vertical crop for vertical_reel / short-form social platform jobs.
  // Twitch clips are native 16:9 — scale+crop to 1080x1920 for TikTok/Instagram delivery.
  const _profile  = jobSpec.productionProfile || '';
  const _format   = jobSpec.format || jobSpec.order?.format || '';
  const _platforms = (jobSpec.platforms || jobSpec.order?.publish?.platforms || []);
  const _needsVertical = (
    _profile === 'vertical_reel' ||
    (_format === 'short' && _platforms.some((p) => ['tiktok', 'instagram'].includes(String(p).toLowerCase())))
  );
  if (_needsVertical) {
    const croppedPath = outputPath.replace('.mp4', '_9x16.mp4');
    try {
      await _applyVerticalCrop(outputPath, croppedPath);
      fs.renameSync(croppedPath, outputPath);
      console.log(`[assembly_service] ${jobId}: 9:16 vertical crop applied`);

      // CPD-184: Re-upload cropped file to R2 — initial upload was pre-crop (16:9).
      // The outputUrl must point to the 9:16 version for E2E QA and portal4 review.
      try {
        const croppedFileName = `assembled_${jobId}_9x16.mp4`;
        const croppedUrl = await uploadToR2(outputPath, croppedFileName, { folder: `outputs/${jobId}` });
        jobSpec.assembledVideoUrl = croppedUrl;
        if (!jobSpec.state) jobSpec.state = {};
        if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
        jobSpec.state.savedOutputs.r2VideoUrl = croppedUrl;
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

    // Multiple clips: concat demuxer with stream copy (no re-encode).
    // Twitch clips are uniformly h264/aac — stream copy is safe.
    const listPath = outputPath.replace(/\.mp4$/, '_list.txt');
    const listContent = localPaths.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // CPD-230: Multi-clip concat must use libx264 re-encode, NOT stream copy.
    // H264 stream copy with the concat demuxer silently produces corrupt video when
    // clips differ in codec level, profile, or timebase.
    //
    // CPD-231: Twitch clips fetched via GQL may resolve to different resolutions
    // (e.g. clip 1 = 1920×1080, clips 2/3 = 640×360) when 1080p is unavailable for
    // older clips. The concat demuxer requires identical stream parameters — when
    // resolutions differ, FFmpeg silently stops after clip 1 (exit code 0) producing
    // a truncated output (e.g. 26s instead of 71.4s) without triggering the fallback.
    //
    // Fix: add a scale+pad filter to normalise all clips to 1920×1080 before encoding.
    // Clips already at 1920×1080 pass through unchanged; smaller clips are letterboxed.
    // This ensures all clips contribute to the output regardless of source resolution.
    const primaryArgs = [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ];

    // CPD-225: Audio normalization after multi-clip concat.
    // Twitch clips can have very different loudness — dynaudnorm smooths boundaries.
    // Video stream is copied (fast, already normalised by libx264 in concat step).
    function _applyAudioNorm(concatPath, cb) {
      const normPath = concatPath.replace(/\.mp4$/, '_audnorm.mp4');
      const normArgs = [
        '-i', concatPath,
        '-c:v', 'copy',
        '-af', 'dynaudnorm=p=0.9:m=100:s=5',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
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

    execFile(ffmpegPath(), primaryArgs, { timeout: 600000 }, (err) => {
      if (!err) {
        try { fs.unlinkSync(listPath); } catch (_) {}
        return _applyAudioNorm(outputPath, resolve);
      }
      // libx264 re-encode failed — fall back to 720p with scale normalisation
      console.warn(`[assembly_service] primary concat failed (${err.message.slice(0, 80)}), falling back to 720p re-encode`);
      const fallbackArgs = [
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
        '-af', 'dynaudnorm=p=0.9:m=100:s=5',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outputPath,
      ];
      execFile(ffmpegPath(), fallbackArgs, { timeout: 600000 }, (err2) => {
        try { fs.unlinkSync(listPath); } catch (_) {}
        if (err2) return reject(new Error(`FFmpeg concat failed: ${err2.message}`));
        resolve();
      });
    });
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
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
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
function _applyChrome(inputPath, outputPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const rawName    = (opts.showName    || 'AuraFlux').replace(/[\\':]/g, '').slice(0, 40);
    const streamer   = (opts.streamerName || '').replace(/[\\':]/g, '').slice(0, 30);
    const isVertical = opts.isVertical || false;

    // CPD-227: Resolve font — bundled repo fonts first (always available on Render),
    // then system fonts as fallback. LiberationSans installs to path that varies by
    // Debian version; bundled BarlowCondensed is the reliable option.
    const fontFile = [
      require('path').join(__dirname, '../assets/fonts/BarlowCondensed-SemiBold.ttf'),
      require('path').join(__dirname, '../assets/fonts/BarlowCondensed-Regular.ttf'),
      '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ].find((f) => { try { return require('fs').existsSync(f); } catch { return false; } }) || '';
    const fontAttr = fontFile ? `:fontfile=${fontFile}` : '';

    // ── Layout constants ────────────────────────────────────────────────────────
    // Vertical (9:16, 1080×1920)  |  Horizontal (16:9)
    const topBarH          = isVertical ? 88  : 60;
    const topAccentH       = isVertical ? 8   : 6;
    const topFontSize      = isVertical ? 40  : 30;
    // Lower-third strip sits in bottom ~22% of frame
    const ltBarH           = isVertical ? 120 : 80;
    const ltBarY           = isVertical ? `h-${ltBarH + 10}` : `h-${ltBarH + 10}`;
    const ltShowFontSize   = isVertical ? 44  : 32;
    const ltLabelFontSize  = isVertical ? 28  : 20;
    const ltLabelY         = isVertical ? `h-${ltBarH + 10 - 68}` : `h-${ltBarH + 10 - 48}`;
    const ltShowY          = isVertical ? `h-${ltBarH + 10 - 14}` : `h-${ltBarH + 10 - 10}`;
    const bottomAccentH    = 10;
    const logoSize         = isVertical ? 28  : 22;
    const logoY            = isVertical ? `h-${ltBarH + 10 + 44}` : `h-${ltBarH + 10 + 34}`;

    const labelText = streamer ? `${streamer} · via AuraFlux` : 'via AuraFlux';

    const filters = [
      // ── Top bar ────────────────────────────────────────────────────────────
      `drawbox=x=0:y=0:w=iw:h=${topBarH}:color=0x0f172a@0.95:t=fill`,
      `drawbox=x=0:y=${topBarH}:w=iw:h=${topAccentH}:color=0x6366f1@1.0:t=fill`,
      `drawtext=text='${rawName}':fontsize=${topFontSize}:fontcolor=white:x=(w-text_w)/2:y=(${topBarH}-text_h)/2${fontAttr}`,
      // ── Lower-third strip ──────────────────────────────────────────────────
      `drawbox=x=0:y=${ltBarY}:w=iw:h=${ltBarH}:color=0x0f172a@0.88:t=fill`,
      `drawbox=x=0:y=${ltBarY}:w=12:h=${ltBarH}:color=0x6366f1@1.0:t=fill`,
      `drawtext=text='${rawName}':fontsize=${ltShowFontSize}:fontcolor=white:x=28:y=${ltShowY}${fontAttr}`,
      `drawtext=text='${labelText}':fontsize=${ltLabelFontSize}:fontcolor=0xc7d2fe@0.9:x=28:y=${ltLabelY}${fontAttr}`,
      // ── Bottom accent bar ─────────────────────────────────────────────────
      `drawbox=x=0:y=h-${bottomAccentH}:w=iw:h=${bottomAccentH}:color=0x6366f1@0.95:t=fill`,
      // ── Corner mark ───────────────────────────────────────────────────────
      `drawtext=text='AuraFlux':fontsize=${logoSize}:fontcolor=0x6366f1@0.75:x=w-text_w-20:y=${logoY}${fontAttr}`,
    ].join(',');

    execFile(
      ffmpegPath(),
      [
        '-i', inputPath,
        '-vf', filters,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', outputPath,
      ],
      { timeout: 300000 },
      (err) => {
        if (err) return reject(new Error(`Chrome overlay failed: ${err.message}`));
        resolve();
      },
    );
  });
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

async function mixTtsIntoVideo(videoPath, audioPath, jobId = 'unknown') {
  if (!videoPath || !audioPath) return null;
  if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
    console.warn(`[assembly_service] ${jobId}: TTS mix skipped — file(s) missing`);
    return null;
  }

  // CPD-219: Trim TTS audio to video duration so it cannot overflow and cut off mid-sentence.
  // A 39s clip with a 50s TTS script would previously be cut at 39s, splitting a sentence.
  // We leave a 1s tail (silence) so the last word has a natural end before video cuts.
  const videoDur = await _getVideoDuration(videoPath);
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
      console.log(`[assembly_service] ${jobId}: TTS trimmed to ${trimDur.toFixed(1)}s (video=${videoDur.toFixed(1)}s)`);
    } catch (trimErr) {
      console.warn(`[assembly_service] ${jobId}: TTS trim failed (using full audio): ${trimErr.message}`);
    }
  }

  const mixedPath = videoPath.replace('.mp4', '_tts_mixed.mp4');
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      [
        '-i', videoPath,
        '-i', effectiveAudioPath,
        '-filter_complex',
        // CPD-229: duration=shortest (was duration=first) — if video audio is shorter than
        // TTS due to concat audio drop, duration=first caused amix to output only the
        // short video audio duration. shortest picks the shorter of audio+TTS but since
        // TTS is always trimmed to videoDur-1, both should be ~equal. This prevents
        // silent truncation when concat audio track < video track duration.
        '[0:a]volume=0.12[duck];[1:a]volume=2.2,apad[narr];[duck][narr]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
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
  console.log(`[assembly_service] ${jobId}: TTS narration mixed (duck 12%, narr 2.2×)`);
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
  const { clipCount = 3, maxClipSecs = 60, jobId = `vod_${Date.now()}`, isVertical = false } = opts;
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
    execFile(
      ytdlp,
      [
        '--get-url',
        '--format', 'best[height<=720]/best[height<=480]/best',
        '--no-playlist',
        '--no-warnings',
        vodUrl,
      ],
      { timeout: 90000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
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

  // Extract N evenly-spaced clips directly from stream URL — no full download.
  // CPD-226: Skip first 15% of stream (was 5%) to avoid pre-stream title cards and
  // waiting rooms that produce static-looking clips.
  const usableStart = Math.floor(effectiveDuration * 0.15);
  const usableEnd   = Math.floor(effectiveDuration * 0.95);
  const usableDur   = usableEnd - usableStart;
  const interval    = Math.floor(usableDur / clipCount);
  const clipPaths   = [];

  for (let i = 0; i < clipCount; i++) {
    const startSec = usableStart + i * interval;
    const clipPath = path.join(TMP_DIR, `vod_clip_${jobId}_${i}.mp4`);
    console.log(`[assembly_service] ${jobId}: extracting clip ${i + 1}/${clipCount} at ${Math.round(startSec)}s`);
    // CPD-220: 5-min timeout too short for large HLS VODs (7.5h stream = ~2700 segments,
    // playlist parse + segment seek can take 3-8 min). Raised to 15 min.
    await new Promise((resolve, reject) => {
      execFile(
        ffmpegPath(),
        [
          '-ss', String(startSec),
          '-i', streamUrl,
          '-t', String(maxClipSecs),
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
          // CPD-201: For vertical_reel profile, extract 9:16 (1080×1920) clips directly
          // instead of 16:9. This saves a separate crop pass after extraction.
          '-vf', isVertical
            ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
            : 'scale=854:480:force_original_aspect_ratio=decrease',
          '-c:a', 'aac', '-ar', '44100', '-b:a', '96k',
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

module.exports = { assembleForJob, mixTtsIntoVideo, extractVodClips, applyChrome: _applyChrome };
