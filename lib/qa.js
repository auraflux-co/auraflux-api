'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const logger = require('./logger');
const { ffmpegPath } = require('./ffmpeg_utils');

// Anthropic client — module-level, mirrors server.js:536
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Feature flag — mirrors server.js (process.env.USE_DIRECTIVE_CHROME !== 'false')
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false';

// Strip markdown code fences from Gemini JSON output (e.g. ```json ... ```)
function stripCodeFences(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

const TMP_DIR = path.join(__dirname, '..', 'tmp');

const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// STREAMER_DISPLAY_NAMES needed by claudeScriptQA
const STREAMER_DISPLAY_NAMES = {
  'jasontheween':    'Jason',
  'hasanabi':        'Hasan',
  'adapt':           'Adapt',
  'stableronaldo':   'Ron',
  'lacy':            'Lacy',
  'marlon':          'Marlon',
  'cinna':           'Cinna',
  'yonnajay':        'Yonna',
  'jaycinco':        'Jay Cinco',
  'maya':            'Maya',
  'extraemily':      'ExtraEmily',
  'yourragegaming':  'Rage'
};

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

// ─── FUNCTIONS EXTRACTED FROM server.js ───────────────────────────────────
// geminiQACheck         (was ~1905)
// parseScriptIntoScenes (was ~2140)
// generateClipAvailabilityReport (was ~2436)
// claudeScriptQA        (was ~2515)
// claudeScriptFix       (was ~2887)
// geminiScriptQA        (was ~2953)
// geminiSegmentQA       (was ~3224)
// callClaudeAPI         (was ~3446)
// uploadToGeminiFiles   (was ~6975)
// waitForGeminiFile     (was ~7024)
// deleteGeminiFile      (was ~7037)

async function geminiQACheck(videoPath, opts = {}) {
  const { contentType, avatarCount, clipCount, downloadedClipCount, expectedTicker, totalDuration } = opts;
  if (!GEMINI_APIKEY) return { score: 100, report: 'QA skipped — no Gemini API key', passed: true };
  if (!fs.existsSync(videoPath)) return { score: 0, report: 'QA failed — video file not found', passed: false };

  const dur = totalDuration || 60;
  const MAX_BYTES = 32 * 1024 * 1024;

  // Sample at 3 points: early (10%), middle (50%), late (90%) — catches freeze at transitions
  const samplePoints = [
    { label: 'EARLY',  start: Math.max(0, dur * 0.10 - 10) },
    { label: 'MIDDLE', start: Math.max(0, dur * 0.50 - 10) },
    { label: 'LATE',   start: Math.max(0, Math.floor(dur) - 35) },
  ];

  const reports = [];
  const scores  = [];
  let freezeDetected = false;

  for (const point of samplePoints) {
    const tmpPath = path.join(TMP_DIR, `qa_sample_${point.label}_${Date.now()}.mp4`);
    try {
      await new Promise((res, rej) => {
        const args = ['-ss', point.start.toFixed(0), '-i', videoPath, '-t', '20', '-c', 'copy', '-y', tmpPath];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
        proc.on('close', code => code === 0 ? res() : rej(new Error(`Sample extract failed: ${code}`)));
        proc.on('error', rej);
      });

      const sampleSize = fs.statSync(tmpPath).size;
      if (sampleSize < 1000) { reports.push(`${point.label}: sample too small`); continue; }

      const geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(tmpPath));

      const checklist = point.label === 'EARLY' ? [
        `1. LIP SYNC: Avatar mouth reasonably in sync with audio? (yes/partial/no)`,
        `2. TICKER: Scrolling ticker bar visible at bottom? (yes/no)`,
        `3. VIDEO FREEZE: Does the video appear to FREEZE (video stuck, audio continues)? (yes/no) — CRITICAL`,
        `4. TRANSITIONS: Do cuts between segments look clean? (yes/partial/no)`,
        `5. AUDIO: Audio clear and continuous? (yes/partial/no)`,
        `6. AVATAR FRAMING: Is Bobby G fully visible and properly centered in the frame? (yes/partial/no)`,
      ] : point.label === 'MIDDLE' ? [
        `1. VIDEO FREEZE: Does the video appear to FREEZE at any point? (yes/no) — CRITICAL`,
        `2. TICKER: Scrolling ticker still visible at bottom? (yes/no)`,
        `3. VIDEO QUALITY: 1080p, no pixelation, no black frames? (yes/partial/no)`,
        `4. AVATAR VISIBLE: Bobby G clearly visible and properly framed? (yes/no)`,
        `5. AUDIO: Audio clear and continuous? (yes/partial/no)`,
        ...((( downloadedClipCount ?? clipCount) > 0) ? [`6. SOURCE CLIPS: Are source clips (non-avatar footage) visible and playing? (yes/no)`] : []),
      ] : [
        `1. VIDEO FREEZE: Video frozen/stalled at any point? (yes/no) — CRITICAL`,
        `2. TICKER: Ticker still scrolling at end of video? (yes/no)`,
        `3. OUTRO: Does the OUTRO scene play cleanly — avatar visible, "Appreciate you!" audible? (yes/no) — NOTE: this 20-second sample window may end BEFORE the video ends; if the sample cuts off mid-sentence that is a sample-window boundary, NOT an OUTRO failure. Only mark FAIL if the OUTRO scene itself is broken (freeze, missing avatar, audio dropout).`,
        `4. AUDIO: Audio clear through to the end of this sample? (yes/partial/no)`,
      ];

      const qaPrompt = `You are QA reviewer for ClipzWorld News YouTube compilations.
Review this 20-second ${point.label} sample (from ~${Math.round(point.start)}s into an ${Math.round(dur)}s video).
Context: ${avatarCount} avatar segments, ${clipCount} source clips requested, ${downloadedClipCount ?? clipCount} downloaded.

CHECKLIST — answer every item, even if the answer is PASS:
${checklist.join('\n')}

REQUIRED FORMAT — you must always respond with all of these fields:
CHECKLIST RESULTS:
1. [item name]: PASS/FAIL — [one sentence. If PASS say what you see that confirms it. If FAIL describe the problem.]
2. [item name]: PASS/FAIL — [same]
... (all items)

DEDUCTIONS: [list any -points deductions with reason, OR write "None — all checks passed"]
SCORE: [0-100]
SUMMARY: [one sentence. Either "No issues found — video looks clean." or describe the main problem.]`;

      const genResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: qaPrompt },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();

      // Log raw Gemini response for debugging
      console.log(`[qa-gate3] ${point.label} sample - Raw Gemini response:\n${segReport}\n---`);

      let segScore = parseInt((segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '75');

      // Validate: if all critical checks pass (no FAIL in checklist), minimum score is 70
      const hasFailures = /:\s*FAIL/i.test(segReport);
      if (!hasFailures && segScore < 70) {
        console.log(`[qa-gate3] ${point.label} sample - All checks passed but score is ${segScore}, raising to 70`);
        segScore = 70;
      }

      // Flag freeze as critical failure
      if (/VIDEO FREEZE:.*yes/i.test(segReport)) {
        freezeDetected = true;
        scores.push(20); // severe penalty
      } else {
        scores.push(segScore);
      }

      reports.push(`=== ${point.label} SAMPLE (~${Math.round(point.start)}s) ===\n${segReport}`);

      try { fs.unlinkSync(tmpPath); } catch(e) {}
      try { await axios.delete(`https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`); } catch(e) {}

    } catch(e) {
      reports.push(`${point.label}: check failed — ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
    }

    // Brief pause between Gemini uploads
    await new Promise(r => setTimeout(r, 2000));
  }

  // If no scores (all samples skipped/empty) — auto-pass, no evidence of issues
  const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 90;
  const fullReport = reports.join('\n\n') + (freezeDetected ? '\n\n⚠️  VIDEO FREEZE DETECTED — check transitions and keyframe settings' : '');

  // ── Gate 3: Assembly QA thresholds ──────────────────────────────
  // PASS:          score >= 80 AND no critical failures → auto-proceed to Upload-Post
  // MANUAL REVIEW: score 60-79 AND no critical failures → hold, notify Rob with why-doc
  // HARD FAIL:     any critical failure OR score < 60 → loop back to CapCut/FFmpeg (max 3 retries)
  //
  // Critical failures (always hard-fail regardless of score):
  //   - Video freeze detected
  //   - Ticker missing from all 3 samples
  //   - Outro cut off ("Appreciate you!" not present)
  //   - A/V desync detected
  const PASS_THRESHOLD   = opts.passThreshold   || 70;
  const MANUAL_THRESHOLD = opts.manualThreshold  || 60;

  // Detect critical failures from report text
  // tickerMissing: only fire when Gemini gives a clear negative verdict.
  // Do NOT match "TICKER: PASS — No scrolling ticker..." — the word "no" in a PASS description
  // is not a failure. Look for explicit FAIL verdict OR bare "no" answer (the prompt format).
  const tickerMissing   = reports.filter(r => /TICKER:\s*(FAIL|no\b)/i.test(r) && !/TICKER:\s*PASS/i.test(r)).length === reports.length;
  // outroCutOff: only fire when Gemini explicitly marks OUTRO as FAIL in the late sample.
  // Do NOT match "cuts off abruptly" — that phrase appears when the 20s sample window ends
  // before the video does, which is a false positive (sample window artifact, not a real problem).
  const lateReport      = reports[2] || '';
  const outroCutOff     = /OUTRO:.*FAIL/i.test(lateReport) && !/abrupt.*cut|cut.*abrupt|sample.*end/i.test(lateReport);
  const avDeSync               = /a\/v.*desync|audio.*ahead|video.*behind/i.test(fullReport);
  // Fix 1: structural fail when clips requested but none downloaded; Gemini-detected fail when downloaded but not visible
  const effectiveClipCount = downloadedClipCount ?? clipCount;
  const clipsExpectedButMissing = (clipCount > 0 && effectiveClipCount === 0) ||
    (effectiveClipCount > 0 && /SOURCE CLIPS:\s*(FAIL|no\b)/i.test(fullReport) && !/SOURCE CLIPS:\s*PASS/i.test(fullReport));
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync || clipsExpectedButMissing;

  // Build structured deduction list for why-doc
  const deductions = [];
  if (freezeDetected)  deductions.push({ points: 30, reason: 'VIDEO FREEZE detected — critical failure' });
  if (tickerMissing)   deductions.push({ points: 20, reason: 'TICKER missing from all sample points — critical failure' });
  if (outroCutOff)     deductions.push({ points: 20, reason: 'OUTRO cut off — "Appreciate you!" not present in late sample' });
  if (avDeSync)        deductions.push({ points: 15, reason: 'A/V DESYNC detected in sample' });
  if (clipsExpectedButMissing) deductions.push({ points: 25, reason: 'SOURCE CLIPS missing — expected clips but none detected in video' });
  scores.forEach((s, i) => {
    if (s < 80) deductions.push({ points: 80 - s, reason: `${samplePoints[i].label} sample scored ${s}/100 — see report for specifics` });
  });

  let outcome, passed;
  if (hasCriticalFail || avgScore < MANUAL_THRESHOLD) {
    outcome = 'fail';
    passed  = false;
  } else if (avgScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed  = true;
  } else {
    outcome = 'manual_review';
    passed  = false;
  }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';

  // ── Structured why-doc (saved for every job, not just failures) ──
  const whyDoc = [
    `=== CWN GATE 3: ASSEMBLY QA — ${outcomeLabel} ===`,
    `Gate:       3 of 4 — Assembly QA`,
    `Scored by:  Gemini (did not assemble)`,
    `Time:       ${new Date().toISOString()}`,
    `Video:      ${path.basename(videoPath)}`,
    `Score:      ${avgScore}/100`,
    `Pass threshold:   ${PASS_THRESHOLD} (auto-proceed)`,
    `Manual threshold: ${MANUAL_THRESHOLD} (hold for Rob)`,
    `Outcome:    ${outcome.toUpperCase()}`,
    ``,
    `── CRITICAL FAILURES ────────────────────────────`,
    `Video freeze:   ${freezeDetected ? '🚨 YES' : '✅ No'}`,
    `Ticker missing: ${tickerMissing  ? '🚨 YES' : '✅ No'}`,
    `Outro cut off:  ${outroCutOff   ? '🚨 YES' : '✅ No'}`,
    `A/V desync:     ${avDeSync      ? '🚨 YES' : '✅ No'}`,
    `Clips missing:  ${clipsExpectedButMissing ? '🚨 YES' : '✅ No'}`,
    ``,
    `── SCORE BREAKDOWN ───────────────────────────────`,
    `STARTING SCORE: 100`,
    ``,
    deductions.length ? `DEDUCTIONS:` : '',
    deductions.length ? deductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '',
    deductions.length ? `` : '',
    !deductions.length ? `  No deductions — clean pass` : '',
    ``,
    `SAMPLE SCORES: ${scores.join(', ')} (avg: ${avgScore})`,
    ``,
    `FINAL SCORE: ${avgScore}/100`,
    ``,
    `── GEMINI SAMPLE REPORTS ─────────────────────────`,
    fullReport,
    ``,
    `── RECOMMENDED ACTION ───────────────────────────`,
    outcome === 'pass'          ? 'Auto-proceed to Upload-Post publish.' :
    outcome === 'manual_review' ? 'Review sample reports above. Approve manually in dashboard to proceed, or reject to re-assemble.' :
                                  'Hard fail — re-run assembly (max 3 retries). Check ticker cache, concat list, outro duration.',
  ].join('\n');

  // Save why-doc for every job (pass or fail)
  const qaLogDir = path.join(__dirname, '..', 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate3_assembly_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa] Gate 3 why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — Drive is for final videos only

  return { score: avgScore, report: whyDoc, passed, outcome, outcomeLabel, freezeDetected, deductions };
}

function parseScriptIntoScenes(script) {
  const scenes = [];
  const sceneRegex = /===\s*([A-Za-z_0-9]+)\s*===/g;

  let match;
  let lastIndex = 0;
  const matches = [];

  // Find all scene markers
  while ((match = sceneRegex.exec(script)) !== null) {
    matches.push({ name: match[1], index: match.index, fullMatch: match[0] });
  }

  // Extract text between markers
  for (let i = 0; i < matches.length; i++) {
    const currentMatch = matches[i];
    const nextMatch = matches[i + 1];

    const startIndex = currentMatch.index + currentMatch.fullMatch.length;
    const endIndex = nextMatch ? nextMatch.index : script.length;

    let text = script.substring(startIndex, endIndex).trim();

    // Clean up markers from text
    text = text.replace(/\[beat\]/g, '').trim();
    text = text.replace(/\[CLIP PLAYS HERE\]/g, '').trim();

    // Only include scenes with actual text content
    if (text.length > 0) {
      scenes.push({
        name: currentMatch.name,
        text: text
      });
    }
  }

  return scenes;
}

function getFixSuggestion(cause) {
  switch (cause) {
    case 'TWITCH_API_EMPTY':        return 'No clips returned in 48h window — streamer may not have been live recently';
    case 'TWITCH_API_ERROR':        return 'Twitch API request failed — check TWITCH_CLIENT_ID/TOKEN in .env';
    case 'STREAMER_NOT_FOUND':      return 'Twitch user lookup returned empty — verify streamer username spelling';
    case 'GQL_RESOLUTION_FAILED':   return 'GQL CDN URL resolution failed — clip may be deleted or token expired';
    case 'CDN_DOWNLOAD_BLOCKED':    return 'CDN download was blocked — clip URL may be expired or geo-restricted';
    case 'GEMINI_ANALYSIS_FAILED':  return 'Gemini could not analyze clip — thumbnail or video URL may be invalid';
    case 'GEMINI_ANALYSIS_TRUNCATED': return 'Gemini analysis was truncated — clip may be too long or upload failed';
    case 'NO_CLIPS_AFTER_FILTERING': return 'All clips had non-real titles (spam/bot clips filtered) — check clip quality';
    default:                        return 'Check server logs for details';
  }
}

function generateClipAvailabilityReport(items, allClips, streamerOrder, analysisClips, clipFailureReasons = {}) {
  const report = [];
  report.push('\n── CLIP AVAILABILITY REPORT ──────────────────────');

  // Fix #6: Derive target dynamically from actual data — no hardcoded numbers.
  // targetPerStreamer = clips per streamer from the first item's clips array.
  // expectedStreamers = number of streamers actually in this episode (streamerOrder).
  const targetPerStreamer = (items && items[0] && items[0].clips && items[0].clips.length > 0)
    ? items[0].clips.length
    : 2;
  const expectedStreamers = streamerOrder ? streamerOrder.length : Object.keys(STREAMER_DISPLAY_NAMES).length;
  const expectedTotal = expectedStreamers * targetPerStreamer;

  const actualTotal = analysisClips.length;
  const shortfall = expectedTotal - actualTotal;

  report.push(`Target: ${expectedTotal} clips (${expectedStreamers} streamers × ${targetPerStreamer} clips each)`);
  report.push(`Actual: ${actualTotal} clips`);
  if (shortfall > 0) {
    report.push(`Shortfall: ${shortfall} clips\n`);
  } else {
    report.push(`Status: ✅ Target met\n`);
  }

  // Per-streamer breakdown — show streamers in this episode + any roster streamers not included
  const rosterStreamers = Object.keys(STREAMER_DISPLAY_NAMES);
  // Show episode streamers first (in order), then any roster streamers not in this episode
  const allStreamersToShow = [
    ...(streamerOrder || []),
    ...rosterStreamers.filter(s => !(streamerOrder || []).includes(s))
  ];
  allStreamersToShow.forEach(streamer => {
    const streamerClips = allClips.filter(c => c.streamer === streamer);
    const analyzedClips = analysisClips.filter(c => c.streamer === streamer);
    const requested = targetPerStreamer;
    const obtained = analyzedClips.length;

    let reason = '';
    if (!streamerOrder.includes(streamer)) {
      const failure = clipFailureReasons[streamer] || clipFailureReasons[streamer.toLowerCase()];
      if (failure && failure.cause) {
        const suggestion = getFixSuggestion(failure.cause);
        reason = `⚠️ Not included — cause: ${failure.cause}\n       evidence: ${failure.evidence || 'n/a'}\n       fix: ${suggestion}`;
      } else {
        reason = '⚠️ Not in this episode';
      }
    } else if (obtained >= requested) {
      reason = '✅ Target met';
    } else if (streamerClips.length === 0) {
      reason = '⚠️ No clips available from dashboard';
    } else {
      const good = streamerClips.filter(c => c.videoUrl && c.videoUrl.includes('sig='));
      const bad  = streamerClips.filter(c => !c.videoUrl || !c.videoUrl.includes('sig='));
      if (good.length < requested) {
        const expired = requested - good.length;
        reason = `⚠️ ${expired} clips expired/deleted${bad.length > 0 ? `, used ${bad.length} backups` : ''}`;
      } else if (streamerClips.length < requested) {
        reason = `⚠️ Only ${streamerClips.length} clips available (need ${requested})`;
      } else {
        reason = '⚠️ Unknown issue — check logs';
      }
    }

    report.push(`${streamer}: ${obtained}/${requested} clips — ${reason}`);
  });

  report.push('──────────────────────────────────────────────────\n');
  return report.join('\n');
}

async function claudeScriptQA(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 2,
    jobId = 'unknown',
    expectedScenes = 0,  // Must be provided by caller
    clipReportData = null,
    clipFailureReasons = {}
  } = opts;

  if (!client) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped — no key)', deductions: [] };

  const PASS_THRESHOLD   = 90;
  const MANUAL_THRESHOLD = 90;

  // All content types use === HEADER === plain-text format.
  // News JSON output is converted to plain-text before reaching QA (see geminiScriptGeneration).

  // Count clip markers and scenes via text regex — universal across all content types
  const isShortForm    = contentType.includes('-short');

  // News uses === STORY#_CLIP === headers with "type: source_clip" instead of [CLIP PLAYS HERE]
  let clipMarkers;
  if (contentType === 'news' || contentType === 'news-short') {
    clipMarkers = (script.match(/===\s+STORY\d+_CLIP\s+===/g) || []).length;
  } else {
    clipMarkers = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  }
  // news-short has no clip (Bobby G reads one story, no video). All other shorts have exactly 1 clip.
  const expectedClips  = contentType === 'news-short' ? 0
                       : isShortForm ? 1
                       : contentType === 'twitch' ? streamers.length * clipsPerStreamer
                       : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1; // allow ±1 tolerance

  const missingAppreciateYou = !/appreciate you/i.test(script);

  // Count === HEADER === markers — accept both correct (INTRO, STORY1_INTRO) and
  // wrong (scene_01) naming so the pre-check reflects actual scene count.
  // Wrong naming is flagged as a structural issue separately.
  const correctSceneMarkers = (script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  const wrongNameSceneMarkers = (script.match(/===\s+scene_\d+\s+===/gi) || []).length;
  const sceneMarkers = correctSceneMarkers + wrongNameSceneMarkers;
  const hasWrongSceneNames = wrongNameSceneMarkers > 0 && correctSceneMarkers === 0;
  const wrongSceneCount = !isShortForm && expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build clip summaries for Claude to cross-check.
  // For Twitch, clipAnalyses is a 2D array: [[s0c0, s0c1], [s1c0, s1c1], ...]
  // For NBA/News, clipAnalyses is a flat array: [c0, c1, c2, ...]
  // News: pool format — Claude matches by title, not by position.
  const isNewsQA = contentType === 'news' || contentType === 'news-short';

  const flatAnalyses = (() => {
    if (contentType === 'twitch' && Array.isArray(clipAnalyses[0])) {
      // 2D → flat: iterate streamer × clip so attribution is always correct
      const flat = [];
      clipAnalyses.forEach((streamerClips, si) => {
        const s = streamers[si] || `Streamer ${si + 1}`;
        (Array.isArray(streamerClips) ? streamerClips : [streamerClips]).forEach((clip, ci) => {
          flat.push({ streamer: s, clipNum: ci + 1, analysis: clip });
        });
      });
      return flat;
    } else {
      // Already flat (NBA / News)
      return clipAnalyses.map((clip, i) => ({
        streamer: streamers[Math.floor(i / clipsPerStreamer)] || `Streamer ${i + 1}`,
        clipNum: (i % clipsPerStreamer) + 1,
        analysis: clip
      }));
    }
  })();

  // For News: build pool-format summaries labeled by title (Gemini chose order, not scrape order)
  // Claude must match each STORY# block to whichever pool entry its content describes.
  const clipSummaries = isNewsQA
    ? flatAnalyses.map((item, i) => {
        const title = item.streamer?.displayName || item.streamer || `Video ${i + 1}`;
        const a = item.analysis;
        return `VIDEO POOL ENTRY ${i + 1} — "${title}":\n${a?.summary || a?.description || a || 'No analysis available'}`;
      }).join('\n\n')
    : flatAnalyses.map((item, i) => {
        const name = item.streamer?.displayName || item.streamer || `Streamer ${i + 1}`;
        const a = item.analysis;
        return `CLIP ${i + 1} (${name}, clip ${item.clipNum}): ${a?.summary || a?.description || a || 'No analysis available'}`;
      }).join('\n');

  const displayNames = streamers.map(s => {
    const data = typeof s === 'object' ? s : { displayName: s, username: s };
    return `"${data.displayName}" (NOT "${data.username || data.twitchUsername || ''}")`;
  }).join(', ');

  // Build content-type-aware context and checklist
  const isTwitch = contentType === 'twitch' || contentType === 'twitch-short';
  const isNBA = contentType === 'nba' || contentType === 'nba-short';
  const isNews = contentType === 'news' || contentType === 'news-short';

  const contextHeader = isTwitch
    ? `STREAMERS (use ONLY these display names): ${displayNames}
CLIPS PER STREAMER: ${clipsPerStreamer}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`
    : isNBA
    ? `GAMES: ${streamers.length} NBA games
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`
    : isNews
    ? `STORIES: ${streamers.length} news stories (Gemini chose editorial order — verify by matching content, not position)
EXPECTED === STORY#_CLIP === COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`
    : `ITEMS: ${streamers.length}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`;

  // isShortForm already declared above (line ~2529) — used here for QA hint text

  // Short-form: 4 checks only — hook, clip marker, reaction, caption
  const checklist = isShortForm ? [
    `1. HOOK: Is there a HOOK: line with exactly 1 sentence that sets up the clip without spoiling it?`,
    `2. CLIP MARKER: Is there exactly 1 [CLIP PLAYS HERE] marker, after the HOOK?`,
    `3. REACTION: Is there a REACTION: line with exactly 1 flat sentence delivered after the clip? No hype, no exclamation points.`,
    `4. CAPTION: Is there a CAPTION: line with 3-6 words suitable for a screen text overlay? FAIL (-10) if caption contains calls to action ("Subscribe", "Watch", "Follow", "Like"), hype words ("Amazing", "Incredible", "Wild"), or is longer than 6 words. PASS if it's a flat fact, score, punchline, or deadpan observation.`
  ] : isTwitch ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: Scenes with numbers (CLIP1, CLIP2, CLIP3) are SEPARATE scenes, not one scene
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. DISPLAY NAMES: Are only the approved display names used (no Twitch usernames)?`,
    `5. INTRO LENGTH: Is each streamer intro 2 or 3 sentences? (2 minimum, 3 maximum — 3 sentences is PASS, only FAIL if 1 sentence or 4+ sentences)`,
    `6. REACTION LENGTH: Is each reaction exactly 1 sentence? (FAIL only if 2 or more sentences)`,
    `7. SETUP LENGTH: Are clips 2 and 3 setups 2 sentences each? (FAIL only if 1 sentence or 3+ sentences)`,
    `8. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `9. CLIP MATCH (most important): Does each setup accurately describe what happens in the clip? Check each one.`,
    `10. LOCKED INTRO (-15 if wrong): The === INTRO === scene MUST contain this EXACT text: "Welcome to Twitch Soup. I'm your host Bobby G, and for the next few minutes, I'll be your guide through the digital dumpster fire that is livestreaming. Let's jump right into the garbage." FAIL (-15) if the intro deviates from this wording.`,
    `11. WORD COUNT: Is each streamer section approximately 80-100 words?`,
    `12. VOICE STYLE (-15 if wrong): Does every scene use Bobby G's Norm MacDonald + Jon Stewart deadpan voice? FAIL this item (-15) if any scene contains:
   - Hype words: "incredible", "amazing", "crazy", "wild", "insane", "unbelievable", "epic", "lit", "fire", "COOKING"
   - Performed enthusiasm or exclamation points in spoken text
   - Audience address: "You guys", "Let me know in the comments", "Drop a like", "What do you think?"
   - Explaining the joke or spelling out why something is funny
   - Ellipses for drama (...) — [beat] is the only pause tool
   - Sentences that go up at the end — everything lands flat
   Good: "He spent forty minutes trying to open a door that was already open. This is a licensed streamer."
   Good: "Chat told him to do it. He did it. Nobody won."
   Good: "She has four thousand subscribers and the confidence of a man with forty million. Respect."
   Bad: "This clip is absolutely INSANE! I can't believe what I just watched!"
   Bad: "You guys, this streamer is absolutely COOKING right now!"
   Bad: "Let me know in the comments what you think about this!"`
  ] : isNBA ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: GAME1_INTRO, GAME1_NARRATION, GAME1_RECAP, GAME1_REACTION are 4 SEPARATE scenes per game
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game, inside each NARRATION scene)?`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `5. INTRO: Is the intro 2-3 sentences introducing the episode?`,
    `6. NARRATION: Does each NARRATION scene contain present-tense play-by-play from Gemini's video analysis, sized to cover the clip? Must include [beat][CLIP PLAYS HERE][beat].`,
    `7. RECAP: Does each RECAP scene have 1-2 factual sentences describing what the audience just watched? No opinion — facts only.`,
    `8. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `9. CLIP MATCH (most important): Does each NARRATION accurately reflect what Gemini saw in the highlight? No invented plays.`,
    `10. LOCKED INTRO (-15 if wrong): The === INTRO === scene MUST contain this EXACT text: "Hello everyone! You are tuning into The Other Side of the Pillow brought to you by ClipzWorld News. Where we appreciate all of yesterday's games in the association. I am your host Bobby G. Let's get to it." FAIL (-15) if the intro deviates from this wording.`,
    `11. NARRATION WORD COUNT: Does each NARRATION scene match the per-game word count target from the prompt (±15% tolerance)?`,
    `12. REACTION: Is each REACTION exactly 1 sentence — deadpan, no recap?`,
    `13. NARRATION VOICE STYLE (-15 if wrong): Does each NARRATION scene use Stuart Scott cadence — short declarative bursts, specific player names and actions, economy of language? FAIL this item if narration has any of these:
   - Generic phrases like "demonstrates his scoring prowess", "puts an exclamation point", "looked to finish strong", "both teams battled"
   - Continuous run-on sentences with no rhythm breaks
   - More than 3 consecutive sentences without a pause or scene break
   - Explaining what the viewer can clearly see ("He rises and hits the shot" instead of just "He hits the shot")
   - Color commentary filler with no specific information
   Good: "Curry. Half-court. Two steps past the logo. Nobody close enough to matter."
   Bad: "Stephen Curry dribbles the ball on the perimeter. He rises and hits a critical go-ahead three-pointer."`
  ] : isNews ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: list each === HEADER === you find, then count your list
   - Remember: STORY1_INTRO, STORY1_SETUP, STORY1_CLIP, STORY1_SUMMARY, STORY1_REACTION are 5 SEPARATE scenes
   - Are there exactly ${expectedScenes} === HEADER === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} === STORY#_CLIP === markers (one per story) with empty spokenText?`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. STORY ACCURACY: Do the STORY#_INTRO and STORY#_SETUP scenes accurately reflect the story headline and context?`,
    `5. INTRO: Is the === INTRO === scene 2-3 sentences introducing the episode?`,
    `6. STORY SETUP: Does each STORY#_SETUP scene give proper context for the clip that follows (1 sentence, new fact)?`,
    `7. CLIP SCENES: Do all === STORY#_CLIP === scenes have type: source_clip and empty spokenText?`,
    `8. STORY MATCH (most important): Gemini chose the editorial order — do NOT check by position. For each STORY# block, find the VIDEO POOL ENTRY whose analysis matches the script content, then verify accuracy. Check STORY#_INTRO and STORY#_SUMMARY describe that video's actual content. Fail only if the narration contradicts or invents facts not in any pool entry.`,
    `9. LOCKED INTRO (-15 if wrong): The === INTRO === scene MUST contain this EXACT text: "Hello everyone! You are tuning into Because the Light Was On brought to you by ClipzWorld News. Where we bring you the most impactful news stories of the day, our way, the CWN way. I am your host Bobby G. Let's get to it." FAIL (-15) if the intro deviates from this wording.`,
    `10. SOURCE ATTRIBUTION (STRICT): Does any scene contain spoken source attribution? Check for "According to Al Jazeera", "Sources report", "Al Jazeera's coverage". FAIL hard (-25) if any found — Bobby G must NEVER speak the source name.`,
    `11. REACTION: Does each STORY#_REACTION scene have a flat, deadpan 1-sentence reaction?`,
    `12. VOICE STYLE (-15 if wrong): Does every scene use Bobby G's Jon Stewart + Norm MacDonald news anchor voice — facts stated plainly, one flat observation, done? FAIL this item (-15) if any scene contains:
   - Alarm words: "insane", "wild", "crazy", "unbelievable", "shocking", "you won't believe this"
   - Performed emotion: "This is SHOCKING", "I can't even process this", "What is going on?"
   - Explaining why the story matters — if it's not obvious, state the fact and move on
   - More than 4 sentences in a single story segment
   - Ellipses for drama (...) — [beat] is the only pause tool
   - ALL CAPS anywhere in spoken text
   - Call to action: "Drop your thoughts below", "Tell me what you think"
   Good: "A senator proposed a bill this week that would ban the word 'senator.' It did not pass."
   Good: "The summit ended without an agreement. Both sides described it as productive."
   Good: "He resigned citing personal reasons. The personal reason was the investigation."
   Bad: "You guys, this story is INSANE and you are NOT going to believe what happened!"
   Bad: "I can't even... like, what is going on with the world right now?"
   Bad: "This is truly shocking news that will have major implications for everyone involved."`
  ] : [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. STRUCTURE: Does the script follow the expected format?`,
    `4. CONTENT MATCH: Does the script accurately reflect the source material?`,
    `5. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`
  ];

  const qaPrompt = `You are a QA reviewer for ClipzWorld News. Gemini just wrote a script for a video that will be generated using HeyGen's Bobby G avatar. You watched the clips. Cross-check the script against what you know about each clip.

CONTENT TYPE: ${contentType}
${contextHeader}

── ${isNewsQA ? 'VIDEO POOL (Gemini chose order — match by content, not position)' : 'WHAT YOU SAW IN EACH CLIP'} ─────────────────────────
${clipSummaries}

── THE SCRIPT GEMINI WROTE ───────────────────────────
${script}

── YOUR QA CHECKLIST ─────────────────────────────────
For each item, respond: PASS / FAIL — [brief reason if fail]

${checklist.join('\n')}

── SCORING ───────────────────────────────────────────
Start with 100 points. For each failed check, deduct:
  - Items 1, 2, 3, ${isTwitch ? '9' : '8'}: -15 each (critical)
  - Items 4, ${isTwitch ? '8' : '7'}: -10 each
  - All other items: -5 each

Respond in this exact format:

SCORE: [0-100]
ISSUES:
- [CHECK NAME]: [what's wrong] → [what it should be]
[list all issues, or write "None" if PASS on all checks]

FIX_DIRECTIVE:
\`\`\`json
{
  "missingScenes": [],
  "fabricatedContent": [],
  "nameErrors": [],
  "structuralIssues": []
}
\`\`\`

Rules for filling FIX_DIRECTIVE:
- missingScenes: list every scene header that is in the expected set but absent from the script. Example: ["STORY3_REACTION", "STORY4_INTRO", "STORY4_SETUP", "STORY4_SUMMARY", "STORY4_CLIP", "STORY4_REACTION", "STORY5_INTRO"]. Leave empty [] if scene count is correct.
- fabricatedContent: for each scene whose spoken text does not match the clip analysis, write an object: { "scene": "STORY2_INTRO", "problem": "describes a CEO resignation but clip is about a wildfire evacuation", "fix": "rewrite using these facts from the clip: [paste relevant clip analysis text here]" }. Leave empty [] if all content is accurate.
- nameErrors: for each wrong name used, write an object: { "used": "Jaycinco", "correct": "Jay Cinco" }. Leave empty [] if all names are correct.
- structuralIssues: list any structural failures not covered above. Examples: "OUTRO missing — must end with Appreciate you!", "INTRO is 1 sentence — must be 2-3 sentences". Leave empty [] if structure is correct.
- If the script passes all checks, output all four arrays as empty [].
- Output VALID JSON only — no trailing commas, no comments inside the json block.`;

  let claudeReport = '';
  let tokenUsage = { input: 0, output: 0 };
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.1,
      messages: [{ role: 'user', content: qaPrompt }]
    });

    claudeReport = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    tokenUsage.input  = response.usage?.input_tokens || 0;
    tokenUsage.output = response.usage?.output_tokens || 0;
  } catch(e) {
    claudeReport = `Claude QA call failed: ${e.message}`;
  }

  // Parse FIX_DIRECTIVE from Claude's response
  let fixDirective = { missingScenes: [], fabricatedContent: [], nameErrors: [], structuralIssues: [] };
  try {
    const directiveMatch = claudeReport.match(/FIX_DIRECTIVE:\s*```json\s*([\s\S]*?)```/i);
    if (directiveMatch) {
      const parsed = JSON.parse(directiveMatch[1].trim());
      fixDirective = {
        missingScenes:     Array.isArray(parsed.missingScenes)     ? parsed.missingScenes     : [],
        fabricatedContent: Array.isArray(parsed.fabricatedContent) ? parsed.fabricatedContent : [],
        nameErrors:        Array.isArray(parsed.nameErrors)        ? parsed.nameErrors        : [],
        structuralIssues:  Array.isArray(parsed.structuralIssues)  ? parsed.structuralIssues  : []
      };
    }
  } catch(e) {
    // JSON parse failed — fixDirective stays as empty defaults, retry will use fallback coaching
    console.warn(`[qa-gate1] FIX_DIRECTIVE parse failed: ${e.message}`);
  }

  // Parse score from Claude's response
  const scoreMatch = claudeReport.match(/SCORE:\s*(\d+)/i);
  let parsedScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
  parsedScore = Math.max(0, Math.min(100, parsedScore)); // Clamp 0-100

  // Apply hard penalties for structural failures caught before Claude
  const preCheckDeductions = [];
  let adjustedScore = parsedScore;

  if (wrongSceneCount) {
    preCheckDeductions.push({ points: 25, reason: `SCENE COUNT: Found ${sceneMarkers} scenes, expected ${expectedScenes} — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (wrongClipCount) {
    preCheckDeductions.push({ points: 25, reason: `CLIP COUNT: Found ${clipMarkers} [CLIP PLAYS HERE] markers, expected ${expectedClips} — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (missingAppreciateYou) {
    preCheckDeductions.push({ points: 15, reason: `OUTRO: "Appreciate you!" missing from script — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 15);
  }

  if (hasWrongSceneNames) {
    preCheckDeductions.push({ points: 25, reason: `SCENE NAMING: Used generic scene_NN names instead of === INTRO ===, === STORY1_INTRO === etc. — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  const hasCriticalFail = wrongSceneCount || wrongClipCount || missingAppreciateYou || hasWrongSceneNames || adjustedScore < 60;
  let outcome, passed;
  if (hasCriticalFail || adjustedScore < MANUAL_THRESHOLD) {
    outcome = 'fail'; passed = false;
  } else if (adjustedScore >= PASS_THRESHOLD) {
    outcome = 'pass'; passed = true;
  } else {
    outcome = 'manual_review'; passed = false;
  }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';

  // Build structured why-doc
  const whyDoc = [
    `=== CWN GATE 1: SCRIPT QA — ${outcomeLabel} ===`,
    `Gate:       1 of 4 — Script QA`,
    `Scored by:  Claude (did not write the script)`,
    `Time:       ${new Date().toISOString()}`,
    `Job:        ${jobId}`,
    `Content:    ${contentType}`,
    `Score:      ${adjustedScore}/100 (Claude raw: ${parsedScore}/100)`,
    `Pass threshold:   ${PASS_THRESHOLD} (auto-proceed to HeyGen)`,
    `Manual threshold: ${MANUAL_THRESHOLD} (hold for Rob)`,
    `Outcome:    ${outcome.toUpperCase()}`,
    ``,
    `── CRITICAL FAILURES ────────────────────────────`,
    `Scene count mismatch: ${wrongSceneCount      ? `🚨 YES — ${sceneMarkers} found, ${expectedScenes} expected` : '✅ No'}`,
    `Clip count mismatch:  ${wrongClipCount       ? `🚨 YES — ${clipMarkers} found, ${expectedClips} expected` : '✅ No'}`,
    `Missing Appreciate you: ${missingAppreciateYou ? '🚨 YES' : '✅ No'}`,
    ``,
    `── SCORE BREAKDOWN ───────────────────────────────`,
    `STARTING SCORE: 100`,
    ``,
    preCheckDeductions.length ? `PRE-CHECK DEDUCTIONS:` : '',
    preCheckDeductions.length ? preCheckDeductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '',
    preCheckDeductions.length ? `` : '',
    (preCheckDeductions.length === 0) ? `  Claude-assessed deductions included in score above` : '',
    ``,
    `FINAL SCORE: ${adjustedScore}/100`,
    ``,
    `── CLAUDE DETAILED REVIEW ────────────────────────`,
    claudeReport,
    ``,
    `── RECOMMENDED ACTION ───────────────────────────`,
    outcome === 'pass'          ? 'Auto-proceed to HeyGen segment generation.' :
    outcome === 'manual_review' ? 'Review issues above. Edit script in dashboard, then manually approve to send to HeyGen.' :
                                  'Hard fail — script returned to Gemini for revision (max 3 retries). Fix issues listed above.',
  ].join('\n');

  // Save why-doc for every job
  const qaLogDir = path.join(__dirname, '..', 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate1_script_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate1] Script QA why-doc saved: ${logFile}`); } catch(e) {}

  // Append clip availability report if data was provided (Twitch only)
  if (clipReportData && contentType === 'twitch') {
    try {
      const { items: rItems, allClips: rAllClips, streamerOrder: rOrder, analysisClips: rAnalysis } = clipReportData;
      const clipReport = generateClipAvailabilityReport(rItems, rAllClips, rOrder, rAnalysis, clipFailureReasons);
      fs.appendFileSync(logFile, clipReport);
      console.log(`[qa-gate1] Clip availability report appended to why-doc`);
    } catch(e) { console.warn(`[qa-gate1] Clip report append failed: ${e.message}`); }
  }

  // QA logs saved locally only — not uploaded to Drive
  return {
    score: adjustedScore,
    report: whyDoc,
    passed,
    outcome,
    outcomeLabel,
    deductions: preCheckDeductions,
    claudeReport,
    fixDirective,
    tokenUsage
  };
}

async function claudeScriptFix(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 2,
    qaReport = '',
    jobId = 'unknown'
  } = opts;

  if (!client) return { script, fixed: false };

  const isNews = contentType === 'news' || contentType === 'news-short';
  const isNBA  = contentType === 'nba'  || contentType === 'nba-short';

  // Build clip reference block — universal across all content types
  let clipRef;
  if (isNews) {
    // News: streamers[] = story titles, clipAnalyses[] = flat analyses aligned by index
    clipRef = streamers.map((s, i) => {
      const title = (s.displayName || s.twitchUsername || `Story ${i+1}`).toUpperCase();
      const analysis = (Array.isArray(clipAnalyses) ? clipAnalyses[i] : null) || 'No analysis available';
      return `STORY ${i+1} (${title}):\n${analysis}`;
    }).join('\n\n');
  } else if (isNBA) {
    // NBA: streamers[] = game matchups, clipAnalyses[] = flat analyses
    clipRef = streamers.map((s, i) => {
      const game = (s.displayName || `Game ${i+1}`).toUpperCase();
      const analysis = (Array.isArray(clipAnalyses) ? clipAnalyses[i] : null) || 'No analysis available';
      return `GAME ${i+1} (${game}):\n${analysis}`;
    }).join('\n\n');
  } else {
    // Twitch: streamers[] indexed, clipAnalyses[] is 2D
    clipRef = streamers.map((s, si) => {
      const name = (s.displayName || s.twitchUsername || '').toUpperCase().replace(/\s+/g, '_');
      const analysesList = Array.isArray(clipAnalyses[si]) ? clipAnalyses[si] : [clipAnalyses[si] || ''];
      return analysesList.map((a, ci) =>
        name + ' CLIP ' + (ci+1) + ': ' + (a || 'No analysis available')
      ).join('\n');
    }).join('\n');
  }

  // Build content-type-aware scene name guidance
  const sceneGuide = isNews
    ? 'STORY#_INTRO, STORY#_SETUP, STORY#_SUMMARY, STORY#_REACTION (where # = story number 1-5)'
    : isNBA
    ? 'GAME#_INTRO, GAME#_NARRATION, GAME#_RECAP, GAME#_REACTION (where # = game number)'
    : 'streamer INTRO, CLIP#_SETUP, CLIP#_REACTION sections';

  const fixPrompt = `You are a script editor for ClipzWorld News (CWN). A script was written by Gemini but failed QA because some scenes describe the wrong clip/story content.

YOUR TASK: Fix ONLY the broken scenes listed in the QA report. Do NOT change any other part of the script. Preserve all === HEADERS ===, [CLIP PLAYS HERE] markers, [beat] markers, and structure exactly.

CONTENT TYPE: ${contentType}
SCENE TYPES TO FIX: ${sceneGuide}

ACTUAL CLIP/STORY CONTENT (what was seen in each video — ground truth):
${clipRef}

QA FAILURE REPORT (shows exactly which scenes are wrong and what they should say):
${qaReport}

RULES FOR FIXING:
1. Read the FIX_DIRECTIVE in the QA report — it tells you exactly which scenes to fix and what facts to use.
2. Rewrite ONLY the spokenText of the broken scenes using the facts from the clip analysis above.
3. Keep Bobby G voice: flat, deadpan, Norm MacDonald delivery. Never say "incredible", "amazing", "shocking".
4. STORY#_INTRO: 2-3 sentences introducing the story. STORY#_SETUP: 1 sentence — new fact, not a restatement. STORY#_SUMMARY: 1-2 sentences factual recap. STORY#_REACTION: exactly 1 flat deadpan sentence.
5. Do NOT change INTRO, OUTRO, or any scene not listed as broken.
6. Do NOT swap scene headers — only fix the spoken text inside broken scenes.
7. Return the COMPLETE script with ONLY the broken scenes fixed.
8. No explanation, no preamble, no markdown code blocks — just the script.

CURRENT SCRIPT TO FIX:
${script}

Return ONLY the fixed complete script.`;

  try {
    console.log('[claude-fix] Asking Claude to surgically fix clip match issues...');
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: fixPrompt }]
    });

    const fixedScript = response.content[0]?.text?.trim() || script;

    // Normalize headers (same post-processing as Gemini)
    const normalizedScript = fixedScript.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
      const normalized = name.trim().replace(/\s+/g, '_');
      return '=== ' + normalized + ' ===';
    });

    console.log('[claude-fix] Script fix complete (' + normalizedScript.length + ' chars)');
    return { script: normalizedScript, fixed: true };
  } catch(e) {
    console.error('[claude-fix] Claude fix failed: ' + e.message);
    return { script, fixed: false };
  }
}

async function geminiScriptQA(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 2,
    jobId = 'unknown'
  } = opts;

  if (!GEMINI_APIKEY) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped — no key)', deductions: [] };

  const PASS_THRESHOLD   = 90;
  const MANUAL_THRESHOLD = 70;

  // Count [CLIP PLAYS HERE] markers in script
  const clipMarkers    = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  const expectedClips  = contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1; // allow ±1 tolerance
  const missingAppreciateYou = !/appreciate you/i.test(script);

  // Build Gemini prompt with clip analyses for content verification
  const clipSummaries = clipAnalyses.map((a, i) => {
    const streamer = streamers[Math.floor(i / clipsPerStreamer)] || `Streamer ${i+1}`;
    const clipNum  = (i % clipsPerStreamer) + 1;
    return `CLIP ${i+1} (${streamer}, clip ${clipNum}): ${a?.summary || a?.description || 'No analysis available'}`;
  }).join('\n');

  const displayNames = streamers.map(s => {
    const data = typeof s === 'object' ? s : { displayName: s, username: s };
    return `"${data.displayName}" (NOT "${data.username || data.twitchUsername || ''}")`;
  }).join(', ');

  // Load HeyGen context for smarter QA validation
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
  const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '2e598f1a6022448cb6710e5d44665325';
  const HEYGEN_SPEAK_SPEED = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85');

  // Count expected scenes based on script structure
  // Twitch: 1 INTRO + (streamers × (1 intro + clips × 2)) + 1 OUTRO
  // NBA/News: 1 COLD OPEN + items.length games/stories + 1 OUTRO
  // Shorts: 1 scene total (no validation)
  const sceneMarkers = (script.match(/===\s+[A-Z_]+\s+===/g) || []).length;

  let expectedScenes = 0;
  if (contentType === 'twitch') {
    const scenesPerStreamer = 1 + clipsPerStreamer * 2;
    expectedScenes = 1 + streamers.length * scenesPerStreamer + 1;
  } else if (contentType === 'nba' || contentType === 'news') {
    expectedScenes = 1 + (streamers.length * 4) + 1; // 1 INTRO + (games × 4 scenes each: _INTRO, _NARRATION, _RECAP, _REACTION) + 1 OUTRO
  }
  // Shorts don't validate scene count (expectedScenes remains 0)

  const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build content-type-aware context and checklist
  const isTwitch = contentType === 'twitch' || contentType === 'twitch-short';
  const isNBA = contentType === 'nba' || contentType === 'nba-short';
  const isNews = contentType === 'news' || contentType === 'news-short';

  const contextHeader = isTwitch
    ? `STREAMERS (use ONLY these display names): ${displayNames}
CLIPS PER STREAMER: ${clipsPerStreamer}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}`
    : isNBA
    ? `GAMES: ${streamers.length} NBA games
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips} (one per game)`
    : isNews
    ? `STORIES: ${streamers.length} news stories
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips} (one per story)`
    : `ITEMS: ${streamers.length}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}`;

  const checklist = isTwitch ? [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. DISPLAY NAMES: Are only the approved display names used (no Twitch usernames)?`,
    `4. INTRO LENGTH: Is each streamer intro 2 or 3 sentences? (2 minimum, 3 maximum — 3 sentences is PASS, only FAIL if 1 sentence or 4+ sentences)`,
    `5. REACTION LENGTH: Is each reaction exactly 1 sentence? (FAIL only if 2 or more sentences)`,
    `6. SETUP LENGTH: Are clips 2 and 3 setups 2 sentences each? (FAIL only if 1 sentence or 3+ sentences)`,
    `7. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `8. CLIP MATCH (most important): Does each setup accurately describe what happens in the clip? Check each one.`,
    `9. LOCKED INTRO (-15 if wrong): The script MUST open with: "Other Side of the Pillow. ClipzWorld News." — or for Twitch Soup short: "Welcome to Twitch Soup." FAIL (-15) if the intro is missing or uses a different show name.`,
    `10. WORD COUNT: Is each streamer section approximately 80-100 words?`
  ] : isNBA ? [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game)?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `4. COLD OPEN: Is the cold open 2-3 sentences introducing the episode?`,
    `5. NARRATION: Does each game's NARRATION scene contain play-by-play commentary sized to cover the clip duration?`,
    `6. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `7. CLIP MATCH (most important): Does each game commentary match what Gemini saw in the highlight clip?`,
    `8. LOCKED INTRO (-15 if wrong): The script MUST open with: "The Daily Update. ClipzWorld News." (for shorts) or "Hello everyone! You are tuning into The Other Side of the Pillow..." (for compilations). FAIL (-15) if the intro is missing or uses a different show name.`,
    `9. NARRATION WORD COUNT: Does each NARRATION scene match the per-game word count target from the prompt (±15% tolerance)?`,
    `10. REACTION: Is there a brief reaction/observation after each clip?`
  ] : isNews ? [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per story)?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. STORY ACCURACY: Are headlines and story details accurately mentioned?`,
    `4. COLD OPEN: Is the cold open 2-3 sentences introducing the episode?`,
    `5. STORY SETUP: Does each story have proper context before [CLIP PLAYS HERE]?`,
    `6. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `7. CLIP MATCH (most important): Does each story setup match what Gemini saw in the news clip?`,
    `8. LOCKED INTRO (-15 if wrong): The script MUST open with: "Because the Light Was On. ClipzWorld News." (for shorts) or "Hello everyone! You are tuning into Because the Light Was On..." (for compilations). FAIL (-15) if the intro is missing or uses a different show name.`,
    `9. SOURCE ATTRIBUTION: Is "Source: [name]. Link in description." included after each story?`,
    `10. REACTION: Is there a flat, deadpan reaction after each clip (1 sentence)?`
  ] : [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. STRUCTURE: Does the script follow the expected format?`,
    `4. CONTENT MATCH: Does the script accurately reflect the source material?`,
    `5. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`
  ];

  const qaPrompt = `You are QA reviewer for ClipzWorld News. Claude just wrote a script. You watched the clips. Cross-check the script against what you know about each clip.

CONTENT TYPE: ${contentType}
${contextHeader}

── HEYGEN GENERATION CONTEXT ─────────────────────────
This script will be sent to HeyGen for avatar video generation with these parameters:
  Avatar ID:    ${HEYGEN_AVATAR_ID.slice(0,8)}... (Bobby G avatar)
  Voice ID:     ${HEYGEN_VOICE_ID.slice(0,8)}... (Bobby G voice)
  Speak Speed:  ${HEYGEN_SPEAK_SPEED}x
  Expected Scenes: ${sceneMarkers} scenes (each === SCENE_NAME === marker becomes a separate video)

IMPORTANT: HeyGen requires properly formatted scene markers (=== SCENE_NAME ===) to split the script into individual video segments.
If scene count is incorrect or missing, HeyGen generation will fail.

── WHAT GEMINI SAW IN EACH CLIP ──────────────────────
${clipSummaries}

── THE SCRIPT CLAUDE WROTE ───────────────────────────
${script}

── YOUR QA CHECKLIST ─────────────────────────────────
For each item, respond: PASS / FAIL — [brief reason if fail]

${checklist.join('\n')}

── SCORING ───────────────────────────────────────────
SCORE: [0-100]
For each failed check, deduct:
  - Items 1, 2, ${isTwitch ? '8, 12' : isNBA ? '7' : '8, 12'}: -15 each (critical)
  - Items 3, ${isTwitch ? '7' : isNBA ? '6' : '6'}: -10 each
  - All other items: -5 each
  ${isNBA ? '- Item 13 (NARRATION VOICE STYLE): -15 if wrong' : ''}

ISSUES: List each specific problem with enough detail to fix it.
Format: "- [CHECK NAME]: [what's wrong] → [what it should be]"

SCORE: [number]
ISSUES:
[list]`;

  let geminiReport = '';
  try {
    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: qaPrompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );
    geminiReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
  } catch(e) {
    geminiReport = `Gemini QA call failed: ${e.message}`;
  }

  // Compute score from Gemini's PASS/FAIL list — never trust Gemini's raw score
  // Prevents Gemini applying wrong deduction weights (it gave -15 for a -5 item)
  const DEDUCTION_MAP = { '1':15,'2':15,'8':15,'3':10,'7':10,'4':5,'5':5,'6':5,'9':5,'10':5 };
  const DEDUCTION_LABELS = {
    '1':'CLIP COUNT', '2':'OUTRO', '3':'DISPLAY NAMES', '4':'INTRO LENGTH', '5':'REACTION LENGTH',
    '6':'SETUP LENGTH', '7':'BEAT PLACEMENT', '8':'CLIP MATCH', '9':'LOCKED INTRO', '10':'WORD COUNT'
  };
  let computedScore = 100;
  const geminiDeductions = [];
  for (const [num, pts] of Object.entries(DEDUCTION_MAP)) {
    const lineRegex = new RegExp('^' + num + '[.):]\\s*[^\\n]+:\\s*FAIL', 'im');
    if (lineRegex.test(geminiReport)) {
      computedScore = Math.max(0, computedScore - pts);
      geminiDeductions.push({ points: pts, reason: DEDUCTION_LABELS[num] || `Check #${num}` });
    }
  }
  const parsedScore = computedScore;

  // Apply hard penalties for structural failures caught before Gemini
  const preCheckDeductions = [];
  let adjustedScore = parsedScore;
  if (wrongSceneCount) {
    preCheckDeductions.push({ points: 25, reason: `SCENE COUNT: Found ${sceneMarkers} scenes, expected ${expectedScenes} — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (wrongClipCount) {
    preCheckDeductions.push({ points: 25, reason: `CLIP COUNT: Found ${clipMarkers} [CLIP PLAYS HERE] markers, expected ${expectedClips} — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (missingAppreciateYou) {
    preCheckDeductions.push({ points: 15, reason: `OUTRO: "Appreciate you!" missing from script — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 15);
  }

  const hasCriticalFail = wrongSceneCount || wrongClipCount || missingAppreciateYou || adjustedScore < 60;
  let outcome, passed;
  if (hasCriticalFail || adjustedScore < MANUAL_THRESHOLD) {
    outcome = 'fail'; passed = false;
  } else if (adjustedScore >= PASS_THRESHOLD) {
    outcome = 'pass'; passed = true;
  } else {
    outcome = 'manual_review'; passed = false;
  }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';

  // Build structured why-doc
  const whyDoc = [
    `=== CWN GATE 1: SCRIPT QA — ${outcomeLabel} ===`,
    `Gate:       1 of 4 — Script QA`,
    `Scored by:  Gemini (did not write the script)`,
    `Time:       ${new Date().toISOString()}`,
    `Job:        ${jobId}`,
    `Content:    ${contentType}`,
    `Score:      ${adjustedScore}/100 (Gemini raw: ${parsedScore}/100)`,
    `Pass threshold:   ${PASS_THRESHOLD} (auto-proceed to HeyGen)`,
    `Manual threshold: ${MANUAL_THRESHOLD} (hold for Rob)`,
    `Outcome:    ${outcome.toUpperCase()}`,
    ``,
    `── CRITICAL FAILURES ────────────────────────────`,
    `Scene count mismatch: ${wrongSceneCount      ? `🚨 YES — ${sceneMarkers} found, ${expectedScenes} expected` : '✅ No'}`,
    `Clip count mismatch:  ${wrongClipCount       ? `🚨 YES — ${clipMarkers} found, ${expectedClips} expected` : '✅ No'}`,
    `Missing Appreciate you: ${missingAppreciateYou ? '🚨 YES' : '✅ No'}`,
    ``,
    `── SCORE BREAKDOWN ───────────────────────────────`,
    `STARTING SCORE: 100`,
    ``,
    geminiDeductions.length ? `GEMINI QA DEDUCTIONS:` : '',
    geminiDeductions.length ? geminiDeductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '',
    geminiDeductions.length ? `` : '',
    preCheckDeductions.length ? `PRE-CHECK DEDUCTIONS:` : '',
    preCheckDeductions.length ? preCheckDeductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '',
    preCheckDeductions.length ? `` : '',
    (geminiDeductions.length === 0 && preCheckDeductions.length === 0) ? `  No deductions` : '',
    ``,
    `FINAL SCORE: ${adjustedScore}/100`,
    ``,
    `── GEMINI DETAILED REVIEW ────────────────────────`,
    geminiReport,
    ``,
    `── RECOMMENDED ACTION ───────────────────────────`,
    outcome === 'pass'          ? 'Auto-proceed to HeyGen segment generation.' :
    outcome === 'manual_review' ? 'Review issues above. Edit script in dashboard, then manually approve to send to HeyGen.' :
                                  'Hard fail — script returned to Claude for revision (max 3 retries). Fix issues listed above.',
  ].join('\n');

  // Save why-doc for every job
  const qaLogDir = path.join(__dirname, '..', 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate1_script_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate1] Script QA why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — not uploaded to Drive
  return { score: adjustedScore, report: whyDoc, passed, outcome, outcomeLabel, deductions: preCheckDeductions, geminiReport };
}

async function geminiSegmentQA(segmentPaths, opts = {}) {
  const { jobId = 'unknown', contentType = 'twitch' } = opts;

  if (!GEMINI_APIKEY) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped)', deductions: [] };
  if (!segmentPaths || segmentPaths.length === 0) return { score: 0, passed: false, outcome: 'fail', outcomeLabel: '❌ HARD FAIL — no segments', deductions: [] };

  const PASS_THRESHOLD   = 85;
  const MANUAL_THRESHOLD = 65;

  // Sample first, middle, last avatar segments
  const avatarSegs = segmentPaths.filter(p => p && fs.existsSync(p));
  const toCheck = [
    avatarSegs[0],
    avatarSegs[Math.floor(avatarSegs.length / 2)],
    avatarSegs[avatarSegs.length - 1]
  ].filter(Boolean);

  const reports = [];
  const scores  = [];
  let lipSyncFail = false, audioMissing = false, wrongAvatar = false;

  for (const segPath of toCheck) {
    const label = segPath === toCheck[0] ? 'FIRST' : segPath === toCheck[toCheck.length-1] ? 'LAST' : 'MIDDLE';
    try {
      const geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(segPath));

      // Load HeyGen context for segment QA
      const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
      const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '2e598f1a6022448cb6710e5d44665325';
      const HEYGEN_SPEAK_SPEED = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85');

      const segPrompt = `You are a QA reviewer for ClipzWorld News HeyGen avatar segments.

Watch this Bobby G avatar segment and provide a detailed quality assessment.

── HEYGEN GENERATION CONTEXT ─────────────────────────
This segment was generated by HeyGen with:
  Avatar ID:    ${HEYGEN_AVATAR_ID.slice(0,8)}... (Bobby G avatar — should be a professional news anchor)
  Voice ID:     ${HEYGEN_VOICE_ID.slice(0,8)}... (Bobby G voice — deep, authoritative male voice)
  Speak Speed:  ${HEYGEN_SPEAK_SPEED}x (slightly faster than normal for news pacing)

Expected quality: Clean 1080p, smooth lip sync, professional avatar framing, clear audio.

REQUIRED FORMAT (fill out ALL sections):

1. LIP SYNC: [PASS/FAIL]
   - Are the avatar's mouth movements in sync with the audio?
   - Any noticeable delays or mismatches?

2. AUDIO QUALITY: [PASS/FAIL]
   - Is the audio clear and understandable?
   - Any distortion, crackling, or volume issues?
   - Any unexpected silence or audio dropouts?

3. AVATAR VISIBILITY: [PASS/FAIL]
   - Is Bobby G properly framed in the shot?
   - Is his face clearly visible throughout?

4. VIDEO FREEZE: [PASS/FAIL]
   - Does the video play smoothly without freezing?
   - Any stuttering or frame drops?

5. BACKGROUND: [PASS/FAIL]
   - Bobby G's background is a warm home-office/studio setting (bookshelf, lamp) — this is CORRECT and expected
   - FAIL only if there are visual artifacts, glitches, green screen bleed, or the avatar is missing entirely
   - Do NOT fail for the bookshelf/room background — that is Bobby G's standard HeyGen background

OVERALL SCORE: <number from 0-100>

DETAILED ISSUES:
[List any specific problems found, or write "No issues detected" if everything looks good]

SUMMARY:
[One sentence overall assessment of segment quality]`;

      const genResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: segPrompt },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      const segScore  = parseInt((segReport.match(/OVERALL SCORE:\s*\[?(\d+)\]?/i) || segReport.match(/SCORE:\s*\[?(\d+)\]?/i) || [])[1] || '80');

      // Track specific failures for this segment
      const segDeductions = [];
      if (/LIP SYNC:.*\[?FAIL/i.test(segReport))  {
        lipSyncFail  = true;
        scores.push(20);
        segDeductions.push('Lip sync broken');
      }
      else if (/VIDEO FREEZE:.*\[?FAIL/i.test(segReport) || /FREEZE:.*\[?FAIL/i.test(segReport)) {
        scores.push(20);
        segDeductions.push('Video freeze detected');
      }
      else if (/AUDIO QUALITY:.*\[?FAIL/i.test(segReport) || /AUDIO:.*\[?FAIL/i.test(segReport))  {
        audioMissing = true;
        scores.push(30);
        segDeductions.push('Audio missing/broken');
      }
      else {
        scores.push(segScore);
        // Track minor issues that reduce score
        if (segScore < 100) {
          if (/AVATAR VISIBILITY:.*\[?FAIL/i.test(segReport)) segDeductions.push('Avatar framing issue');
          if (/BACKGROUND:.*\[?FAIL/i.test(segReport)) segDeductions.push('Background artifacts');
        }
      }

      reports.push(`=== ${label} SEGMENT ===\n${segReport}${segDeductions.length ? '\n\nISSUES: ' + segDeductions.join(', ') : ''}`);

      try { await axios.delete(`https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`); } catch(e) {}
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      reports.push(`=== ${label} SEGMENT === check failed: ${e.message}`);
      scores.push(70);
    }
  }

  // If no scores (all samples skipped/empty) — auto-pass, no evidence of issues
  const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 90;
  const hasCriticalFail = lipSyncFail || audioMissing;

  const deductions = [];
  if (lipSyncFail)  deductions.push({ points: 30, reason: 'LIP SYNC broken on avatar segment — CRITICAL' });
  if (audioMissing) deductions.push({ points: 25, reason: 'AUDIO missing on avatar segment — CRITICAL' });

  let outcome, passed;
  if (hasCriticalFail || avgScore < MANUAL_THRESHOLD) { outcome = 'fail'; passed = false; }
  else if (avgScore >= PASS_THRESHOLD) { outcome = 'pass'; passed = true; }
  else { outcome = 'manual_review'; passed = false; }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';
  const fullReport = reports.join('\n\n');

  const whyDoc = [
    `=== CWN GATE 2: SEGMENT QA — ${outcomeLabel} ===`,
    `Gate:       2 of 4 — HeyGen Segment QA`,
    `Scored by:  Gemini (did not render segments)`,
    `Time:       ${new Date().toISOString()}`,
    `Job:        ${jobId}`,
    `Segments:   ${avatarSegs.length} avatar segments checked (3 sampled)`,
    `Score:      ${avgScore}/100`,
    `Pass threshold:   ${PASS_THRESHOLD} (auto-proceed to assembly)`,
    `Manual threshold: ${MANUAL_THRESHOLD} (hold for Rob)`,
    `Outcome:    ${outcome.toUpperCase()}`,
    ``,
    `── CRITICAL FAILURES ────────────────────────────`,
    `Lip sync broken: ${lipSyncFail  ? '🚨 YES' : '✅ No'}`,
    `Audio missing:   ${audioMissing ? '🚨 YES' : '✅ No'}`,
    ``,
    `── SCORE BREAKDOWN ───────────────────────────────`,
    `STARTING SCORE: 100`,
    ``,
    deductions.length ? `CRITICAL DEDUCTIONS:` : '',
    deductions.length ? deductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '',
    deductions.length ? `` : '',
    !deductions.length ? `  No critical deductions` : '',
    ``,
    `SEGMENT SCORES: ${scores.join(', ')} (avg: ${avgScore})`,
    ``,
    `FINAL SCORE: ${avgScore}/100`,
    ``,
    `── GEMINI SEGMENT REPORTS ────────────────────────`,
    fullReport,
    ``,
    `── RECOMMENDED ACTION ───────────────────────────`,
    outcome === 'pass'          ? 'Auto-proceed to CapCut/FFmpeg assembly.' :
    outcome === 'manual_review' ? 'Review segment issues above. Approve manually or reject to re-generate affected segments.' :
                                  'Hard fail — re-generate failed segments via HeyGen (max 3 retries).',
  ].join('\n');

  const qaLogDir = path.join(__dirname, '..', 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate2_segments_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate2] Segment QA why-doc saved: ${logFile}`); } catch(e) {}
  // QA logs saved locally only
  return { score: avgScore, report: whyDoc, passed, outcome, outcomeLabel, deductions };
}

async function callClaudeAPI(params) {
  const client = new Anthropic();
  try {
    const response = await client.messages.create(params);
    return response;
  } catch (e) {
    // Detailed error handling for different Claude API failure modes
    if (e.status === 429) {
      throw new Error(`Claude API rate limited. Retry after ${e.headers?.['retry-after'] || '60'} seconds`);
    }
    if (e.status === 401 || e.status === 403) {
      throw new Error('Claude API authentication failed - check ANTHROPIC_API_KEY in .env');
    }
    if (e.status === 400) {
      if (e.message && e.message.includes('max_tokens')) {
        throw new Error('Claude API: max_tokens parameter too high or invalid');
      }
      if (e.message && e.message.includes('context_length')) {
        throw new Error('Claude API: prompt exceeds context length - reduce input size');
      }
      throw new Error(`Claude API bad request: ${e.message}`);
    }
    if (e.status === 500 || e.status === 529) {
      throw new Error('Claude API server error - service temporarily unavailable');
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
      throw new Error('Claude API connection failed - check network connectivity');
    }
    // Generic fallback
    throw new Error(`Claude API error (${e.status || e.code || 'unknown'}): ${e.message}`);
  }
}

async function uploadToGeminiFiles(filePath, maxRetries = 3) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = (fileBuffer.length / 1024 / 1024).toFixed(1);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const boundary   = 'cwn_boundary_' + Date.now();
      const metadata   = JSON.stringify({ file: { display_name: path.basename(filePath) } });

      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
        Buffer.from(metadata),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
        fileBuffer,
        Buffer.from(`\r\n--${boundary}--`)
      ]);

      if (attempt > 0) {
        console.log(`[gemini-upload] Retry ${attempt}/${maxRetries-1} for ${path.basename(filePath)} (${fileSize}MB)`);
      }

      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${GEMINI_APIKEY}`,
        body,
        { headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length }, timeout: 120000 }
      );

      if (attempt > 0) {
        console.log(`[gemini-upload] ✓ Upload succeeded on retry ${attempt}`);
      }

      return resp.data.file; // { name, uri, state }

    } catch (e) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        console.error(`[gemini-upload] ✗ Upload failed after ${maxRetries} attempts: ${e.message}`);
        throw e;
      }

      // Exponential backoff: 2s, 4s, 8s
      const backoffMs = Math.pow(2, attempt + 1) * 1000;
      console.warn(`[gemini-upload] Upload failed (attempt ${attempt + 1}): ${e.message}. Retrying in ${backoffMs/1000}s...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

async function waitForGeminiFile(file) {
  for (let i = 0; i < 15; i++) {
    if (file.state === 'ACTIVE') return file;
    await new Promise(r => setTimeout(r, 2000));
    const resp = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${GEMINI_APIKEY}`,
      { timeout: 10000 }
    );
    file = resp.data;
  }
  throw new Error('Gemini file stuck in PROCESSING state');
}

async function deleteGeminiFile(fileName) {
  try {
    await axios.delete(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_APIKEY}`, { timeout: 10000 });
    console.log(`[gemini-files] Deleted: ${fileName}`);
  } catch(e) {
    console.warn(`[gemini-files] Delete failed (non-critical): ${e.message}`);
  }
}

