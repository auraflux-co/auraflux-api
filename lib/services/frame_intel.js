'use strict';
/**
 * lib/services/frame_intel.js — CPD-937 / CPD-938
 *
 * Gemini Vision intelligence over sampled video frames:
 *   - detectBurnedCaptions(): does the footage already contain burned-in
 *     subtitle/caption text? (CPD-937 — avoids double captions on clip comps)
 *   - pickBestThumbnailFrame(): choose the most engaging frame to use as the
 *     short-form thumbnail (CPD-938 — shorts use real frames, not designed art)
 *
 * Both fail gracefully: detectBurnedCaptions returns null on any failure
 * (caller decides the fail-open behaviour); pickBestThumbnailFrame falls back
 * to a fixed-ratio frame when Gemini is unavailable.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { ffmpegPath } = require('../ffmpeg_utils');

const execFileAsync = promisify(execFile);

// ─── Frame extraction ────────────────────────────────────────────────────────

async function _probeDuration(videoPath) {
  try {
    const { stderr } = await execFileAsync(
      ffmpegPath(),
      ['-i', videoPath, '-f', 'null', '/dev/null'],
      { timeout: 15_000 },
    ).catch(e => ({ stderr: e.stderr || '' }));
    const m = stderr.match(/Duration:\s*([\d:.]+)/);
    if (!m) return 0;
    const [h, min, s] = m[1].split(':').map(parseFloat);
    return h * 3600 + min * 60 + s;
  } catch {
    return 0;
  }
}

async function _extractFrame(videoPath, outJpeg, seekSecs, { width = 640, quality = '3' } = {}) {
  await execFileAsync(
    ffmpegPath(),
    [
      '-ss', String(seekSecs),
      '-i', videoPath,
      '-vframes', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', quality,
      '-y', outJpeg,
    ],
    { timeout: 20_000 },
  );
}

// ─── Gemini Vision (REST — C0 has no @google/generative-ai SDK, CPD-925) ────

async function _geminiVision(jpegPaths, prompt) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  const axios = require('axios');
  const parts = jpegPaths.map(p => ({
    inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(p).toString('base64') },
  }));
  parts.push({ text: prompt });

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.1 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 45_000 }
  );

  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join('')).trim();
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

// ─── Public: burned-caption detection (CPD-937) ─────────────────────────────

/**
 * Check whether the video already contains burned-in subtitle/caption text.
 *
 * @param {string} videoPath - local mp4 path
 * @param {string} jobId     - for logging / temp naming
 * @returns {Promise<boolean|null>} true/false, or null when detection
 *   was not possible (no API key, extraction failed, Gemini error).
 */
async function detectBurnedCaptions(videoPath, jobId = 'fi') {
  const ratios = [0.2, 0.5, 0.8];
  const tmpFrames = [];
  try {
    const dur = await _probeDuration(videoPath);
    if (!dur) return null;

    for (const r of ratios) {
      const f = path.join(os.tmpdir(), `capdetect_${jobId}_${Math.round(r * 100)}_${Date.now()}.jpg`);
      await _extractFrame(videoPath, f, dur * r);
      if (fs.existsSync(f)) tmpFrames.push(f);
    }
    if (!tmpFrames.length) return null;

    const prompt = `These are ${tmpFrames.length} frames sampled from one vertical short-form video.

Question: does the FOOTAGE already contain burned-in subtitle/caption text — i.e. spoken-word transcription rendered over the video (karaoke-style word-by-word captions, subtitle lines, TikTok/CapCut style captions)?

IGNORE all of these — they are NOT captions:
- Chat overlays, donation/sub alerts, viewer counters, subathon timers
- Usernames, channel names, watermarks, logos
- Game UI / HUD text, scoreboards
- Channel branding or static title text

Answer for the video overall: if ANY frame shows burned-in spoken-word captions, the answer is true.

Return ONLY JSON: {"hasCaptions": <true|false>, "confidence": <0.0-1.0>, "evidence": "<one short phrase>"}`;

    const parsed = await _geminiVision(tmpFrames, prompt);
    if (!parsed || typeof parsed.hasCaptions !== 'boolean') return null;

    console.log(`[frame_intel:${jobId}] burned captions=${parsed.hasCaptions} (confidence=${parsed.confidence ?? '?'}, evidence=${parsed.evidence || 'n/a'})`);
    // Low-confidence "true" still counts — doubling captions is worse than missing ours.
    return parsed.hasCaptions;
  } catch (err) {
    console.warn(`[frame_intel:${jobId}] caption detection failed: ${err.message}`);
    return null;
  } finally {
    for (const f of tmpFrames) { try { fs.unlinkSync(f); } catch {} }
  }
}

