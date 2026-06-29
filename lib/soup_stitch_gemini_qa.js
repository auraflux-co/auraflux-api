'use strict';

/**
 * Gemini multimodal QA for Twitch Soup streamer-block stitch boundaries.
 * Extra layer on top of VMAF/jump metrics — catches audio pops, ghosting, crowd bleed.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('./qa');
const { extractJsonObject, parseJsonLoose } = require('./gemini_json_parse');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PASS_SCORE = Number(process.env.SOUP_STITCH_GEMINI_PASS_SCORE) || 72;

function joinTypeHint(fromLabel, toLabel, policyName) {
  if (/_CLIP2_REACTION$/i.test(fromLabel || '') && /_INTRO$/i.test(toLabel || '')) {
    return 'CLIP2_REACTION→NEXT_STREAMER_INTRO: hold-cut handoff — last frame freeze, hard video cut, new streamer fades in. Flag ANY video ghost, double-image, or stipple blend between studios.';
  }
  if (/_CLIP1_REACTION$/i.test(fromLabel || '') && /_CLIP2_SETUP$/i.test(toLabel || '')) {
    return 'CLIP1_REACTION→CLIP2_SETUP: scene-reset hold-cut (same as intro→setup). NO video xfade between HeyGen poses. Flag ghost, stipple, pose_jump.';
  }
  if (policyName === 'hold_cut') {
    return 'Scene-reset join: brief hold, outgoing video dips to black, then hard cut to new pose at full brightness. NO fade-in from black on incoming (that flashes). Flag white flash, double-image, or unsynced cut.';
  }
  if (policyName === 'cut') {
    return 'CLIP→REACTION hard cut: expect instant switch from gameplay to avatar. Flag flash, black frame, or audio click — NOT gradual blend.';
  }
  if (policyName === 'xfade') {
    return 'Avatar→clip or setup→clip: short crossfade between studio and gameplay is OK. Flag only if transition is visibly broken.';
  }
  return 'General avatar dialogue join — flag video ghosting, stipple, or audio pop at the join center.';
}

function buildJoinPrompt({ from, to, policyName, atSec }) {
  const hint = joinTypeHint(from, to, policyName);
  return `You are QA for Twitch Soup long-form video STITCH BOUNDARIES (HeyGen avatar + Twitch clips).

You will watch a ~6 second clip centered on ONE join between two segments.

JOIN: ${from} → ${to}
STITCH POLICY: ${policyName}
APPROX TIMESTAMP IN BLOCK: ${atSec != null ? `${atSec.toFixed(1)}s` : 'unknown'}

CONTEXT:
${hint}

SCORING (be strict on VIDEO at the join — double-image and pose jumps fail):
- 90-100: invisible join, broadcast smooth
- 72-89: minor imperfection, acceptable for publish
- 50-71: noticeable blip — operator should review
- 0-49: clear defect (ghost, pop, wrong frame blend)

Return ONLY valid JSON (no markdown):
{
  "smoothness_score": 0-100,
  "pass": true if score >= ${PASS_SCORE} and no critical defect,
  "video_issues": ["ghost"|"stipple"|"pose_jump"|"flash"|"hold_too_long"|"none"],
  "audio_issues": ["pop"|"crowd_bleed"|"level_jump"|"clip"|"none"],
  "join_center_feel": "smooth"|"blip"|"hard_cut"|"muddy_blend",
  "summary": "one sentence",
  "recommendation": "keep_policy"|"extend_audio_fade"|"shorten_video_xfade"|"hard_cut_video"|"fix_crowd_tail"|"investigate_heygen_scene"
}`;
}

function salvagePartialJoinResponse(raw) {
  const score = parseInt((raw.match(/smoothness_score["\s:]+(\d+)/i) || [])[1] || '0', 10);
  if (!score) return null;
  const feel = ((raw.match(/join_center_feel["\s:]+"([^"]+)"/i) || [])[1] || 'unknown').toLowerCase();
  const rec = ((raw.match(/recommendation["\s:]+"([^"]+)"/i) || [])[1] || 'keep_policy').toLowerCase();
  const summary = ((raw.match(/summary["\s:]+"([^"]*)/i) || [])[1] || '').trim().slice(0, 400);
  const videoIssues = [];
  const audioIssues = [];
  for (const tag of ['ghost', 'stipple', 'pose_jump', 'flash', 'hold_too_long']) {
    if (new RegExp(`"${tag}"`, 'i').test(raw)) videoIssues.push(tag);
  }
  for (const tag of ['pop', 'crowd_bleed', 'level_jump', 'clip']) {
    if (new RegExp(`"${tag}"`, 'i').test(raw)) audioIssues.push(tag);
  }
  if (!videoIssues.length) videoIssues.push('none');
  if (!audioIssues.length) audioIssues.push('none');
  const criticalVideo = videoIssues.some((v) => ['ghost', 'stipple', 'flash'].includes(v));
  const pass = score >= PASS_SCORE && !criticalVideo && !audioIssues.includes('pop');
  return {
    smoothness_score: score,
    pass,
    video_issues: videoIssues,
    audio_issues: audioIssues,
    join_center_feel: feel,
    summary: summary || `Score ${score} (partial Gemini response)`,
    recommendation: rec,
    raw,
    partial: true,
  };
}

function parseJoinQaResponse(raw) {
  const fallback = {
    smoothness_score: 0,
    pass: false,
    video_issues: ['parse_error'],
    audio_issues: ['parse_error'],
    join_center_feel: 'unknown',
    summary: 'Gemini response parse failed',
    recommendation: 'investigate_heygen_scene',
    raw,
  };
  try {
    const jsonStr = extractJsonObject(raw) || raw;
    const obj = parseJsonLoose(jsonStr) || JSON.parse(jsonStr);
    const score = Number(obj.smoothness_score) || 0;
    const videoIssues = Array.isArray(obj.video_issues) ? obj.video_issues : [];
    const audioIssues = Array.isArray(obj.audio_issues) ? obj.audio_issues : [];
    const criticalVideo = videoIssues.some((v) => ['ghost', 'stipple', 'flash'].includes(v));
    const pass = obj.pass !== false && score >= PASS_SCORE && !criticalVideo && !audioIssues.includes('pop');
    return {
      smoothness_score: score,
      pass,
      video_issues: videoIssues,
      audio_issues: audioIssues,
      join_center_feel: obj.join_center_feel || 'unknown',
      summary: String(obj.summary || '').slice(0, 400),
      recommendation: obj.recommendation || 'keep_policy',
      raw,
    };
  } catch (_e) {
    return salvagePartialJoinResponse(raw) || fallback;
  }
}

async function qaJoinClipWithGemini(clipPath, joinMeta, { log = console.log } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { pass: false, smoothness_score: 0, summary: 'GEMINI_API_KEY not set', error: 'no_api_key' };
  }
  if (!clipPath || !fs.existsSync(clipPath)) {
    return { pass: false, smoothness_score: 0, summary: 'clip missing', error: 'missing_clip' };
  }

  const uploaded = [];
  let geminiFile = null;
  try {
    const sizeMb = (fs.statSync(clipPath).size / 1024 / 1024).toFixed(2);
    log(`  [gemini-stitch-qa] upload ${path.basename(clipPath)} (${sizeMb}MB)`);
    geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(clipPath));
    uploaded.push(geminiFile);

    const prompt = buildJoinPrompt({
      from: joinMeta.from,
      to: joinMeta.to,
      policyName: joinMeta.policyName || joinMeta.policy?.mode || 'unknown',
      atSec: joinMeta.atSec,
    });

    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            { text: prompt },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } },
          ],
        }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
      },
      { timeout: 120000 },
    );

    const raw = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    const parsed = parseJoinQaResponse(raw);
    log(`  [gemini-stitch-qa] ${joinMeta.from}→${joinMeta.to}: ${parsed.pass ? 'PASS' : 'FAIL'} ${parsed.smoothness_score} — ${parsed.summary}`);
    return { ...parsed, from: joinMeta.from, to: joinMeta.to, clip: clipPath };
  } catch (e) {
    log(`  [gemini-stitch-qa] error: ${e.message.slice(0, 120)}`);
    return {
      pass: false,
      smoothness_score: 0,
      summary: e.message.slice(0, 200),
      error: 'gemini_error',
      from: joinMeta.from,
      to: joinMeta.to,
      clip: clipPath,
    };
  } finally {
    for (const f of uploaded) {
      try { await deleteGeminiFile(f.name); } catch (_) { /* non-fatal */ }
    }
  }
}

