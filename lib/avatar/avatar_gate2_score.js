'use strict';
/**
 * Gemini side-by-side avatar QA — port of spike/cpd881/score_gate2.py.
 * Scores EchoMimic candidate vs HeyGen reference on Gate2 dimensions.
 */

const fs = require('fs');
const axios = require('axios');

const SCORE_PROMPT = `You are a video QA agent for an AI-avatar content pipeline. Video 1 is a candidate render from a self-hosted avatar engine (EchoMimicV3). Video 2 is the current production reference (HeyGen digital twin of the same presenter; it may include broadcast graphic overlays — ignore all overlays, captions, side panels and tickers, judge ONLY the presenter).

Score Video 1 on each dimension 0-10 (10 = indistinguishable from professionally filmed footage), and also score Video 2 on the same dimensions for calibration:

1. identity_preservation: does the person in Video 1 look like the same person as Video 2?
2. lip_sync: how accurately do mouth movements match the speech audio?
3. facial_realism: skin, eyes, teeth, micro-expressions — any uncanny artifacts?
4. motion_naturalness: head/body/hand motion plausibility, no warping or morphing
5. background_stability: background stays coherent and static, no shimmer/melt
6. overall_broadcast_ready: would this pass as a real presenter in a produced YouTube video?

Return STRICT JSON only:
{"video1": {"identity_preservation": n, "lip_sync": n, "facial_realism": n, "motion_naturalness": n, "background_stability": n, "overall_broadcast_ready": n},
 "video2": {same keys},
 "verdict": "one short paragraph: is video1 acceptable as a replacement for video2, and what is the biggest gap"}`;

async function uploadGeminiFile(apiKey, filePath) {
  const size = fs.statSync(filePath).size;
  const displayName = require('path').basename(filePath);
  const start = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
    { file: { display_name: displayName } },
    {
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': 'video/mp4',
        'Content-Type': 'application/json'
      }
    }
  );
  const uploadUrl = start.headers['x-goog-upload-url'];
  const finalize = await axios.post(uploadUrl, fs.readFileSync(filePath), {
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    maxBodyLength: Infinity
  });
  const name = finalize.data?.file?.name;
  if (!name) throw new Error('Gemini file upload did not return file name');
  for (let i = 0; i < 30; i++) {
    const st = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`
    );
    if (st.data?.state === 'ACTIVE') return st.data.uri;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Gemini file ${name} never became ACTIVE`);
}

async function scorePair(apiKey, candidatePath, referencePath) {
  const [uri1, uri2] = await Promise.all([
    uploadGeminiFile(apiKey, candidatePath),
    uploadGeminiFile(apiKey, referencePath)
  ]);
  const model = process.env.GEMINI_SCORE_MODEL || 'gemini-2.5-flash';
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents: [{
        parts: [
          { file_data: { mime_type: 'video/mp4', file_uri: uri1 } },
          { file_data: { mime_type: 'video/mp4', file_uri: uri2 } },
          { text: SCORE_PROMPT }
        ]
      }],
      generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
    },
    { timeout: 300000 }
  );
  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini score returned empty');
  return JSON.parse(text);
}

function summarizePassFail(results, passThreshold = 9) {
  const rows = [];
  let allPass = true;
  for (const [label, score] of Object.entries(results)) {
    if (score.error) {
      rows.push({ label, pass: false, error: score.error });
      allPass = false;
      continue;
    }
    const v1 = score.video1 || {};
    const br = v1.overall_broadcast_ready ?? 0;
    const pass = br >= passThreshold;
    if (!pass) allPass = false;
    rows.push({
      label,
      pass,
      overall_broadcast_ready: br,
      motion_naturalness: v1.motion_naturalness,
      facial_realism: v1.facial_realism,
      verdict: score.verdict
    });
  }
  return { allPass, rows };
}

module.exports = {
  SCORE_PROMPT,
  scorePair,
  summarizePassFail
};
