#!/usr/bin/env node
// scripts/measure_bobby_g.js
//
// One-shot visual measurement tool. Sends an image to Gemini 2.5 Flash and asks
// it to return pixel-accurate bounding boxes for Bobby G + a recommended TV-card
// placement that sits *next to* his head (not over him), with breathing room.
//
// Usage:
//   node scripts/measure_bobby_g.js <image-path-or-url>
//
// Examples:
//   node scripts/measure_bobby_g.js "/Users/robertgregory/Desktop/Screenshot 2026-04-11 at 7.03.48 PM.png"
//   node scripts/measure_bobby_g.js output/some_assembled_video_thumb.jpg
//   node scripts/measure_bobby_g.js https://drive.google.com/uc?export=download&id=...
//
// What it returns (stdout JSON):
//   {
//     frame:           { w: 1920, h: 1080 },
//     person:          { head: {x,y,w,h}, shoulders: {left,right,top_y} },
//     existing_overlay_collision: { present: bool, description: string },
//     recommended_overlay: { x, y, w, h, rationale: string },
//     notes: string
//   }
//
// Non-production. Does not commit anything. Does not touch any config. You read
// the output and decide what to change.

'use strict';

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not set in .env');
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/measure_bobby_g.js <image-path-or-url>');
  process.exit(1);
}

// ── Load image as base64 ─────────────────────────────────────────
async function loadImageBase64(src) {
  if (/^https?:\/\//i.test(src)) {
    const r = await axios.get(src, { responseType: 'arraybuffer', timeout: 15000 });
    const mime = (r.headers['content-type'] || 'image/png').split(';')[0];
    return { b64: Buffer.from(r.data).toString('base64'), mime };
  }
  if (!fs.existsSync(src)) {
    throw new Error(`File not found: ${src}`);
  }
  const buf = fs.readFileSync(src);
  const ext = path.extname(src).slice(1).toLowerCase();
  const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
  const mime = mimeMap[ext] || 'image/png';
  return { b64: buf.toString('base64'), mime };
}

// ── Prompt — the actual ask ──────────────────────────────────────
const PROMPT = `Image is 1920x1080. Measure pixel coordinates of the man (head, shoulders, hands) and output JSON ONLY in this exact schema:

{
  "frame": {"w": 1920, "h": 1080},
  "person": {
    "head": {"x": 0, "y": 0, "w": 0, "h": 0},
    "shoulders": {"left_edge": 0, "right_edge": 0, "top_y": 0},
    "hands": {"x": 0, "y": 0, "w": 0, "h": 0}
  },
  "existing_overlay": {"x": 0, "y": 0, "w": 0, "h": 0, "collides": false},
  "recommended_overlay": {"x": 0, "y": 0, "w": 0, "h": 0, "note": ""}
}

Constraints for recommended_overlay:
- Largest 16:9 rectangle (w/h = 1.7778) that satisfies ALL of:
- Does NOT overlap person.head, person.shoulders, person.hands
- y >= 60 (top padding from frame top)
- x+w <= 1890 (right margin at least 30px from frame right edge 1920)
- Positioned next to head on viewer's right side
- note field: one short sentence explaining the chosen size

If no existing overlay visible, set existing_overlay to null.
Output only the JSON object. No prose. No markdown.`;

// ── Call Gemini ──────────────────────────────────────────────────
async function measure() {
  console.log(`[measure] Loading image: ${arg}`);
  const { b64, mime } = await loadImageBase64(arg);
  console.log(`[measure] Loaded (${(b64.length * 0.75 / 1024).toFixed(0)}KB, ${mime})`);
  console.log(`[measure] Calling ${GEMINI_MODEL}...`);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mime, data: b64 } }
      ]
    }],
    generationConfig: {
      maxOutputTokens: 8000,
      temperature: 0.1,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  const resp = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 45000
  });

  const raw = (resp.data?.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  if (!raw) {
    console.error('[measure] Empty response from Gemini');
    console.error('[measure] Full response:', JSON.stringify(resp.data, null, 2));
    process.exit(2);
  }

  // Strip possible markdown fences even though prompt says no markdown
  const clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('[measure] Could not parse Gemini response as JSON.');
    console.error('[measure] Raw response:\n' + raw);
    process.exit(3);
  }

  // ── Pretty print ────────────────────────────────────────────────
  console.log('\n── MEASUREMENT RESULT ──────────────────────────────────');
  console.log(JSON.stringify(parsed, null, 2));
  console.log('──────────────────────────────────────────────────────\n');

  // ── Derived summary ─────────────────────────────────────────────
  if (parsed.recommended_overlay) {
    const r = parsed.recommended_overlay;
    const ratio = (r.w / r.h).toFixed(4);
    console.log('📐 RECOMMENDED OVERLAY_ZONE update:');
    console.log(`   OVERLAY_ZONE: { x: ${r.x}, y: ${r.y}, w: ${r.w}, h: ${r.h} }`);
    console.log(`   Aspect:       ${ratio} (should be 1.7778)`);
    console.log(`   Right edge:   ${r.x + r.w} (${1920 - (r.x + r.w)}px right margin)`);
    console.log(`   Top edge:     ${r.y} (${r.y}px top padding)`);
    console.log(`   Bottom edge:  ${r.y + r.h}`);
    if (r.note) console.log(`   Note:         ${r.note}`);
  }

  if (parsed.existing_overlay && parsed.existing_overlay.collides) {
    console.log('\n⚠️  COLLISION DETECTED on existing overlay:');
    console.log(`   ${JSON.stringify(parsed.existing_overlay)}`);
  }
}

measure().catch(e => {
  console.error('[measure] Failed:', e.message);
  if (e.response?.data) console.error('[measure] API response:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
