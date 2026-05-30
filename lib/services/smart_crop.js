'use strict';
/**
 * lib/services/smart_crop.js — CPD-440
 *
 * Uses Gemini Vision to detect the main subject's centre in a video frame,
 * returning normalised (cx, cy) coordinates so assembly_postprocess can
 * offset the portrait blur-pad overlay to keep the subject in frame.
 *
 * Falls back to centre (0.5, 0.5) gracefully if Gemini is unavailable,
 * the image has no clear subject, or any step fails.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { ffmpegPath } = require('../ffmpeg_utils');

const execFileAsync = promisify(execFile);

// ─── Keyframe extraction ─────────────────────────────────────────────────────

async function _probeVideoDuration(videoPath) {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath(),
      ['-i', videoPath, '-f', 'null', '/dev/null'],
      { timeout: 10_000 },
    ).catch(e => ({ stderr: e.stderr || '' }));
    const m = stderr.match(/Duration:\s*([\d:.]+)/);
    if (!m) return 0;
    const [h, min, s] = m[1].split(':').map(parseFloat);
    return h * 3600 + min * 60 + s;
  } catch {
    return 0;
  }
}

async function _extractKeyframe(videoPath, outputJpeg, seekRatio = 0.4) {
  const dur = await _probeVideoDuration(videoPath);
  const seekSecs = dur > 0 ? dur * seekRatio : 0;
  await execFileAsync(
    ffmpegPath(),
    [
      '-ss', String(seekSecs),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=640:-2',
      '-q:v', '3',
      '-y', outputJpeg,
    ],
    { timeout: 15_000 },
  );
}

// ─── Gemini bounding box ─────────────────────────────────────────────────────

async function _detectWithGemini(jpegPath) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  let GoogleGenerativeAI;
  try {
    ({ GoogleGenerativeAI } = require('@google/generative-ai'));
  } catch {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const imageData = fs.readFileSync(jpegPath);
  const base64 = imageData.toString('base64');

  const prompt = `Analyse this video frame. Identify the single most important visual subject (a person, character, gameplay action area, or key object).

Return ONLY a JSON object with these normalised coordinates (0.0=top/left edge, 1.0=bottom/right edge):
{
  "cx": <subject centre x as fraction of frame width>,
  "cy": <subject centre y as fraction of frame height>,
  "confidence": <0.0 to 1.0>
}

If no clear single subject exists, or the frame is predominantly UI/HUD with no focal point, return:
{"cx": 0.5, "cy": 0.5, "confidence": 0.0}

Return only the JSON object, no other text.`;

  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: base64 } },
    { text: prompt },
  ]);

  const text = result.response.text().trim();
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  if (typeof parsed.cx !== 'number' || typeof parsed.cy !== 'number') return null;

  // Clamp to [0,1]
  const cx = Math.max(0, Math.min(1, parsed.cx));
  const cy = Math.max(0, Math.min(1, parsed.cy));

  // Low confidence means Gemini couldn't identify a subject — use centre
  if ((parsed.confidence ?? 1) < 0.35) return null;

  return { cx, cy, confidence: parsed.confidence };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect the main subject's centre in a video clip via Gemini Vision.
 *
 * @param {string} videoPath   - Local path to the video file
 * @param {string} jobId       - For logging / temp file naming
 * @returns {Promise<{cx:number, cy:number}|null>}
 *   Normalised [0,1] subject centre, or null to fall back to (0.5, 0.5).
 */
async function detectSubjectCentre(videoPath, jobId) {
  const tmpJpeg = path.join(os.tmpdir(), `smart_crop_${jobId}_${Date.now()}.jpg`);
  try {
    await _extractKeyframe(videoPath, tmpJpeg);
    if (!fs.existsSync(tmpJpeg)) return null;

    const result = await _detectWithGemini(tmpJpeg);
    if (result) {
      console.log(
        `[smart_crop:${jobId}] Subject centre → cx=${result.cx.toFixed(3)} ` +
        `cy=${result.cy.toFixed(3)} (confidence=${result.confidence?.toFixed(2)})`,
      );
    } else {
      console.log(`[smart_crop:${jobId}] No clear subject — using centre fallback`);
    }
    return result;
  } catch (err) {
    console.warn(`[smart_crop:${jobId}] Detection failed: ${err.message} — using centre`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpJpeg); } catch {}
  }
}

module.exports = { detectSubjectCentre };
