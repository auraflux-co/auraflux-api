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
const { ffmpegPath, ffprobePath, filterFfmpegPath } = require('./ffmpeg_utils');
const { escapeDrawtext, resolveClipHookTitle, stripDrawtextUnsafe } = require('./clip_comp_cards');
const {
  sanitizeHookLineGlyphs,
  containsHookEmoji,
  buildHookBurnFilterPlan,
} = require('./hook_emoji');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _log(log, asmId, msg) {
  if (typeof log === 'function') log(asmId, msg);
  else console.log(msg);
}

function _runFFmpeg(args, label, timeoutMs = 900_000) {
  return new Promise((res, rej) => {
    const ffBin = (label === 'clip-comp-hook' || label === 'captions-burn' || label === 'clip-comp-transform')
      ? filterFfmpegPath()
      : ffmpegPath();
    const ff = spawn(ffBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

// FontSize is relative to libass's default PlayResY=288 (SRT input has no ASS
// header), so it scales ×6.67 on a 1920-tall short: 18 rendered ≈ 120px tall —
// "way too big" (Rob, CPD-978). 10/11 renders ≈ 67-73px, standard shorts size.
const CAPTION_STYLES = {
  animated: 'FontName=Arial,FontSize=11,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
  burnin:   'FontName=Arial,FontSize=10,PrimaryColour=&H00FFFFFF,Bold=0,BorderStyle=1,Outline=2',
  default:  'FontName=Arial,FontSize=10,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
  clipcomp: 'FontName=Arial,FontSize=8,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
};

/**
 * CPD-978: streamer-name spelling support for Whisper output.
 *
 * Scripts deliberately write phonetic respellings (streamers.json `phonetic`,
 * e.g. "Yawn-uh") so HeyGen pronounces names right — Whisper then transcribes
 * that audio back and captions show the phonetic/misheard spelling. Two-ended
 * fix: bias Whisper with the real on-air names (prompt param), then post-pass
 * the SRT replacing phonetic variants + twitch usernames with the on-air name.
 */
function _loadStreamerRoster() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'streamers.json'), 'utf8');
    const roster = JSON.parse(raw)?.roster;
    return Array.isArray(roster) ? roster : [];
  } catch {
    return [];
  }
}

function _streamerNamePromptBias(roster) {
  const names = [...new Set(roster.map((s) => s.onAirName || s.displayName).filter(Boolean))];
  return names.length ? `Twitch streamers mentioned by name: ${names.join(', ')}.` : '';
}

/** Whisper prompt bias for sports/news clip comps — proper nouns from picker titles. */
function _clipCompWhisperPromptBias(contentType, items = []) {
  const base = String(contentType || '').replace(/-short$/, '');
  const titles = (items || [])
    .map(it => it?.title || it?.headline || it?.clipTitle || '')
    .filter(Boolean)
    .slice(0, 8);
  if (['sports', 'nba', 'basketball', 'boxing', 'hockey'].some(t => base.includes(t))) {
    return titles.length
      ? `Sports broadcast highlight reel. Moments: ${titles.join('; ')}. Transcribe announcer and crowd audio; spell team and player names correctly.`
      : 'Sports broadcast highlight reel with announcer commentary.';
  }
  if (base.includes('news')) {
    return titles.length
      ? `News short compilation. Stories: ${titles.join('; ')}. Transcribe narration and reporter audio accurately.`
      : 'News short compilation with reporter narration.';
  }
  return _streamerNamePromptBias(_loadStreamerRoster());
}

function _correctStreamerNames(srt, roster) {
  let out = srt;
  for (const s of roster) {
    const proper = s.onAirName || s.displayName;
    if (!proper) continue;
    const variants = new Set();
    if (s.phonetic) {
      variants.add(s.phonetic);                      // "Yawn-uh"
      variants.add(s.phonetic.replace(/-/g, ' '));   // "Yawn uh"
      variants.add(s.phonetic.replace(/-/g, ''));    // "Yawnuh"
    }
    if (s.twitchUsername) variants.add(s.twitchUsername); // username leaked into audio
    for (const v of variants) {
      if (!v || v.toLowerCase() === proper.toLowerCase()) continue;
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), proper);
    }
  }
  return out;
}

