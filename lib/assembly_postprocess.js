'use strict';
/**
 * lib/assembly_postprocess.js — CPD-925: FFmpeg post-processing pass
 *
 * C0 adaptation of production's assembly_postprocess.js (CPD-431/507).
 * Runs after Gate 3 passes, before R2 upload. Thumbnails are generated
 * from the pre-postprocess frame and are NOT touched by this module.
 *
 * Features ported:
 *   1. Whisper-burned captions  — short-form only (CAPTIONS_SHORTS, default on)
 *   2. Final-pass two-pass EBU R128 loudnorm — all videos (FINAL_LOUDNORM, default on)
 *   3. Portrait blur-pad + Gemini smart-crop — utility for 16:9→9:16 conversion
 *      (C0 shorts are composed natively at 9:16, so this is opt-in only)
 *
 * A/V-sync safety (CPD-885 lessons): after every step the video/audio stream
 * durations are probed; if they diverge >0.25s the step's output is discarded
 * and the previous file is kept. Never throws — returns the input path on any
 * failure so delivery is never blocked.
 *
 * Fix vs production: their loudnorm measure pass calls spawn(ffmpegPath, ...)
 * without invoking ffmpegPath() — the measure always fails and silently falls
 * back to single-pass. Corrected here.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('./ffmpeg_utils');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _log(log, asmId, msg) {
  if (typeof log === 'function') log(asmId, msg);
  else console.log(msg);
}

function _runFFmpeg(args, label, timeoutMs = 900_000) {
  return new Promise((res, rej) => {
    const ff = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { ff.kill('SIGKILL'); rej(new Error(`[${label}] timeout after ${timeoutMs / 1000}s`)); }, timeoutMs);
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      clearTimeout(timer);
      if (code === 0) res();
      else rej(new Error(`[${label}] FFmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/** Probe video + audio stream durations. Returns { v, a } seconds or null. */
function _streamDurations(filePath) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', filePath],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const streams = JSON.parse(stdout).streams || [];
          const v = parseFloat(streams.find(s => s.codec_type === 'video')?.duration);
          const a = parseFloat(streams.find(s => s.codec_type === 'audio')?.duration);
          resolve({ v: isNaN(v) ? null : v, a: isNaN(a) ? null : a });
        } catch { resolve(null); }
      }
    );
  });
}

/** CPD-885 safety net — true if A/V stream durations are within tolerance. */
async function _avSyncOk(filePath, toleranceSec = 0.25) {
  const d = await _streamDurations(filePath);
  if (!d || d.v == null || d.a == null) return true; // can't measure — don't block
  return Math.abs(d.v - d.a) <= toleranceSec;
}

// ─── 1. Two-pass EBU R128 loudness normalisation ─────────────────────────────

async function _applyLoudnorm(inputPath, outputPath) {
  // Pass 1: measure (loudnorm prints JSON to stderr)
  const measured = await new Promise((resolve) => {
    const ff = spawn(
      ffmpegPath(),
      ['-i', inputPath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', () => {
      const m = stderr.match(/\{[\s\S]*?"output_lra"[\s\S]*?\}/);
      if (m) { try { resolve(JSON.parse(m[0])); return; } catch {} }
      resolve(null);
    });
  });

  const filter = measured
    ? [
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        `measured_I=${measured.input_i}`,
        `measured_TP=${measured.input_tp}`,
        `measured_LRA=${measured.input_lra}`,
        `measured_thresh=${measured.input_thresh}`,
        `offset=${measured.target_offset}`,
        'linear=true',
      ].join(':')
    : 'loudnorm=I=-16:TP=-1.5:LRA=11';

  // Video copied untouched — only the audio stream is re-encoded.
  // -ar 44100 restores the sample rate (loudnorm resamples to 192kHz internally).
  await _runFFmpeg([
    '-i', inputPath,
    '-af', filter,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', '-y', outputPath,
  ], measured ? 'loudnorm-pass2' : 'loudnorm-single');

  return !!measured;
}

// ─── 2. Whisper caption burn-in (short-form) ─────────────────────────────────

const CAPTION_STYLES = {
  animated: 'FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
  burnin:   'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,Bold=0,BorderStyle=1,Outline=2',
  default:  'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
};

async function _burnCaptionsWhisper(inputPath, outputPath, style = 'default') {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');

  const axios = require('axios');
  const FormData = require('form-data');
  const audioPath = inputPath.replace(/\.mp4$/, '_whisper_audio.mp3');
  const srtPath = inputPath.replace(/\.mp4$/, '_captions.srt');

  try {
    // Extract 16kHz mono audio for Whisper (cheapest/fastest)
    await _runFFmpeg(
      ['-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', audioPath],
      'whisper-audio', 120_000
    );

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'srt');
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
      timeout: 180_000,
      maxBodyLength: Infinity,
    });

    const srt = resp.data;
    if (!srt || typeof srt !== 'string' || !srt.includes('-->')) {
      throw new Error('Whisper returned empty SRT');
    }
    fs.writeFileSync(srtPath, srt, 'utf8');

    const forceStyle = CAPTION_STYLES[style] || CAPTION_STYLES.default;
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    await _runFFmpeg([
      '-i', inputPath,
      '-vf', `subtitles='${escapedSrt}':force_style='${forceStyle}'`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], 'captions-burn');
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
    try { fs.unlinkSync(srtPath); } catch {}
  }
}

// ─── 3. Portrait blur-pad + smart crop (utility — opt-in) ────────────────────

/**
 * Convert a 16:9 video to 9:16 with a blurred background pad. The foreground
 * is positioned using Gemini smart-crop subject detection when available
 * (falls back to centre). C0 shorts are composed natively at 9:16, so this
 * is only for converting landscape content.
 */