/**
 * Run Gemini QA on all joins from stitch_streamer_block block_report.json
 */
async function qaStreamerBlockReport(reportPath, { log = console.log, joinFilter = null } = {}) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const joins = (report.joins || []).filter((j) => {
    if (!joinFilter) return true;
    return joinFilter(j);
  });

  const results = [];
  for (const j of joins) {
    const qa = await qaJoinClipWithGemini(j.clip, j, { log });
    results.push({ ...j, gemini: qa });
  }

  const passed = results.filter((r) => r.gemini?.pass).length;
  const failed = results.length - passed;
  const summary = {
    streamer: report.streamer,
    asmId: report.asmId,
    blockMp4: report.blockMp4,
    reviewedAt: new Date().toISOString(),
    passScoreThreshold: PASS_SCORE,
    total: results.length,
    passed,
    failed,
    overallPass: failed === 0,
    results,
  };

  const outPath = reportPath.replace(/block_report\.json$/, 'gemini_qa_report.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  const mdPath = reportPath.replace(/block_report\.json$/, 'gemini_qa_report.md');
  fs.writeFileSync(mdPath, [
    `# Gemini stitch QA — ${report.streamer} block`,
    '',
    `**Overall:** ${summary.overallPass ? 'PASS' : 'FAIL'} (${passed}/${results.length} joins ≥ ${PASS_SCORE})`,
    `**Block:** \`${report.blockMp4}\``,
    '',
    '| Join | Policy | Score | Pass | Feel | Recommendation |',
    '|------|--------|-------|------|------|----------------|',
    ...results.map((r) => {
      const g = r.gemini || {};
      return `| ${r.from} → ${r.to} | ${r.policyName} | ${g.smoothness_score ?? '—'} | ${g.pass ? '✓' : '✗'} | ${g.join_center_feel || '—'} | ${g.recommendation || '—'} |`;
    }),
    '',
    '## Details',
    ...results.map((r) => `- **${r.from} → ${r.to}:** ${r.gemini?.summary || '(no summary)'}`),
  ].join('\n'));

  log(`\n[gemini-stitch-qa] ${passed}/${results.length} passed → ${outPath}`);
  return summary;
}

module.exports = {
  PASS_SCORE,
  joinTypeHint,
  buildJoinPrompt,
  parseJoinQaResponse,
  qaJoinClipWithGemini,
  qaStreamerBlockReport,
};
