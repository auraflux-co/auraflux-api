'use strict';
/**
 * Gemini QA for studio laugh / crowd bed audio clips.
 * Auto-extracted Soup clips must pass before assembly uses them.
 * Operator-curated clips in assets/audio/studio_laugh/operator/ skip QA (trusted).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function readAudioBase64(filePath) {
  const buf = fs.readFileSync(filePath);
  return buf.toString('base64');
}

/**
 * @returns {Promise<{ pass: boolean, score: number, category: string, reason: string, raw?: string }>}
 */
async function qaLaughClipFile(filePath, { log = () => {} } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { pass: false, score: 0, category: 'error', reason: 'GEMINI_API_KEY not set — cannot QA laugh clip' };
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return { pass: false, score: 0, category: 'error', reason: 'file missing' };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
  const b64 = readAudioBase64(filePath);
  const name = path.basename(filePath);

  const prompt = `You are QA for Talk Soup / Twitch Soup studio audience audio.

Listen to this audio clip. We need CLEAN studio audience laugh bursts for TV-style reaction inserts — NOT cold-open ambience beds (those are separate files).

PASS only if ALL are true:
- Primary content is audience laughter (chuckle, laugh, applause-laugh mix typical of studio sitcom/talk show)
- No host speaking words (brief crowd noise under a laugh is OK)
- No music sting or theme music dominating the clip
- No long silence padding before/after the laugh (tight trim preferred)

FAIL if:
- Host dialogue or announcer VO is audible and dominant
- Mostly music, SFX, or non-laugh crowd noise
- Applause-only with no actual laugh energy
- Clip is mostly silence or room tone

Reply EXACTLY in this format:
CATEGORY: [clean_laugh | host_bleed | music_sting | applause_only | silence | mixed_other]
SCORE: [0-100 how suitable as a tight studio laugh insert]
PASS: [yes | no]
REASON: [one sentence]`;

  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: b64 } },
          ],
        }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.1 },
      },
      { timeout: 90000 },
    );

    const raw = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    const pass = /\bPASS:\s*yes\b/i.test(raw);
    const score = parseInt((raw.match(/SCORE:\s*(\d+)/i) || [])[1] || '0', 10);
    const category = ((raw.match(/CATEGORY:\s*(\S+)/i) || [])[1] || 'unknown').toLowerCase();
    const reason = ((raw.match(/REASON:\s*(.+)/i) || [])[1] || raw).trim().slice(0, 300);
    log(`  ${pass ? '✅' : '❌'} ${name}: ${category} (${score}) — ${reason}`);
    return { pass, score, category, reason, raw };
  } catch (e) {
    return { pass: false, score: 0, category: 'error', reason: e.message.slice(0, 200) };
  }
}

/**
 * QA all auto-extracted clips in manifest; operator clips marked approved without Gemini.
 */
async function qaLaughLibrary({ force = false, log = console.log } = {}) {
  const { LAUGH_LIBRARY_DIR, LAUGH_MANIFEST_PATH, OPERATOR_DIR, OPERATOR_SEGMENT_DIR } = require('./studio_laughter');
  const manifestPath = LAUGH_MANIFEST_PATH;
  let manifest = { clips: [], operatorClips: [] };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { /* fresh */ }
  }

  const updated = [];
  for (const clip of (manifest.clips || [])) {
    const fp = path.join(LAUGH_LIBRARY_DIR, clip.file);
    if (!fs.existsSync(fp)) continue;
    if (clip.qaPass === true && !force) {
      updated.push(clip);
      continue;
    }
    log(`[laugh-qa] Checking ${clip.file}...`);
    const qa = await qaLaughClipFile(fp, { log });
    updated.push({
      ...clip,
      qaPass: qa.pass,
      qaScore: qa.score,
      qaCategory: qa.category,
      qaReason: qa.reason,
      qaAt: new Date().toISOString(),
    });
  }
  manifest.clips = updated;

  const opDir = fs.existsSync(OPERATOR_SEGMENT_DIR) ? OPERATOR_SEGMENT_DIR : OPERATOR_DIR;
  manifest.operatorClips = [];
  if (fs.existsSync(opDir)) {
    for (const f of fs.readdirSync(opDir)) {
      if (!/\.(mp3|m4a|wav|aac)$/i.test(f)) continue;
      if (/^opening_crowd_bed/i.test(f)) continue;
      manifest.operatorClips.push({
        file: f,
        path: path.join(opDir, f),
        source: 'operator',
        qaPass: true,
        qaReason: 'operator-curated — trusted without Gemini',
        approvedAt: new Date().toISOString(),
      });
    }
  }

  manifest.qaRunAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const passCount = updated.filter((c) => c.qaPass).length + (manifest.operatorClips?.length || 0);
  log(`[laugh-qa] Done — ${passCount} usable clips (${updated.filter((c) => c.qaPass).length} auto + ${manifest.operatorClips.length} operator)`);
  return { ok: passCount > 0, passCount, manifest };
}

module.exports = { qaLaughClipFile, qaLaughLibrary };