// ─── Public: best thumbnail frame pick (CPD-938) ────────────────────────────

const THUMB_CANDIDATE_RATIOS = [0.15, 0.35, 0.55, 0.75];
const THUMB_FALLBACK_INDEX   = 1; // 35% in

/**
 * Extract candidate frames from the video, ask Gemini to pick the most
 * engaging one, and write the chosen frame at full resolution to outJpegPath.
 *
 * @param {string} videoPath   - local mp4 path
 * @param {string} outJpegPath - where to write the chosen full-res frame
 * @param {string} jobId       - for logging / temp naming
 * @returns {Promise<{ok: boolean, framePath?: string, seekRatio?: number, pickedBy?: string, error?: string}>}
 */
async function pickBestThumbnailFrame(videoPath, outJpegPath, jobId = 'fi') {
  const tmpFrames = [];
  try {
    const dur = await _probeDuration(videoPath);
    if (!dur) return { ok: false, error: 'could not probe video duration' };

    for (let i = 0; i < THUMB_CANDIDATE_RATIOS.length; i++) {
      const f = path.join(os.tmpdir(), `thumbpick_${jobId}_${i}_${Date.now()}.jpg`);
      await _extractFrame(videoPath, f, dur * THUMB_CANDIDATE_RATIOS[i]);
      if (fs.existsSync(f)) tmpFrames.push({ idx: i, path: f });
    }
    if (!tmpFrames.length) return { ok: false, error: 'frame extraction produced no frames' };

    let chosenIdx = null;
    let pickedBy  = 'fallback';
    try {
      const prompt = `These are ${tmpFrames.length} candidate frames (numbered 0 to ${tmpFrames.length - 1}, in order) from one vertical short-form video. One will be used as the video's thumbnail.

Pick the single most engaging frame for a thumbnail. Prefer:
- A clear human face with a strong expression (surprise, laughter, intensity)
- Visible action or a dramatic moment
- Sharp, well-lit, not mid-motion-blur, not a transition/black frame
- Reads well at small size

Return ONLY JSON: {"bestIndex": <0-${tmpFrames.length - 1}>, "reason": "<one short phrase>"}`;

      const parsed = await _geminiVision(tmpFrames.map(f => f.path), prompt);
      if (parsed && Number.isInteger(parsed.bestIndex) && parsed.bestIndex >= 0 && parsed.bestIndex < tmpFrames.length) {
        chosenIdx = parsed.bestIndex;
        pickedBy  = 'gemini';
        console.log(`[frame_intel:${jobId}] thumbnail frame #${chosenIdx} picked by Gemini (${parsed.reason || 'no reason'})`);
      }
    } catch (err) {
      console.warn(`[frame_intel:${jobId}] Gemini frame pick failed: ${err.message} — using fallback frame`);
    }

    if (chosenIdx === null) {
      chosenIdx = Math.min(THUMB_FALLBACK_INDEX, tmpFrames.length - 1);
      console.log(`[frame_intel:${jobId}] thumbnail frame #${chosenIdx} (fallback @ ${Math.round(THUMB_CANDIDATE_RATIOS[tmpFrames[chosenIdx].idx] * 100)}%)`);
    }

    // Re-extract the chosen frame at full resolution for the actual thumbnail.
    const ratio = THUMB_CANDIDATE_RATIOS[tmpFrames[chosenIdx].idx];
    await _extractFrame(videoPath, outJpegPath, dur * ratio, { width: 1080, quality: '2' });
    if (!fs.existsSync(outJpegPath)) return { ok: false, error: 'full-res frame extraction failed' };

    return { ok: true, framePath: outJpegPath, seekRatio: ratio, pickedBy };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    for (const f of tmpFrames) { try { fs.unlinkSync(f.path); } catch {} }
  }
}

module.exports = { detectBurnedCaptions, pickBestThumbnailFrame };