/**
 * Extract audio from a video and transcribe with Whisper.
 * Shared by the caption burn-in (srt) and publish-copy transcription (text, CPD-939).
 *
 * @param {string} inputPath      - local mp4 path
 * @param {string} responseFormat - 'srt' | 'text'
 * @param {string} promptBias     - optional Whisper prompt to bias proper-noun spelling
 * @returns {Promise<string>} the raw Whisper response
 */
async function _whisperTranscribe(inputPath, responseFormat = 'srt', promptBias = '') {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');

  const axios = require('axios');
  const FormData = require('form-data');
  const audioPath = inputPath.replace(/\.mp4$/, `_whisper_audio_${Date.now()}.mp3`);

  try {
    // Extract 16kHz mono audio for Whisper (cheapest/fastest)
    await _runFFmpeg(
      ['-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', audioPath],
      'whisper-audio', 120_000
    );

    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', responseFormat);
    if (promptBias) form.append('prompt', promptBias);
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
      timeout: 180_000,
      maxBodyLength: Infinity,
    });
    return resp.data;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

/**
 * CPD-939: plain-text transcript of a video's audio (for publish-copy material).
 * Returns null on any failure — callers fall back to whatever script they have.
 */
async function transcribeVideo(inputPath, { jobId = 'pp', log = null } = {}) {
  try {
    const roster = _loadStreamerRoster();
    const bias = _streamerNamePromptBias(roster);
    let text = await _whisperTranscribe(inputPath, 'text', bias);
    if (bias && !(typeof text === 'string' ? text : String(text || '')).trim()) {
      // CPD-1221: prompt bias can yield an empty transcript — retry unbiased.
      text = await _whisperTranscribe(inputPath, 'text', '');
    }
    const clean = _correctStreamerNames(
      (typeof text === 'string' ? text : String(text || '')).trim(), roster);
    if (!clean) return null;
    _log(log, jobId, `  📜 Whisper transcript: ${clean.length} chars`);
    return clean;
  } catch (e) {
    _log(log, jobId, `  ⚠️  Transcription failed (non-fatal): ${e.message.slice(0, 120)}`);
    return null;
  }
}

function _parseSrtTime(ts) {
  const m = String(ts || '').trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

function _formatSrtTime(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Split whisper text into short 1–2 line cues so libass stays in the bottom blur band. */
function _chunkCaptionText(text, maxCharsPerLine = 32, maxLinesPerCue = 2) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const lines = [];
    while (i < words.length && lines.length < maxLinesPerCue) {
      let line = words[i++];
      while (i < words.length && `${line} ${words[i]}`.length <= maxCharsPerLine) {
        line = `${line} ${words[i++]}`;
      }
      lines.push(line);
    }
    chunks.push(lines.join('\n'));
  }
  return chunks;
}

/**
 * Whisper SRT often emits paragraph-length cues — on clip comps those stack upward
 * and cover the burned hook in the sharp zone. Split into short bottom-band cues.
 */