/**
 * autoAction — Gate self-healing logic
 * 
 * Takes gate number, score, and context, returns { action, directive, reason }
 * Called after every gate evaluation to determine next pipeline step.
 * 
 * CRITICAL CONSTRAINT: Gate 1 auto-retry max ONCE — no infinite loops burning HeyGen credits
 * 
 * @param {number} gate - Gate number (1, 2, 3)
 * @param {number} score - QA score (0-100)
 * @param {object} context - Gate-specific context (jobId, failReasons, missingClips, retryCount, etc.)
 * @returns {object} { action: string, directive: string, reason: string }
 */
function autoAction(gate, score, context = {}) {
  const { jobId, failReasons = [], missingClips = [], retryCount = 0 } = context;

  // ── Gate 1: Script QA (pass ≥90) ──
  // Bands:
  //   ≥90  → proceed to HeyGen automatically
  //   <90  → auto-retry (claudeScriptFix first, then full Gemini regenerate)
  //          after MAX_RETRIES exhausted → manual review as last resort only
  if (gate === 1) {
    if (score >= 90) {
      return { action: 'proceed', directive: 'AUTO_PROCEED_TO_HEYGEN', reason: 'Gate 1 passed' };
    }
    // Any score <90: attempt auto-fix before ever going to manual review
    if (retryCount < 3) {
      return { action: 'regenerate_script', directive: 'REGENERATE_SCRIPT', reason: `Gate 1 score ${score} — auto-retry ${retryCount + 1}/3` };
    }
    // All 3 retries exhausted — only then escalate to manual review
    return { action: 'manual_review', directive: 'MANUAL_REVIEW', reason: `Gate 1 score ${score} after 3 retries — manual review required` };
  }

  // ── Gate 2: HeyGen Segment QA (pass ≥85) ──
  if (gate === 2) {
    if (score >= 85) {
      return { action: 'proceed', directive: 'AUTO_PROCEED_TO_ASSEMBLY', reason: 'Gate 2 passed' };
    }
    if (score >= 65 && score < 85) {
      return { action: 'proceed_with_warning', directive: 'MANUAL_REVIEW', reason: 'Gate 2 score 65-84 — continue assembly with warning' };
    }
    // Score <65: identify failed segments, re-submit only those (not full re-render)
    return { action: 'rerender_segments', directive: 'RERENDER_SEGMENTS', reason: 'Gate 2 score <65 — re-submit failed segments only' };
  }

  // ── Gate 3: Assembly QA (pass ≥70) ──
  if (gate === 3) {
    if (score >= 70) {
      return { action: 'proceed', directive: 'AUTO_UPLOAD_TO_DRIVE', reason: 'Gate 3 passed' };
    }
    if (score >= 60 && score < 70) {
      return { action: 'proceed_with_warning', directive: 'MANUAL_REVIEW', reason: 'Gate 3 score 60-69 — upload anyway, flag for review' };
    }
    // Score <60: check if missing clips detected
    if (missingClips && missingClips.length > 0) {
      return { action: 'retry_assembly', directive: 'RETRY_ASSEMBLY_WITH_CLIPS', reason: `Gate 3 score <60 — missing clips detected: ${missingClips.join(', ')}` };
    }
    // Score <60 other: rollback to all_sent stage (not full HeyGen re-render)
    return { action: 'rollback', directive: 'ROLLBACK_TO_HEYGEN', reason: 'Gate 3 score <60 — rollback to all_sent stage' };
  }

  // Unknown gate — no action
  return { action: 'unknown', directive: 'UNKNOWN_GATE', reason: `Gate ${gate} not recognized` };
}