async function applyPortraitBlurPad(inputPath, outputPath, { jobId = 'pp', log = null } = {}) {
  let cx = 0.5;
  try {
    const { detectSubjectCentre } = require('./services/smart_crop');
    const centre = await detectSubjectCentre(inputPath, jobId);
    if (centre) cx = centre.cx;
  } catch { /* centre fallback */ }

  // Foreground fills width; vertical position fixed centre. Horizontal subject
  // offset shifts the *crop* of the bg and the fg overlay toward the subject.
  const fgX = `(W-w)*${Math.max(0.15, Math.min(0.85, cx)).toFixed(3)}`;
  const filter = [
    '[0:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,gblur=sigma=20,scale=1080:1920[bg]',
    '[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg]',
    `[bg][fg]overlay=${fgX}:(H-h)/2[vout]`,
  ].join(';');

  await _runFFmpeg([
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart', '-y', outputPath,
  ], 'portrait-blur-pad');
  if (log) log(`[postprocess] portrait blur-pad applied (subject cx=${cx.toFixed(2)})`);
  return outputPath;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply the post-processing pass to an assembled video, in place.
 * Called from assembly.js after Gate 3 passes, before R2 upload.
 * Never throws; on any step failure the previous good file is kept.
 *
 * @param {object} opts
 * @param {string}   opts.outPath     — absolute path to the assembled mp4 (modified in place)
 * @param {boolean}  opts.isShortForm — short-form 9:16 job
 * @param {boolean}  opts.skipCaptionsIfSourceCaptioned — CPD-937: clips-only comps — probe the
 *                    footage for creator-burned captions first; skip whisper pass if found
 * @param {string}   opts.asmId       — assembly id for logging
 * @param {function} opts.log         — assembly log(asmId, msg)
 * @returns {Promise<{captions: boolean, loudnorm: boolean}>} applied flags
 */
async function applyPostProcessing({ outPath, isShortForm = false, skipCaptionsIfSourceCaptioned = false, asmId = 'pp', log = null }) {
  const applied = { captions: false, loudnorm: false };
  if (!outPath || !fs.existsSync(outPath)) return applied;

  let wantsCaptions = isShortForm && process.env.CAPTIONS_SHORTS !== 'false';
  const wantsLoudnorm = process.env.FINAL_LOUDNORM !== 'false';
  if (!wantsCaptions && !wantsLoudnorm) return applied;

  // CPD-937: clips-only comps — many Twitch clips ship with creator-burned karaoke
  // captions. Adding our whisper layer on top doubles the captions. Detect and skip.
  // Fail-open: if detection returns null (no API key / error), captions burn as before.
  if (wantsCaptions && skipCaptionsIfSourceCaptioned) {
    try {
      const { detectBurnedCaptions } = require('./services/frame_intel');
      const hasSourceCaptions = await detectBurnedCaptions(outPath, asmId);
      if (hasSourceCaptions === true) {
        wantsCaptions = false;
        _log(log, asmId, `  📝 Source footage already has burned-in captions — skipping whisper caption pass (CPD-937)`);
      } else if (hasSourceCaptions === false) {
        _log(log, asmId, `  📝 No burned-in captions detected in source — whisper captions will be applied`);
      } else {
        _log(log, asmId, `  ⚠️  Caption detection unavailable — defaulting to whisper captions (fail-open)`);
      }
    } catch (e) {
      _log(log, asmId, `  ⚠️  Caption detection error (fail-open, captions kept): ${e.message.slice(0, 120)}`);
    }
  }

  if (!wantsCaptions && !wantsLoudnorm) return applied;

  _log(log, asmId, `\n🎨 Post-processing (CPD-925): captions=${wantsCaptions} loudnorm=${wantsLoudnorm}`);

  // 1. Captions first (re-encodes video) so loudnorm runs on the final stream.
  if (wantsCaptions) {
    const capOut = outPath.replace(/\.mp4$/, '_cap.mp4');
    try {
      await _burnCaptionsWhisper(outPath, capOut, process.env.CAPTIONS_STYLE || 'default');
      if (await _avSyncOk(capOut)) {
        fs.renameSync(capOut, outPath);
        applied.captions = true;
        _log(log, asmId, `  ✅ Whisper captions burned in`);
      } else {
        _log(log, asmId, `  ⚠️  Captions output failed A/V sync check — keeping uncaptioned video`);
        try { fs.unlinkSync(capOut); } catch {}
      }
    } catch (e) {
      _log(log, asmId, `  ⚠️  Caption burn-in failed (non-fatal): ${e.message.slice(0, 140)}`);
      try { if (fs.existsSync(capOut)) fs.unlinkSync(capOut); } catch {}
    }
  }

  // 2. Final loudness pass (video stream copied — audio only).
  if (wantsLoudnorm) {
    const loudOut = outPath.replace(/\.mp4$/, '_loud.mp4');
    try {
      const twoPass = await _applyLoudnorm(outPath, loudOut);
      if (await _avSyncOk(loudOut)) {
        fs.renameSync(loudOut, outPath);
        applied.loudnorm = true;
        _log(log, asmId, `  ✅ EBU R128 loudnorm applied (${twoPass ? 'two-pass' : 'single-pass'})`);
      } else {
        _log(log, asmId, `  ⚠️  Loudnorm output failed A/V sync check — keeping previous audio`);
        try { fs.unlinkSync(loudOut); } catch {}
      }
    } catch (e) {
      _log(log, asmId, `  ⚠️  Loudnorm failed (non-fatal): ${e.message.slice(0, 140)}`);
      try { if (fs.existsSync(loudOut)) fs.unlinkSync(loudOut); } catch {}
    }
  }

  return applied;
}

module.exports = { applyPostProcessing, applyPortraitBlurPad };
