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

// CPD-925: C0 has no @google/generative-ai SDK — use the REST API directly
// (same endpoint pattern as lib/clients/gemini_client.js).
async function _detectWithGemini(jpegPath) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const axios = require('axios');
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

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.1 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
  );

  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('')).trim();
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

// ─── Gemini facecam region (CPD-1228) ────────────────────────────────────────

async function _detectFacecamWithGemini(jpegPath) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const axios = require('axios');
  const base64 = fs.readFileSync(jpegPath).toString('base64');

  const prompt = `Analyse this video frame from a stream/desktop capture. Find the webcam/facecam overlay — the rectangular region showing a real person's LIVE CAMERA FEED (usually a corner box over gameplay or a desktop window).

STRICT RULES:
- The box MUST contain a clearly visible human face/upper body on camera. UI panels, chat windows, text, or menus are NOT a facecam.
- If several camera feeds are visible (e.g. streamer cam + a video-call participant), choose the one showing the STREAMER — typically the standalone corner overlay — or the largest clear face if unsure.
- Make the box TIGHT around the camera feed only. Do not include surrounding UI.

Return ONLY a single-line compact JSON object with the facecam's bounding box in normalised coordinates (0.0=top/left edge, 1.0=bottom/right edge), like:
{"x":0.68,"y":0.03,"w":0.28,"h":0.3,"confidence":0.9}

x=left edge/frame width, y=top edge/frame height, w=box width/frame width, h=box height/frame height.

If the frame is full-screen camera footage (a person fills the frame — no separate facecam box), or no facecam exists, return:
{"x":0,"y":0,"w":0,"h":0,"confidence":0}

Return only the compact JSON object on one line, no other text.`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64 } },
          { text: prompt },
        ],
      }],
      // 2.5-flash spends output budget on internal thinking — 1000 tokens
      // truncated the JSON mid-object (CPD-1228)
      generationConfig: { maxOutputTokens: 4000, temperature: 0.1 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 }
  );

  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('')).trim();
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  const nums = ['x', 'y', 'w', 'h'].map(k => Number(parsed[k]));
  if (nums.some(n => !Number.isFinite(n))) return null;

  const clamp = (v) => Math.max(0, Math.min(1, v));
  const x = clamp(nums[0]);
  const y = clamp(nums[1]);
  const w = Math.min(clamp(nums[2]), 1 - x);
  const h = Math.min(clamp(nums[3]), 1 - y);

  // Sanity: a real facecam box is a meaningful sub-region, not a sliver or the whole frame
  if ((parsed.confidence ?? 0) < 0.5) return null;
  if (w < 0.08 || h < 0.08) return null;
  if (w > 0.85 && h > 0.85) return null;

  return { x, y, w, h, confidence: parsed.confidence };
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

/**
 * Detect the facecam/webcam overlay region in a video clip via Gemini Vision (CPD-1228).
 *
 * @param {string} videoPath - Local path to the video file
 * @param {string} jobId     - For logging / temp file naming
 * @returns {Promise<{x:number, y:number, w:number, h:number, confidence:number}|null>}
 *   Normalised [0,1] facecam bounding box, or null when no facecam is present
 *   (full-frame camera footage, pure gameplay, or detection failure).
 */
async function detectFacecamRegion(videoPath, jobId) {
  // Two sample points — a single frame can miss the cam (scene cut, overlay
  // animation) and Gemini itself is slightly nondeterministic on borderline frames.
  for (const seekRatio of [0.4, 0.65]) {
    const tmpJpeg = path.join(os.tmpdir(), `facecam_${jobId}_${Date.now()}.jpg`);
    try {
      await _extractKeyframe(videoPath, tmpJpeg, seekRatio);
      if (!fs.existsSync(tmpJpeg)) continue;

      const result = await _detectFacecamWithGemini(tmpJpeg);
      if (result) {
        console.log(
          `[smart_crop:${jobId}] Facecam region → x=${result.x.toFixed(3)} y=${result.y.toFixed(3)} ` +
          `w=${result.w.toFixed(3)} h=${result.h.toFixed(3)} (confidence=${result.confidence?.toFixed(2)}, t=${seekRatio})`,
        );
        return result;
      }
    } catch (err) {
      console.warn(`[smart_crop:${jobId}] Facecam detection failed at t=${seekRatio}: ${err.message}`);
    } finally {
      try { fs.unlinkSync(tmpJpeg); } catch {}
    }
  }
  console.log(`[smart_crop:${jobId}] No facecam region detected`);
  return null;
}

module.exports = { detectSubjectCentre, detectFacecamRegion };
