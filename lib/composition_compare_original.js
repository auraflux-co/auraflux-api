'use strict';

/**
 * Gemini transformative QA — original source MP4 vs Composer Short / near-final.
 * Frame-pair stills (cheap); creative axes only — not legal advice.
 * iss__qrpQbwdfXTJ
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { ffmpegPath } = require('./ffmpeg_utils');
const { parseJsonLoose } = require('./gemini_json_parse');

/** Fewer pairs = less truncation (was 7×2 images → incomplete JSON). */
const DEFAULT_RATIOS = [0.08, 0.32, 0.55, 0.78, 0.9];
const RETRY_RATIOS = [0.1, 0.45, 0.85];
const AXIS_KEYS = ['look_grade', 'crop_layout', 'captions_hooks', 'music_beats', 'difference_from_source'];
const GEMINI_MODEL = process.env.GEMINI_COMPARE_MODEL || 'gemini-2.5-flash';

async function probeDurationSec(videoPath) {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath(),
      ['-i', videoPath, '-f', 'null', '/dev/null'],
      { timeout: 15_000 },
    ).catch((e) => ({ stderr: e.stderr || '' }));
    const m = String(stderr).match(/Duration:\s*([\d:.]+)/);
    if (!m) return 0;
    const [h, min, s] = m[1].split(':').map(parseFloat);
    return h * 3600 + min * 60 + s;
  } catch {
    return 0;
  }
}

async function extractFrame(videoPath, outJpeg, seekSecs, { width = 640, quality = '3' } = {}) {
  await execFileAsync(
    ffmpegPath(),
    [
      '-ss', String(Math.max(0, seekSecs)),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', quality,
      '-y', outJpeg,
    ],
    { timeout: 20_000 },
  );
}

async function sampleLocalFrames(videoPath, {
  ratios = DEFAULT_RATIOS,
  width = 640,
  tmpDir,
  label = 'frame',
} = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`sampleLocalFrames: missing file ${videoPath}`);
  }
  const dur = await probeDurationSec(videoPath);
  const safeDur = dur > 0.5 ? dur : 1;
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-cmp-'));
  const frames = [];
  for (let i = 0; i < ratios.length; i++) {
    const r = ratios[i];
    const atSec = Math.min(safeDur * 0.98, Math.max(0.05, safeDur * r));
    const outJpeg = path.join(dir, `${label}_${i}_${Math.round(atSec * 10)}.jpg`);
    try {
      await extractFrame(videoPath, outJpeg, atSec, { width });
      if (fs.existsSync(outJpeg) && fs.statSync(outJpeg).size > 200) {
        frames.push({ path: outJpeg, atSec: Math.round(atSec * 100) / 100, ratio: r });
      }
    } catch (_) {
      /* skip bad seek */
    }
  }
  return { frames, durationSec: Math.round(safeDur * 100) / 100, dir };
}

function buildComparePrompt({ sourceDuration, shortDuration }) {
  return `You are a creative video editor doing TRANSFORM QA for ClipzWorld Shorts.
DISCLAIMER: editorial/creative feedback only — NOT legal advice, NOT copyright/fair-use opinion.

Compare labeled SOURCE vs SHORT stills. Source ≈ ${sourceDuration}s. Short ≈ ${shortDuration}s.

Score EVERY axis 1–5 (integer). Keep each notes field ≤18 words. Never omit an axis.
Axes:
- look_grade: color/Punch vs source
- crop_layout: 9:16 framing
- captions_hooks: watermark + animated text/hooks on SHORT (Whisper often EXECUTE-only — do not crush if anim text present)
- music_beats: brightness flashes / beat-timed text if visible; else score 2 + "uncertain from stills"
- difference_from_source: overall Short packaging vs raw source

Return ONLY one complete JSON object (all keys required):
{
  "disclaimer": "creative QA only — not legal advice",
  "transform_strength": 1-5,
  "c9_fableflow_fit": 1-5,
  "axes": {
    "look_grade": { "score": 1-5, "notes": "…" },
    "crop_layout": { "score": 1-5, "notes": "…" },
    "captions_hooks": { "score": 1-5, "notes": "…" },
    "music_beats": { "score": 1-5, "notes": "…" },
    "difference_from_source": { "score": 1-5, "notes": "…" }
  },
  "gaps": ["…"],
  "operator_actions": ["…"]
}`;
}

