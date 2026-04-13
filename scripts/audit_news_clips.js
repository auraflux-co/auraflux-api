#!/usr/bin/env node
/**
 * audit_news_clips.js — single-purpose clip audit for a News long-form MP4.
 *
 * Usage: node scripts/audit_news_clips.js <path-to-mp4>
 *
 * Uploads the MP4 to Gemini Files API, asks one question ("which stories have
 * a clip playing vs which don't, with timestamps"), prints structured output.
 * Reuses the existing Gemini multipart upload pattern from server.js:6314.
 *
 * Purpose: Rob saw test #8 had "missing videos" in half the episode but
 * everything else looked fine. This script tells us WHICH stories lost their
 * clips and WHEN, so Cline can fix the specific code path.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY not set in .env');
  process.exit(1);
}

const mp4Path = process.argv[2];
if (!mp4Path) {
  console.error('Usage: node scripts/audit_news_clips.js <path-to-mp4>');
  process.exit(1);
}
if (!fs.existsSync(mp4Path)) {
  console.error(`File not found: ${mp4Path}`);
  process.exit(1);
}

const absPath = path.resolve(mp4Path);
const fileSize = (fs.statSync(absPath).size / 1024 / 1024).toFixed(1);
console.log(`[audit] Target: ${path.basename(absPath)} (${fileSize}MB)`);

async function uploadToGeminiFiles(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = 'audit_boundary_' + Date.now();
  const metadata = JSON.stringify({ file: { display_name: path.basename(filePath) } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  console.log(`[audit] Uploading to Gemini Files API...`);
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${GEMINI_API_KEY}`,
    body,
    {
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  );
  return resp.data.file;
}

async function waitForGeminiFile(file) {
  for (let i = 0; i < 30; i++) {
    if (file.state === 'ACTIVE') return file;
    await new Promise(r => setTimeout(r, 3000));
    const resp = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${GEMINI_API_KEY}`,
      { timeout: 10000 }
    );
    file = resp.data;
    console.log(`[audit] Gemini file state: ${file.state}`);
  }
  throw new Error('Gemini file stuck in PROCESSING state after 90 seconds');
}

const PROMPT = `You are auditing a ClipzWorld News long-form video for one specific issue: are all the source video clips present where they should be?

CONTEXT:
- This episode covers 5 news stories
- Each story follows this structure: STORY_INTRO (avatar Bobby G speaks) → STORY_SETUP (avatar continues) → SOURCE CLIP (non-avatar Al Jazeera footage plays full-screen) → STORY_SUMMARY (avatar recaps) → STORY_REACTION (avatar delivers one-line take)
- Bobby G is the AI avatar — a bearded man at a studio desk with bookshelves, a lamp, and a neon world map behind him
- A source clip is ANY full-screen footage where Bobby G is NOT visible (news footage, maps, animations, b-roll)
- There should be 5 source clips total, one per story
- Clips typically play for 10-30 seconds between SETUP and SUMMARY sections

WATCH THE VIDEO CAREFULLY FROM START TO FINISH.

Then output in EXACTLY this format, no preamble, no markdown headers:

STORY 1: [CLIP PRESENT or CLIP MISSING]
  Clip starts at: [MM:SS or "N/A"]
  Clip ends at: [MM:SS or "N/A"]
  Clip content: [one-sentence description of what the clip shows, or "N/A"]

STORY 2: [CLIP PRESENT or CLIP MISSING]
  Clip starts at: [MM:SS or "N/A"]
  Clip ends at: [MM:SS or "N/A"]
  Clip content: [one-sentence description or "N/A"]

STORY 3: [CLIP PRESENT or CLIP MISSING]
  Clip starts at: [MM:SS or "N/A"]
  Clip ends at: [MM:SS or "N/A"]
  Clip content: [one-sentence description or "N/A"]

STORY 4: [CLIP PRESENT or CLIP MISSING]
  Clip starts at: [MM:SS or "N/A"]
  Clip ends at: [MM:SS or "N/A"]
  Clip content: [one-sentence description or "N/A"]

STORY 5: [CLIP PRESENT or CLIP MISSING]
  Clip starts at: [MM:SS or "N/A"]
  Clip ends at: [MM:SS or "N/A"]
  Clip content: [one-sentence description or "N/A"]

TOTAL CLIPS FOUND: [number]
TOTAL CLIPS EXPECTED: 5

ADDITIONAL OBSERVATIONS:
[Any other clip-related issues: wrong aspect ratio, pillarbox bars, cut-off at start or end, red branding frame at the tail, audio cutting out, etc. Keep it to clip-related issues only. If none, say "none".]`;

async function askGemini(fileUri) {
  console.log(`[audit] Asking Gemini to audit clips...`);
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [
          { text: PROMPT },
          { file_data: { mime_type: 'video/mp4', file_uri: fileUri } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8000 }
    },
    { timeout: 300000, headers: { 'Content-Type': 'application/json' } }
  );
  return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
}

async function deleteGeminiFile(fileName) {
  try {
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`,
      { timeout: 10000 }
    );
  } catch (e) {
    console.warn(`[audit] Cleanup delete failed (non-critical): ${e.message}`);
  }
}

(async () => {
  let uploadedFile = null;
  try {
    uploadedFile = await uploadToGeminiFiles(absPath);
    console.log(`[audit] Uploaded: ${uploadedFile.name} (state: ${uploadedFile.state})`);
    const activeFile = await waitForGeminiFile(uploadedFile);
    console.log(`[audit] File active, running audit...`);
    const result = await askGemini(activeFile.uri);
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  GEMINI CLIP AUDIT REPORT');
    console.log(`  Video: ${path.basename(absPath)}`);
    console.log(`  Time:  ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log(result);
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
  } catch (e) {
    console.error(`[audit] FAILED: ${e.message}`);
    if (e.response?.data) {
      console.error(`[audit] API error detail:`, JSON.stringify(e.response.data, null, 2).slice(0, 1000));
    }
    process.exit(1);
  } finally {
    if (uploadedFile?.name) {
      await deleteGeminiFile(uploadedFile.name);
    }
  }
})();