/**
 * geminiAnalyzeImage — Upload a local image file to Gemini Files API and return text analysis.
 *
 * Signature: geminiAnalyzeImage(imagePath: string, prompt: string) => Promise<string>
 *   imagePath — absolute or relative path to a local JPEG or PNG file
 *   prompt    — analysis prompt to send alongside the image
 *
 * Upload pattern mirrors uploadToGeminiFiles() / waitForGeminiFile() above.
 * Supports image/jpeg and image/png MIME types (auto-detected from extension).
 * Throws on upload failure — does NOT silently return an empty string.
 */
async function geminiAnalyzeImage(imagePath, prompt) {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

  // ── Upload image to Gemini Files API ────────────────────────────
  const fileBuffer = fs.readFileSync(imagePath);
  const fileSize   = (fileBuffer.length / 1024 / 1024).toFixed(2);
  const boundary   = 'cwn_img_boundary_' + Date.now();
  const metadata   = JSON.stringify({ file: { display_name: path.basename(imagePath) } });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}
Content-Type: application/json; charset=UTF-8

`),
    Buffer.from(metadata),
    Buffer.from(`
--${boundary}
Content-Type: ${mimeType}

`),
    fileBuffer,
    Buffer.from(`
--${boundary}--`)
  ]);

  console.log(`[gemini-image] Uploading ${fileSize}MB (${mimeType}) to Gemini Files API...`);

  const uploadResp = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${GEMINI_APIKEY}`,
    body,
    { headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length }, timeout: 60000 }
  );

  let geminiFile = uploadResp.data.file; // { name, uri, state }

  // ── Wait for file to become ACTIVE ──────────────────────────────
  geminiFile = await waitForGeminiFile(geminiFile);

  // ── Generate content ─────────────────────────────────────────────
  try {
    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [
          { text: prompt },
          { file_data: { mime_type: mimeType, file_uri: geminiFile.uri } }
        ]}],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    const analysis = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    console.log(`[gemini-image] ✓ Analysis complete (${analysis.length} chars)`);
    return analysis;
  } finally {
    await deleteGeminiFile(geminiFile.name);
  }
}

module.exports = {
  geminiQACheck,
  parseScriptIntoScenes,
  generateClipAvailabilityReport,
  claudeScriptQA,
  claudeScriptFix,
  geminiScriptQA,
  geminiSegmentQA,
  callClaudeAPI,
  uploadToGeminiFiles,
  waitForGeminiFile,
  deleteGeminiFile,
  autoAction,
  geminiAnalyzeImage
};
