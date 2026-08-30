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

const DEFAULT_RATIOS = [0.12, 0.32, 0.52, 0.72, 0.88];
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
DISCLAIMER: This is editorial/creative feedback only — NOT legal advice, NOT a copyright or fair-use opinion.

Compare labeled stills from SOURCE (original clip) vs SHORT (our 9:16 composed version).
Source duration ≈ ${sourceDuration}s. Short duration ≈ ${shortDuration}s.

Score each axis 1–5 (5 = strong transformative packaging / clear Short craft; 1 = still reads as raw source).
Axes:
- look_grade: color grade / Punch tint / contrast vs flat source
- crop_layout: 9:16 crop, subject framing, split vs full-bleed, UI cleanup
- captions_hooks: burned captions/hooks visible on SHORT frames (note if absent — may burn only at EXECUTE)
- music_beats: soft — infer from flash/SFX/UI if visible; say "uncertain from stills" when needed
- difference_from_source: overall how different SHORT feels from SOURCE

Return ONLY JSON (no markdown):
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
  "operator_actions": ["concrete Compose fix…"]
}`;
}

async function callGeminiCompare(parts) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const axios = require('axios');
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 90_000 },
  );
  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')).trim();
  const parsed = parseJsonLoose(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Gemini compare: could not parse JSON (${text.slice(0, 180)})`);
  }
  return { rawText: text, report: parsed };
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
  const ratios = opts.ratios || DEFAULT_RATIOS;
  const width = opts.width || 640;

  try {
    const source = await sampleLocalFrames(sourcePath, {
      ratios, width, tmpDir: tmpRoot, label: 'src',
    });
    const short = await sampleLocalFrames(shortPath, {
      ratios, width, tmpDir: tmpRoot, label: 'short',
    });
    if (!source.frames.length || !short.frames.length) {
      throw new Error('Could not extract enough frames from source/short');
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

    const { report, rawText } = await callGeminiCompare(parts);
    report.disclaimer = report.disclaimer
      || 'creative QA only — not legal advice';

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
      },
      rawText: opts.includeRaw ? rawText : undefined,
    };
  } finally {
    if (!opts.keepFrames) cleanupDir(tmpRoot);
  }
}

module.exports = {
  compareShortVsOriginal,
  sampleLocalFrames,
  buildComparePrompt,
  probeDurationSec,
  DEFAULT_RATIOS,
};
