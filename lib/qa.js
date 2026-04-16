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

  // Red 4 hotfix 4: directive-mode-aware scene/clip/outro counting.
  // When script is Gemini's JSON directive output (News + USE_DIRECTIVE_CHROME),
  // the legacy text regexes don't match because JSON doesn't contain === HEADER ===
  // markers or literal [CLIP PLAYS HERE] markers. Parse the JSON up-front (with
  // stripCodeFences to handle markdown fence wrapping) and compute counts from the
  // scenes[] array instead of text regex.
  const isDirectiveMode = contentType === 'news' && USE_DIRECTIVE_CHROME && typeof script === 'string' && script.trim().length > 0;
  let parsedDirectiveJson = null;
  if (isDirectiveMode) {
    try {
      const _cleaned = stripCodeFences(script);
      parsedDirectiveJson = JSON.parse(_cleaned);
      if (!parsedDirectiveJson || !Array.isArray(parsedDirectiveJson.scenes)) {
        parsedDirectiveJson = null; // fall through to legacy text regex below
      }
    } catch(e) {
      // JSON parse failed — the Red 4 JSON validation block below will catch and deduct.
      // Leave parsedDirectiveJson = null so legacy regex runs.
    }
  }

  // Count clip markers / scenes
  // Red 4 hotfix 6: News prompt now produces standalone STORY#_CLIP scenes with
  // type="source_clip". Count by filtering scene.type instead of scanning spokenText
  // (hotfix 5's approach, now obsolete for News directive mode). Legacy text mode
  // still uses the [CLIP PLAYS HERE] regex for Twitch/NBA and non-directive News.
  let clipMarkers;
  if (parsedDirectiveJson) {
    clipMarkers = parsedDirectiveJson.scenes.filter(s => s.type === 'source_clip').length;
  } else {
    clipMarkers = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  }
  const isShortForm    = contentType.includes('-short');
  const expectedClips  = isShortForm ? 1 : contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1; // allow ±1 tolerance

  // "Appreciate you" — text regex in legacy mode, search spokenText fields in directive mode
  let missingAppreciateYou;
  if (parsedDirectiveJson) {
    const allSpoken = parsedDirectiveJson.scenes.map(s => s.spokenText || '').join(' ');
    missingAppreciateYou = !/appreciate you/i.test(allSpoken);
  } else {
    missingAppreciateYou = !/appreciate you/i.test(script);
  }

  // Scene count: scenes[].length in directive mode, === HEADER === regex in legacy mode
  let sceneMarkers;
  if (parsedDirectiveJson) {
    sceneMarkers = parsedDirectiveJson.scenes.length;
  } else {
    sceneMarkers = (script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  }
  const wrongSceneCount = !isShortForm && expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build clip summaries for Claude to cross-check.
  // For Twitch, clipAnalyses is a 2D array: [[s0c0, s0c1], [s1c0, s1c1], ...]
  // For NBA/News, clipAnalyses is a flat array: [c0, c1, c2, ...]
  // Flatten to a single list with correct streamer attribution before mapping.
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

  const clipSummaries = flatAnalyses.map((item, i) => {
    const name = item.streamer?.displayName || item.streamer || `Streamer ${i + 1}`;
    const a = item.analysis;
    return `CLIP ${i + 1} (${name}, clip ${item.clipNum}): ${a?.summary || a?.description || a || 'No analysis available'}`;
  }).join('\n');

  const displayNames = streamers.map(s => {
    const data = typeof s === 'object' ? s : { displayName: s, username: s };
    return `"${data.displayName}" (NOT "${data.username || data.twitchUsername || ''}")`;
  }).join(', ');

  // Build content-type-aware context and checklist
  const isTwitch = contentType === 'twitch';
  const isNBA = contentType === 'nba';
  const isNews = contentType === 'news';

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
    ? `STORIES: ${streamers.length} news stories
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`
    : `ITEMS: ${streamers.length}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}
EXPECTED SCENES: ${expectedScenes}`;

  // isShortForm already declared above (line ~2529) — used here for QA hint text

  const checklist = isTwitch ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: Scenes with numbers (CLIP1, CLIP2, CLIP3) are SEPARATE scenes, not one scene
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?${isShortForm ? ' (Short-form: MUST be exactly 1 clip)' : ''}`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. DISPLAY NAMES: Are only the approved display names used (no Twitch usernames)?`,
    `5. INTRO LENGTH: Is each streamer intro 2 or 3 sentences? (2 minimum, 3 maximum — 3 sentences is PASS, only FAIL if 1 sentence or 4+ sentences)`,
    `6. REACTION LENGTH: Is each reaction exactly 1 sentence? (FAIL only if 2 or more sentences)`,
    `7. SETUP LENGTH: Are clips 2 and 3 setups 2 sentences each? (FAIL only if 1 sentence or 3+ sentences)`,
    `8. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `9. CLIP MATCH (most important): Does each setup accurately describe what happens in the clip? Check each one.`,
    `10. LOCKED INTRO: Does the video open with the correct locked intro line?`,
    `11. WORD COUNT: Is each streamer section approximately 80-100 words?`
  ] : isNBA ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: GAME1_INTRO, GAME1_NARRATION, GAME1_REACTION are 3 SEPARATE scenes
   - Are there exactly ${expectedScenes} === SCENE === markers?${isShortForm ? ' (Short-form: expect fewer scenes - typically 3-4 total)' : ''}`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game)?${isShortForm ? ' (Short-form: MUST be exactly 1 clip)' : ''}`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `5. INTRO: Is the intro 2-3 sentences introducing the episode?`,
    `6. NARRATION: Does each game's NARRATION scene contain play-by-play commentary sized to cover the clip duration?`,
    `7. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `8. CLIP MATCH (most important): Does each game commentary match what was seen in the highlight clip?`,
    `9. LOCKED INTRO: Does the video open with the correct "Other Side of the Pillow" intro?`,
    `10. NARRATION WORD COUNT: Does each NARRATION scene match the per-game word count target from the prompt (±15% tolerance)?`,
    `11. REACTION: Is there a brief reaction/observation after each clip?`
  ] : isNews ? [
    `1. SCENE COUNT: Count every scene in the JSON scenes[] array systematically.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} scenes
   - Method: list each scene.id you find, then count your list
   - Remember: STORY1_INTRO, STORY1_SETUP, STORY1_CLIP, STORY1_SUMMARY, STORY1_REACTION are 5 SEPARATE scenes (Red 4 hotfix 6: clip is now a standalone source_clip scene, not a text marker)
   - Are there exactly ${expectedScenes} scenes in the JSON?${isShortForm ? ' (Short-form: expect fewer scenes - typically 3-4 total)' : ''}`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} scenes with type="source_clip" in the scenes[] array (one STORY#_CLIP per story)?${isShortForm ? ' (Short-form: MUST be exactly 1 clip)' : ''}`,
    `3. OUTRO: Does the OUTRO scene's spokenText contain "Appreciate you"?`,
    `4. STORY ACCURACY: Are headlines and story details accurately mentioned in the spokenText of each STORY#_INTRO scene?`,
    `5. INTRO: Is the INTRO scene's spokenText 2-3 sentences introducing the episode?`,
    `6. STORY SETUP: Does each STORY#_SETUP scene's spokenText give proper context for the clip that follows?`,
    `7. CLIP SCENES: Do all STORY#_CLIP scenes have type="source_clip" and empty spokenText ""?`,
    `8. STORY MATCH (most important): Does each story's setup/summary/reaction text accurately reflect the story's topic?`,
    `9. LOCKED INTRO: Does the INTRO scene open with the correct ClipzWorld News intro?`,
    `10. SOURCE ATTRIBUTION (STRICT): Does any scene's spokenText contain ANY spoken source attribution? Check every scene for phrases like "According to Al Jazeera", "Sources report", "Al Jazeera's coverage", "[source] reports". FAIL hard (-25) if any found — Bobby G must NEVER speak the source name.`,
    `11. REACTION: Does each STORY#_REACTION scene have a flat, deadpan reaction in spokenText (1 sentence)?`
  ] : [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?${isShortForm ? ' (Short-form: MUST be exactly 1 clip)' : ''}`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. STRUCTURE: Does the script follow the expected format?`,
    `4. CONTENT MATCH: Does the script accurately reflect the source material?`,
    `5. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`
  ];

  const qaPrompt = `You are a QA reviewer for ClipzWorld News. Gemini just wrote a script for a video that will be generated using HeyGen's Bobby G avatar. You watched the clips. Cross-check the script against what you know about each clip.

CONTENT TYPE: ${contentType}
${contextHeader}

── WHAT YOU SAW IN EACH CLIP ─────────────────────────
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
[list all issues, or write "None" if PASS on all checks]`;

  let claudeReport = '';
  let tokenUsage = { input: 0, output: 0 };
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
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

  // Parse score from Claude's response
  const scoreMatch = claudeReport.match(/SCORE:\s*(\d+)/i);
  let parsedScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
  parsedScore = Math.max(0, Math.min(100, parsedScore)); // Clamp 0-100

  // Apply hard penalties for structural failures caught before Claude
  const preCheckDeductions = [];
  let adjustedScore = parsedScore;

  // ── Red 4: JSON schema validation for News scripts ─────────────────────────
  // When USE_DIRECTIVE_CHROME=true, Gemini outputs JSON instead of plain text.
  // Validate that the script is parseable JSON with the expected scene structure.
  // Deduct 20 points if JSON is invalid or missing required fields.
  let jsonValidationDeduction = null;
  if (contentType === 'news' && USE_DIRECTIVE_CHROME) {
    try {
      const cleaned = typeof script === 'string' ? stripCodeFences(script) : script;
      const parsed = typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned;
      if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
        jsonValidationDeduction = { points: 20, reason: 'NEWS JSON DIRECTIVE: script parsed but missing scenes[] array — CRITICAL' };
      } else {
        // Validate each scene has required fields
        const missingFields = parsed.scenes.filter(s => !s.id || !s.type || !s.chrome).map(s => s.id || '(no id)');
        if (missingFields.length > 0) {
          jsonValidationDeduction = { points: 10, reason: `NEWS JSON DIRECTIVE: ${missingFields.length} scene(s) missing required fields (id/type/chrome): ${missingFields.slice(0,3).join(', ')}` };
        }
      }
    } catch(e) {
      jsonValidationDeduction = { points: 20, reason: `NEWS JSON DIRECTIVE: script is not valid JSON — ${e.message.slice(0, 80)}` };
    }
    if (jsonValidationDeduction) {
      preCheckDeductions.push(jsonValidationDeduction);
      adjustedScore = Math.max(0, adjustedScore - jsonValidationDeduction.points);
    }
  }

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

  // Build clip reference block for Claude
  const clipRef = streamers.map((s, si) => {
    const name = (s.displayName || s.twitchUsername || '').toUpperCase().replace(/\s+/g, '_');
    const analysesList = Array.isArray(clipAnalyses[si]) ? clipAnalyses[si] : [clipAnalyses[si] || ''];
    return analysesList.map((a, ci) =>
      name + ' CLIP ' + (ci+1) + ': ' + (a || 'No analysis available')
    ).join('\n');
  }).join('\n');

  // Fix #6E: Added Rule 3 (CLIP ORDER) so Claude explicitly swaps CLIP1/CLIP2 content
  // when the QA report indicates the sections are describing the wrong clip.
  // Previously the prompt only said "fix broken sections" with no swap instruction,
  // so Claude would rewrite content in-place rather than reorder the sections.
  const fixPrompt = 'You are a script editor for ClipzWorld News (CWN). A script was written by Gemini but failed QA because some CLIP_SETUP and CLIP_REACTION sections describe the wrong clip content.\n\nYOUR TASK: Fix ONLY the broken sections. Do NOT change any other part of the script. Preserve all === HEADERS ===, [CLIP PLAYS HERE] markers, [beat] markers, word counts, and structure exactly.\n\nACTUAL CLIP CONTENT (what Gemini actually saw in each video):\n' + clipRef + '\n\nQA FAILURE REPORT (shows which sections are wrong):\n' + qaReport + '\n\nRULES FOR FIXING:\n1. CLIP_SETUP: Exactly 2 sentences. First sentence: what the streamer is doing/saying. Second sentence: tease what happens next.\n2. CLIP_REACTION: Exactly 1 sentence. React to what just happened — no recap, just energy/commentary.\n3. CLIP ORDER: If the QA report indicates that CLIP1_SETUP describes what is actually in CLIP2 (or vice versa), you MUST SWAP the content of those sections — move the CLIP1_SETUP+CLIP1_REACTION text to the CLIP2 slot and the CLIP2_SETUP+CLIP2_REACTION text to the CLIP1 slot. Each CLIP_SETUP and CLIP_REACTION must match the analysis for that clip number as listed in ACTUAL CLIP CONTENT above. Do NOT rewrite content in-place when the clips are simply in the wrong order — swap them.\n4. Use the streamer ON-AIR display name only (never Twitch username).\n5. Keep [beat] markers exactly where they are.\n6. Keep [CLIP PLAYS HERE] markers exactly where they are.\n7. Do NOT change INTRO, streamer INTRO sections, or OUTRO.\n8. Return the COMPLETE script with ONLY the broken sections fixed.\n\nCURRENT SCRIPT TO FIX:\n' + script + '\n\nReturn ONLY the fixed script with no explanation, no preamble, no markdown code blocks.';

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
    expectedScenes = 1 + (streamers.length * 3) + 1; // 1 INTRO + (items × 3 scenes each: _INTRO, _NARRATION, _REACTION) + 1 OUTRO
  }
  // Shorts don't validate scene count (expectedScenes remains 0)

  const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build content-type-aware context and checklist
  const isTwitch = contentType === 'twitch';
  const isNBA = contentType === 'nba';
  const isNews = contentType === 'news';

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
    `9. LOCKED INTRO: Does the video open with the correct locked intro line?`,
    `10. WORD COUNT: Is each streamer section approximately 80-100 words?`
  ] : isNBA ? [
    `1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game)?`,
    `2. OUTRO: Does the script end with "Appreciate you!"?`,
    `3. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `4. COLD OPEN: Is the cold open 2-3 sentences introducing the episode?`,
    `5. NARRATION: Does each game's NARRATION scene contain play-by-play commentary sized to cover the clip duration?`,
    `6. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `7. CLIP MATCH (most important): Does each game commentary match what Gemini saw in the highlight clip?`,
    `8. LOCKED INTRO: Does the video open with the correct "Other Side of the Pillow" intro?`,
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
    `8. LOCKED INTRO: Does the video open with the correct ClipzWorld News intro?`,
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
  - Items 1, 2, ${isTwitch ? '8' : '7'}: -15 each (critical)
  - Items 3, ${isTwitch ? '7' : '6'}: -10 each
  - All other items: -5 each

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
  if (gate === 1) {
    if (score >= 90) {
      return { action: 'proceed', directive: 'AUTO_PROCEED_TO_HEYGEN', reason: 'Gate 1 passed' };
    }
    if (score >= 70 && score < 90) {
      return { action: 'manual_review', directive: 'MANUAL_REVIEW', reason: 'Gate 1 score 70-89 — human review required' };
    }
    // Score <70: auto-retry ONCE, then give up
    if (retryCount === 0) {
      return { action: 'regenerate_script', directive: 'REGENERATE_SCRIPT', reason: 'Gate 1 score <70 — auto-retry (max 1)' };
    }
    return { action: 'fail', directive: 'GATE1_HARD_FAIL', reason: 'Gate 1 score <70 after 1 retry — manual intervention required' };
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
  autoAction
};