async function callGeminiCompare(parts, { maxOutputTokens = 4096 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const axios = require('axios');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens,
        temperature: 0.15,
        responseMimeType: 'application/json',
      },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 90_000 },
  );
  const cand = resp.data?.candidates?.[0];
  const finishReason = cand?.finishReason || cand?.finish_reason || null;
  const text = ((cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')).trim();
  if (!text) {
    throw new Error(`Gemini compare: empty response (finishReason=${finishReason || 'n/a'})`);
  }
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Gemini compare: could not parse JSON (${text.slice(0, 180)})`);
  }
  return { rawText: text, report: parsed, finishReason };
}

function scoreOf(axis) {
  if (!axis || typeof axis !== 'object') return null;
  const n = Number(axis.score);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null;
}

/** True when every required axis has an integer 1–5 score. */
function isCompleteCompareReport(report) {
  if (!report || typeof report !== 'object') return false;
  const ts = Number(report.transform_strength);
  if (!Number.isFinite(ts) || ts < 1 || ts > 5) return false;
  const axes = report.axes || {};
  return AXIS_KEYS.every((k) => scoreOf(axes[k]) != null);
}

function incompleteAxes(report) {
  const axes = (report && report.axes) || {};
  return AXIS_KEYS.filter((k) => scoreOf(axes[k]) == null);
}

function cleanupDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* ignore */ }
    }
    fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
}

/**
 * @param {{ sourcePath: string, shortPath: string, ratios?: number[], width?: number, keepFrames?: boolean }} opts
 */
async function compareShortVsOriginal(opts = {}) {
  const sourcePath = opts.sourcePath;
  const shortPath = opts.shortPath;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error('sourcePath missing or not found');
  }
  if (!shortPath || !fs.existsSync(shortPath)) {
    throw new Error('shortPath missing or not found (run Review near-final first)');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-xform-cmp-'));
  const width = opts.width || 640;
  const attempts = [
    { ratios: opts.ratios || DEFAULT_RATIOS, maxOutputTokens: 4096 },
    { ratios: RETRY_RATIOS, maxOutputTokens: 6144 },
  ];

  try {
    let lastErr = null;
    let lastRaw = null;
    let lastFinish = null;
    for (let i = 0; i < attempts.length; i++) {
      const { ratios, maxOutputTokens } = attempts[i];
      const source = await sampleLocalFrames(sourcePath, {
        ratios, width, tmpDir: tmpRoot, label: `src${i}`,
      });
      const short = await sampleLocalFrames(shortPath, {
        ratios, width, tmpDir: tmpRoot, label: `short${i}`,
      });
      if (!source.frames.length || !short.frames.length) {
        lastErr = new Error('Could not extract enough frames from source/short');
        continue;
      }

      const parts = [];
      for (const f of source.frames) {
        parts.push({ text: `SOURCE frame @ ${f.atSec}s` });
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: fs.readFileSync(f.path).toString('base64'),
          },
        });
      }
      for (const f of short.frames) {
        parts.push({ text: `SHORT frame @ ${f.atSec}s` });
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: fs.readFileSync(f.path).toString('base64'),
          },
        });
      }
      parts.push({
        text: buildComparePrompt({
          sourceDuration: source.durationSec,
          shortDuration: short.durationSec,
        }),
      });

      try {
        const { report, rawText, finishReason } = await callGeminiCompare(parts, { maxOutputTokens });
        lastRaw = rawText;
        lastFinish = finishReason;
        report.disclaimer = report.disclaimer || 'creative QA only — not legal advice';

        if (!isCompleteCompareReport(report) || String(finishReason || '').toUpperCase() === 'MAX_TOKENS') {
          const missing = incompleteAxes(report);
          lastErr = new Error(
            `incomplete compare (finish=${finishReason || 'n/a'}; missing=${missing.join(',') || 'scores'})`,
          );
          continue;
        }

        return {
          ok: true,
          report,
          meta: {
            sourcePath,
            shortPath,
            sourceDurationSec: source.durationSec,
            shortDurationSec: short.durationSec,
            sourceFrames: source.frames.map((f) => f.atSec),
            shortFrames: short.frames.map((f) => f.atSec),
            model: GEMINI_MODEL,
            attempt: i + 1,
            finishReason: finishReason || null,
          },
          rawText: opts.includeRaw ? rawText : undefined,
        };
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `Gemini compare incomplete after retry: ${(lastErr && lastErr.message) || 'unknown'}`
        + (lastFinish ? ` (lastFinish=${lastFinish})` : '')
        + (lastRaw ? ` · ${String(lastRaw).slice(0, 120)}` : ''),
    );
  } finally {
    if (!opts.keepFrames) cleanupDir(tmpRoot);
  }
}

module.exports = {
  compareShortVsOriginal,
  sampleLocalFrames,
  buildComparePrompt,
  probeDurationSec,
  isCompleteCompareReport,
  incompleteAxes,
  DEFAULT_RATIOS,
  RETRY_RATIOS,
  AXIS_KEYS,
};