function _normalizeClipCompSrt(srt, { maxCharsPerLine = 32, maxLinesPerCue = 2, maxCueSec = 3.2, minCueSec = 0.85 } = {}) {
  const blocks = String(srt || '').trim().split(/\r?\n\r?\n/);
  const out = [];
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [startRaw, endRaw] = timeLine.split('-->');
    const start = _parseSrtTime(startRaw);
    const end = _parseSrtTime(endRaw);
    const textStart = lines.indexOf(timeLine) + 1;
    const text = lines.slice(textStart).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const chunks = _chunkCaptionText(text, maxCharsPerLine, maxLinesPerCue);
    const duration = Math.max(0.1, end - start);
    if (chunks.length === 1 && duration <= maxCueSec) {
      out.push({ start, end, text: chunks[0] });
      continue;
    }

    const weights = chunks.map((c) => c.replace(/\n/g, ' ').length);
    const total = weights.reduce((s, w) => s + w, 0) || 1;
    let t = start;
    for (let ci = 0; ci < chunks.length; ci++) {
      const share = weights[ci] / total;
      let dur = Math.max(minCueSec, duration * share);
      dur = Math.min(dur, maxCueSec);
      const cueEnd = ci === chunks.length - 1 ? end : Math.min(t + dur, end);
      if (cueEnd <= t) continue;
      out.push({ start: t, end: cueEnd, text: chunks[ci] });
      t = cueEnd;
    }
  }
  return out.map((c, i) => `${i + 1}\n${_formatSrtTime(c.start)} --> ${_formatSrtTime(c.end)}\n${c.text}\n`).join('\n');
}

