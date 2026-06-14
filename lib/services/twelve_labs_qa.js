'use strict';
/**
 * lib/services/twelve_labs_qa.js — Twelve Labs Pegasus video QA gate
 *
 * Uses the Twelve Labs /v1.3/analyze synchronous endpoint (Pegasus 1.2) to
 * evaluate a completed output video URL against a structured QA rubric.
 * Returns a score (0-100) and pass/fail with issue breakdown.
 *
 * Requirements:
 *   TWELVE_LABS_API_KEY — API key from https://twelvelabs.io/dashboard
 *
 * Video must be a publicly accessible direct URL (R2 public URL or presigned URL).
 * Videos up to 1 hour are supported synchronously; longer videos time out and
 * return null (non-blocking).
 *
 * Jira: CPD-431 (FFmpeg + QA wiring sprint)
 */

const https = require('https');

const TL_API_KEY = process.env.TWELVE_LABS_API_KEY;
const TL_HOST    = 'api.twelvelabs.io';
const TL_PATH    = '/v1.3/analyze';
const TIMEOUT_MS = 180_000; // 3 min — Pegasus analysis of a short clip is usually <30s

const QA_PROMPT = `You are a video quality assurance reviewer for AuraFlux, an AI-powered video production platform.

Analyze this video and score it 0-100 for production quality. Evaluate these four areas (25 points each):

1. VISUAL QUALITY — no black frames, no freeze frames, correct aspect ratio, clean cuts, no encoding artifacts
2. AUDIO QUALITY — no silence gaps >2 seconds, normalized levels, clear speech if present, no clipping or distortion
3. PRODUCTION QUALITY — lower-third text is present and readable, brand logo visible in corner, smooth transitions, consistent framing
4. CONTENT QUALITY — engaging highlight moments selected, coherent narrative flow, appropriate length, no abrupt endings

Return ONLY a valid JSON object with exactly this shape (no markdown, no explanation, just JSON):
{
  "score": <integer 0-100>,
  "pass": <true if score >= 80, false otherwise>,
  "visual_score": <integer 0-25>,
  "audio_score": <integer 0-25>,
  "production_score": <integer 0-25>,
  "content_score": <integer 0-25>,
  "issues": [<string describing each specific defect found — empty array if none>],
  "summary": "<2-3 sentence quality assessment>"
}`;

/**
 * Analyze a completed output video via Twelve Labs Pegasus.
 *
 * @param {string} videoUrl  — public R2 URL of the output video
 * @param {string} [jobId]   — for log tagging only
 * @returns {Promise<{score,pass,visual_score,audio_score,production_score,content_score,issues,summary}|null>}
 *   Returns null if the API key is missing, the request times out, or parsing fails.
 *   Never throws — QA gate is non-blocking by design.
 */
async function analyzeVideo(videoUrl, jobId = '') {
  if (!TL_API_KEY) {
    console.warn('[twelve_labs_qa] TWELVE_LABS_API_KEY not set — skipping Twelve Labs QA');
    return null;
  }
  if (!videoUrl) {
    console.warn(`[twelve_labs_qa] ${jobId}: no videoUrl — skipping`);
    return null;
  }

  // CPD-922: API now requires video.type ('url' | 'asset_id' | 'base64_string')
  // and streams NDJSON by default — stream:false restores the single-JSON reply.
  // Production's copy predates this — C0 copy updated to the current v1.3 schema.
  const body = JSON.stringify({
    model_name: 'pegasus1.2',
    video:      { type: 'url', url: videoUrl },
    prompt:     QA_PROMPT,
    temperature: 0.1,
    stream:     false,
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[twelve_labs_qa] ${jobId}: timed out after ${TIMEOUT_MS / 1000}s — skipping`);
      req.destroy();
      resolve(null);
    }, TIMEOUT_MS);

    const req = https.request(
      {
        hostname: TL_HOST,
        path:     TL_PATH,
        method:   'POST',
        headers:  {
          'x-api-key':     TL_API_KEY,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(raw);
            // v1.3 /analyze returns { data: "<text>" } for Pegasus text generation
            const text = (typeof parsed.data === 'string') ? parsed.data : JSON.stringify(parsed);
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) {
              console.warn(`[twelve_labs_qa] ${jobId}: no JSON in response — raw: ${text.slice(0, 200)}`);
              resolve(null);
              return;
            }
            const qa = JSON.parse(match[0]);
            console.log(`[twelve_labs_qa] Job ${jobId}: score=${qa.score} pass=${qa.pass} issues=${qa.issues?.length ?? 0}`);
            resolve(qa);
          } catch (e) {
            console.warn(`[twelve_labs_qa] ${jobId}: parse error — ${e.message} — raw: ${raw.slice(0, 200)}`);
            resolve(null);
          }
        });
      },
    );

    req.on('error', (e) => {
      clearTimeout(timer);
      console.warn(`[twelve_labs_qa] ${jobId}: request error — ${e.message}`);
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

module.exports = { analyzeVideo };