async function _burnCaptionsKaraoke(inputPath, outputPath, promptBias = '', { compCreative = null } = {}) {
  const assPath = inputPath.replace(/\.mp4$/, '_karaoke.ass');
  try {
    const { transcribeVerboseJson, buildKaraokeAssFromVerboseJson } = require('./clip_comp_karaoke');
    const payload = await transcribeVerboseJson(inputPath, promptBias);
    const fullBleed = compCreative?.captions?.style === 'word_karaoke'
      || compCreative?.layout?.mode === 'full_bleed_crop';
    fs.writeFileSync(assPath, buildKaraokeAssFromVerboseJson(payload, { fullBleed }), 'utf8');
    const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    await _runFFmpeg([
      '-i', inputPath,
      '-vf', `ass='${escapedAss}'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], 'captions-karaoke');
  } finally {
    try { fs.unlinkSync(assPath); } catch {}
  }
}

async function _burnCaptionsWhisper(inputPath, outputPath, style = 'default', promptBias = '', { clipCompTemplate = false, compCreative = null } = {}) {
  const srtPath = inputPath.replace(/\.mp4$/, '_captions.srt');

  try {
    const roster = _loadStreamerRoster();
    const bias = promptBias || _streamerNamePromptBias(roster);
    let rawSrt = await _whisperTranscribe(inputPath, 'srt', bias);
    // CPD-1221: whisper-1 returns an empty SRT when the prompt bias doesn't match
    // the clip audio — retry once without the prompt before failing.
    if (bias && (!rawSrt || typeof rawSrt !== 'string' || !rawSrt.includes('-->'))) {
      rawSrt = await _whisperTranscribe(inputPath, 'srt', '');
    }
    if (!rawSrt || typeof rawSrt !== 'string' || !rawSrt.includes('-->')) {
      throw new Error('Whisper returned empty SRT');
    }
    let srtBody = _correctStreamerNames(rawSrt, roster);
    if (clipCompTemplate) {
      srtBody = _normalizeClipCompSrt(srtBody);
    }
    fs.writeFileSync(srtPath, srtBody, 'utf8');

    let forceStyle = clipCompTemplate
      ? CAPTION_STYLES.clipcomp
      : (CAPTION_STYLES[style] || CAPTION_STYLES.default);
    if (clipCompTemplate) {
      const { clipCompWhisperCaptionStyleSuffix } = require('./clip_comp_template');
      forceStyle += clipCompWhisperCaptionStyleSuffix(compCreative);
    }
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    await _runFFmpeg([
      '-i', inputPath,
      '-vf', `subtitles='${escapedSrt}':force_style='${forceStyle}'`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], 'captions-burn');
  } finally {
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
async function applyPortraitBlurPad(inputPath, outputPath, { jobId = 'pp', log = null, bottomCropPct = 0 } = {}) {
  let cx = 0.5;
  try {
    const { detectSubjectCentre } = require('./services/smart_crop');
    const centre = await detectSubjectCentre(inputPath, jobId);
    if (centre) cx = centre.cx;
  } catch { /* centre fallback */ }

  // CPD-1220: optionally crop a baked-in bottom strip (tickers/social bars) off the
  // source before layout. Height forced even for yuv420p.
  const cropPct = Math.max(0, Math.min(0.3, Number(bottomCropPct) || 0));
  const srcCrop = cropPct > 0
    ? `crop=iw:trunc(ih*${(1 - cropPct).toFixed(3)}/2)*2:0:0,`
    : '';

  // Foreground fills width; vertical position fixed centre. Horizontal subject
  // offset shifts the *crop* of the bg and the fg overlay toward the subject.
  const fgX = `(W-w)*${Math.max(0.15, Math.min(0.85, cx)).toFixed(3)}`;
  const filter = [
    `[0:v]${srcCrop}split=2[s0][s1]`,
    '[s0]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,gblur=sigma=20,scale=1080:1920[bg]',
    '[s1]scale=1080:-2:force_original_aspect_ratio=decrease[fg]',
    `[bg][fg]overlay=${fgX}:(H-h)/2[vout]`,
  ].join(';');

  await _runFFmpeg([
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart', '-y', outputPath,
  ], 'portrait-blur-pad');
  if (log) log(`[postprocess] portrait blur-pad applied (subject cx=${cx.toFixed(2)}${cropPct > 0 ? `, bottom crop ${(cropPct * 100).toFixed(0)}%` : ''})`);
  return outputPath;
}

/**
 * Build drawtext style from designSpec.chrome.caption for clip-comp hook titles.
 */
function _escapeFontPath(fontPath) {
  return String(fontPath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

function buildClipCompHookStyle(designSpec, contentType) {
  const cap = designSpec?.chrome?.caption || {};
  const base = String(contentType || 'twitch-short').replace(/-short$/, '');
  const typeKey = ['sports', 'nba'].some(t => base.includes(t)) ? 'sports'
    : base.includes('news') ? 'news' : 'clips';
  const accent = cap.colors?.[typeKey] || cap.colors?.clips || '#c7af4f';
  const boxOpacity = cap.boxOpacity ?? 0.82;
  const defaultFont = path.join(__dirname, '..', 'assets', 'fonts', 'BarlowCondensed-SemiBold.ttf');
  return {
    font: cap.font || defaultFont,
    fontsize: cap.fontsize || 56,
    fontcolor: cap.textColor || '#FFFFFF',
    boxcolor: `${accent}@${boxOpacity}`,
    boxborderw: cap.boxBorderW || 14,
    borderw: cap.strokeWidth || 4,
    bordercolor: cap.strokeColor || '#000000',
    shadowx: cap.shadowX || 2,
    shadowy: cap.shadowY || 2,
    shadowcolor: cap.shadowColor || '#000000@0.75',
    useBox: cap.useBox !== false,
    yOffset: cap.yOffset || 16,
    maxLines: cap.maxLines || 2,
  };
}

/**
 * Word-wrap hook titles for drawtext (max 2 lines). Returns an array of lines —
 * never embeds \\n in text (FFmpeg drawtext shows a literal "n" when \\n misparses).
 */
function _wrapHookLines(rawText, maxLines = 2, maxCharsPerLine = 36) {
  // Pipe '|' acts as a manual line-break: "LINE 1|LINE 2" → ['LINE 1', 'LINE 2']
  if (String(rawText || '').includes('|')) {
    const { sanitizeHookLineGlyphs: _sg } = require('./hook_emoji');
    const forced = String(rawText).split('|').map((l) => _sg(l.trim())).filter(Boolean);
    if (forced.length > 1) return forced.slice(0, maxLines);
  }
  const clean = sanitizeHookLineGlyphs(String(rawText || '').replace(/\s+/g, ' '));
  if (!clean) return [];
  if (maxLines <= 1) return [clean];

  const words = clean.split(' ');
  const lines = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i++];
    while (i < words.length && `${line} ${words[i]}`.length <= maxCharsPerLine) {
      line = `${line} ${words[i++]}`;
    }
    lines.push(line);
  }
  if (i < words.length && lines.length) {
    const tail = words.slice(i).join(' ');
    const merged = `${lines[lines.length - 1]} ${tail}`.trim();
    lines[lines.length - 1] = merged.length > 52
      ? `${merged.slice(0, 51).trim()}\u2026`
      : merged;
  }
  return lines;
}

/** Build chained drawtext filters — one filter per line (true wrap, no \\n). */
function _buildHookDrawtextFilters(lines, style, sharpBottom, { hookPlacement = 'bottom', hookMidY = 680 } = {}) {
  const lineHeight = Math.round(style.fontsize * 1.18);
  const blockHeight = lines.length * lineHeight;
  const midFrame = hookPlacement === 'ranked_mid' || hookPlacement === 'full_bleed_mid';
  const baseY = midFrame
    ? hookMidY
    : sharpBottom - style.yOffset - blockHeight;

  return lines.map((line, idx) => {
    const y = baseY + idx * lineHeight;
    const parts = [
      `fontfile=${_escapeFontPath(style.font)}`,
      `text='${escapeDrawtext(line)}'`,
      `fontsize=${style.fontsize}`,
      `fontcolor=${style.fontcolor}`,
      `box=${style.useBox ? 1 : 0}`,
      `boxcolor=${style.boxcolor}`,
      `boxborderw=${style.boxborderw}`,
      `borderw=${style.borderw}`,
      `bordercolor=${style.bordercolor}`,
      `shadowx=${style.shadowx}`,
      `shadowy=${style.shadowy}`,
      `shadowcolor=${style.shadowcolor}`,
      'x=(W-text_w)/2',
      `y=${y}`,
    ];
    return `drawtext=${parts.join(':')}`;
  }).join(',');
}

/**
 * Burn a per-clip hook title on clip-comp footage (bottom of sharp 16:9 zone).
 * Non-fatal on failure — returns inputPath unchanged.
 */
async function burnClipCompHookCaption(inputPath, outputPath, {
  text, designSpec, contentType, sharpBottom, hookPlacement = 'bottom', hookMidY = 680, log = null,
} = {}) {
  const style = buildClipCompHookStyle(designSpec, contentType);
  const lines = _wrapHookLines(text, style.maxLines, 36);
  if (!lines.length) return inputPath;

  const { CONFIG } = require('./config');
  const sharpBottomY = sharpBottom
    || CONFIG.VISUAL_LAYOUTS?.SHORT_FORM?.CLIP_COMP_SHARP_BOTTOM
    || 1264;

  const useEmojiOverlay = lines.some((line) => containsHookEmoji(line));
  const vf = useEmojiOverlay
    ? null
    : _buildHookDrawtextFilters(lines, style, sharpBottomY, { hookPlacement, hookMidY });

  try {
    if (useEmojiOverlay) {
      const plan = buildHookBurnFilterPlan(lines, style, {
        sharpBottom: sharpBottomY,
        hookPlacement,
        hookMidY,
      });
      if (!plan) return inputPath;
      const args = [
        '-i', inputPath,
        ...plan.extraInputs.flatMap((p) => ['-i', p]),
        '-filter_complex', plan.filterComplex,
        '-map', `[${plan.mapLabel}]`,
        '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart', '-y', outputPath,
      ];
      await _runFFmpeg(args, 'clip-comp-hook');
    } else {
      await _runFFmpeg([
        '-i', inputPath,
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart', '-y', outputPath,
      ], 'clip-comp-hook');
    }
    if (log) log(`  💬 Hook title burned: "${lines.join(' | ')}"`);
    return outputPath;
  } catch (e) {
    if (log) log(`  ⚠️  Hook title burn failed (non-fatal): ${e.message.slice(0, 100)}`);
    try { fs.copyFileSync(inputPath, outputPath); } catch {}
    return inputPath;
  }
}

async function applyClipCompTransform(inputPath, outputPath, { contentType, designSpec, asmId = 'pp', log = null }) {
  if (process.env.CLIP_COMP_TRANSFORM === 'false') return false;
  const { buildClipCompEffectsSpec } = require('./clip_comp_transform');
  const { buildVideoFilterChain, buildAudioFilterChain } = require('./assembly_effects');
  const spec = buildClipCompEffectsSpec(contentType, designSpec);
  const vf = buildVideoFilterChain(spec);
  const af = buildAudioFilterChain(spec);
  if (!vf && !af) return false;

  const args = ['-i', inputPath];
  if (vf) args.push('-vf', vf);
  if (af) args.push('-af', af);
  args.push(
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-y', outputPath,
  );
  await _runFFmpeg(args, 'clip-comp-transform');
  return true;
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
 * @param {boolean}  opts.skipCaptionsIfSourceCaptioned — CPD-937: twitch clip comps only
 * @param {string}   opts.contentType  — sports-short | news-short | twitch-short
 * @param {Array}    opts.items        — clip titles for whisper proper-noun bias
 * @param {boolean}  opts.clipCompTransform — true for twitch clip comp jobs (transform only if CLIP_COMP_EXPERIMENT=1)
 * @param {object}   opts.designSpec       — for transform + caption styling
 * @param {string}   opts.asmId       — assembly id for logging
 * @param {function} opts.log         — assembly log(asmId, msg)
 * @returns {Promise<{captions: boolean, loudnorm: boolean, transform: boolean}>} applied flags
 */
async function applyPostProcessing({
  outPath,
  isShortForm = false,
  skipCaptionsIfSourceCaptioned = false,
  /** Pre-hook probe result from clip_comp_assembly (CPD-937). */
  sourceCaptionsDetected = null,
  contentType = null,
  items = [],
  clipCompTransform = false,
  designSpec = null,
  compCreative = null,
  asmId = 'pp',
  log = null,
}) {
  const applied = { captions: false, loudnorm: false, transform: false };
  if (!outPath || !fs.existsSync(outPath)) return applied;

  let wantsCaptions = isShortForm && process.env.CAPTIONS_SHORTS !== 'false';
  const wantsLoudnorm = process.env.FINAL_LOUDNORM !== 'false';

  const hookMode = compCreative?.hooks?.mode || 'both';
  if (hookMode === 'hook_only') wantsCaptions = false;
  if (compCreative?.captions?.whisper === false) wantsCaptions = false;

  if (!wantsCaptions && !wantsLoudnorm) return applied;

  const isBroadcastClipComp = /^(sports|news)-short$/i.test(contentType || '');
  const isClipComp = !!clipCompTransform;
  const { clipCompExperimentEnabled, shouldApplyClipCompTransform } = require('./clip_comp_template');
  const applyTransform = shouldApplyClipCompTransform(isClipComp);
  const useClipCompTemplate = isClipComp && !clipCompExperimentEnabled();
  if (useClipCompTemplate) {
    _log(log, asmId, '  📐 Clip-comp template mode (Jun 17 reference) — no transform/badge; set CLIP_COMP_EXPERIMENT=1 to experiment');
  }

  // CPD-937: skip whisper when the *source Twitch clip* already has creator captions.
  // Clip comps probe pre-hook footage in clip_comp_assembly — never the final file
  // (our burned hook box false-positives as "already captioned").
  if (wantsCaptions && skipCaptionsIfSourceCaptioned && !isBroadcastClipComp) {
    if (isClipComp) {
      if (sourceCaptionsDetected === true) {
        wantsCaptions = false;
        _log(log, asmId, '  📝 Source clip has creator burned-in captions (pre-hook probe) — skipping whisper');
      } else if (sourceCaptionsDetected === false) {
        _log(log, asmId, '  📝 Pre-hook probe: no source captions — applying ClipzWorld whisper');
      } else {
        _log(log, asmId, '  ⚠️  Pre-hook caption probe unavailable — applying whisper (fail-open)');
      }
    } else {
      try {
        const { detectBurnedCaptions } = require('./services/frame_intel');
        const hasSourceCaptions = await detectBurnedCaptions(outPath, asmId);
        if (hasSourceCaptions === true) {
          wantsCaptions = false;
          _log(log, asmId, '  📝 Source footage already has burned-in captions — skipping whisper caption pass (CPD-937)');
        } else if (hasSourceCaptions === false) {
          _log(log, asmId, '  📝 No burned-in captions detected in source — whisper captions will be applied');
        } else {
          _log(log, asmId, '  ⚠️  Caption detection unavailable — defaulting to whisper captions (fail-open)');
        }
      } catch (e) {
        _log(log, asmId, `  ⚠️  Caption detection error (fail-open, captions kept): ${e.message.slice(0, 120)}`);
      }
    }
  }

  if (!wantsCaptions && !wantsLoudnorm) return applied;

  if (isBroadcastClipComp && wantsCaptions) {
    _log(log, asmId, `  📝 Broadcast clip comp (${contentType}) — forcing ClipzWorld whisper captions`);
  } else if (isClipComp && wantsCaptions) {
    _log(log, asmId, `  📝 Twitch clip comp — applying ClipzWorld whisper captions`);
  }

  // Transform pass BEFORE captions — only when CLIP_COMP_EXPERIMENT=1 (not template publish mode).
  if (applyTransform) {
    const txOut = outPath.replace(/\.mp4$/, '_tx.mp4');
    try {
      const ok = await applyClipCompTransform(outPath, txOut, { contentType, designSpec, asmId, log: (m) => _log(log, asmId, m) });
      if (ok && await _avSyncOk(txOut)) {
        fs.renameSync(txOut, outPath);
        applied.transform = true;
        _log(log, asmId, `  ✅ Clip-comp transform applied (grade + vignette + grain + badge)`);
      } else if (ok) {
        _log(log, asmId, `  ⚠️  Transform failed A/V sync — keeping pre-transform video`);
        try { fs.unlinkSync(txOut); } catch {}
      }
    } catch (e) {
      _log(log, asmId, `  ⚠️  Clip-comp transform failed (non-fatal): ${e.message.slice(0, 140)}`);
      try { if (fs.existsSync(txOut)) fs.unlinkSync(txOut); } catch {}
    }
  }

  _log(log, asmId, `\n🎨 Post-processing (CPD-925): transform=${applied.transform} captions=${wantsCaptions} loudnorm=${wantsLoudnorm}`);

  const whisperBias = _clipCompWhisperPromptBias(contentType, items);

  // 1. Captions first (re-encodes video) so loudnorm runs on the final stream.
  if (wantsCaptions) {
    const capOut = outPath.replace(/\.mp4$/, '_cap.mp4');
    try {
      const useKaraoke = compCreative?.captions?.style === 'word_karaoke';
      if (useKaraoke) {
        await _burnCaptionsKaraoke(outPath, capOut, whisperBias, { compCreative });
      } else {
        await _burnCaptionsWhisper(outPath, capOut, process.env.CAPTIONS_STYLE || 'default', whisperBias, {
          clipCompTemplate: useClipCompTemplate,
          compCreative,
        });
      }
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

module.exports = {
  applyPostProcessing,
  applyPortraitBlurPad,
  transcribeVideo,
  burnClipCompHookCaption,
  buildClipCompHookStyle,
  resolveClipHookTitle,
  stripDrawtextUnsafe,
  _wrapHookLines,
  _buildHookDrawtextFilters,
  applyClipCompTransform,
  // exported for tests (CPD-978)
  _correctStreamerNames,
  _streamerNamePromptBias,
  _clipCompWhisperPromptBias,
  _normalizeClipCompSrt,
  _chunkCaptionText,
};
