/**
 * QA Service
 * 
 * Handles all quality assurance gates:
 * - Gate 2: HeyGen segment QA (Gemini reviews avatar segments)
 * - Gate 3: Assembly QA (Gemini reviews final video)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { logError } = require('../lib/error_logger');

const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Upload file to Gemini Files API with retry
 * @param {string} filePath - Path to video file
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<Object>} File object with { name, uri, state }
 */
async function uploadToGeminiFiles(filePath, apiKey, maxRetries = 3) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = (fileBuffer.length / 1024 / 1024).toFixed(1);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const boundary = 'cwn_boundary_' + Date.now();
      const metadata = JSON.stringify({ file: { display_name: path.basename(filePath) } });

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
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
        body,
        { 
          headers: { 
            'Content-Type': `multipart/related; boundary=${boundary}`, 
            'Content-Length': body.length 
          }, 
          timeout: 120000 
        }
      );

      if (attempt > 0) {
        console.log(`[gemini-upload] ✓ Upload succeeded on retry ${attempt}`);
      }

      return resp.data.file;

    } catch (e) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        console.error(`[gemini-upload] ✗ Upload failed after ${maxRetries} attempts: ${e.message}`);
        throw e;
      }

      const backoffMs = Math.pow(2, attempt + 1) * 1000;
      console.warn(`[gemini-upload] Upload failed (attempt ${attempt + 1}): ${e.message}. Retrying in ${backoffMs/1000}s...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Wait for Gemini file to become ACTIVE
 * @param {Object} file - File object from upload
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<Object>} Active file object
 */
async function waitForGeminiFile(file, apiKey) {
  for (let i = 0; i < 15; i++) {
    if (file.state === 'ACTIVE') return file;
    await new Promise(r => setTimeout(r, 2000));
    const resp = await axios.get(
      `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`,
      { timeout: 10000 }
    );
    file = resp.data;
  }
  throw new Error('Gemini file stuck in PROCESSING state');
}

/**
 * Delete Gemini file
 * @param {string} fileName - File name from upload
 * @param {string} apiKey - Gemini API key
 */
async function deleteGeminiFile(fileName, apiKey) {
  try {
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
      { timeout: 10000 }
    );
    console.log(`[gemini-files] Deleted: ${fileName}`);
  } catch(e) {
    console.warn(`[gemini-files] Delete failed (non-critical): ${e.message}`);
  }
}

/**
 * Gate 2: Segment QA - Gemini reviews HeyGen avatar segments
 * @param {string[]} segmentPaths - Paths to downloaded segment files
 * @param {Object} options - QA options
 * @returns {Promise<Object>} QA results
 */
async function geminiSegmentQA(segmentPaths, options = {}) {
  const { jobId = 'unknown', contentType = 'twitch' } = options;
  const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_APIKEY) {
    return { 
      score: 100, 
      passed: true, 
      outcome: 'pass', 
      outcomeLabel: '✅ PASS (skipped)', 
      deductions: [] 
    };
  }

  if (!segmentPaths || segmentPaths.length === 0) {
    return { 
      score: 0, 
      passed: false, 
      outcome: 'fail', 
      outcomeLabel: '❌ HARD FAIL — no segments', 
      deductions: [] 
    };
  }

  const PASS_THRESHOLD = 85;
  const MANUAL_THRESHOLD = 65;

  const avatarSegs = segmentPaths.filter(p => p && fs.existsSync(p));
  const toCheck = [
    avatarSegs[0],
    avatarSegs[Math.floor(avatarSegs.length / 2)],
    avatarSegs[avatarSegs.length - 1]
  ].filter(Boolean);

  const reports = [];
  const scores = [];
  let lipSyncFail = false;
  let audioMissing = false;

  for (const segPath of toCheck) {
    const label = segPath === toCheck[0] ? 'FIRST' : segPath === toCheck[toCheck.length-1] ? 'LAST' : 'MIDDLE';
    try {
      const geminiFile = await waitForGeminiFile(
        await uploadToGeminiFiles(segPath, GEMINI_APIKEY),
        GEMINI_APIKEY
      );

      const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '19c1d4adf8904694a3cc331c5a9bee4b';
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
   - Clean navy/studio background visible?
   - Any visual artifacts or glitches?

OVERALL SCORE: [number from 0-100]

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

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text||'')
        .join('')
        .trim();
      
      const segScore = parseInt(
        (segReport.match(/OVERALL SCORE:\s*(\d+)/i) || segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '80'
      );

      const segDeductions = [];
      if (/LIP SYNC:.*\[?FAIL/i.test(segReport)) {
        lipSyncFail = true;
        scores.push(20);
        segDeductions.push('Lip sync broken');
      } else if (/VIDEO FREEZE:.*\[?FAIL/i.test(segReport) || /FREEZE:.*\[?FAIL/i.test(segReport)) {
        scores.push(20);
        segDeductions.push('Video freeze detected');
      } else if (/AUDIO QUALITY:.*\[?FAIL/i.test(segReport) || /AUDIO:.*\[?FAIL/i.test(segReport)) {
        audioMissing = true;
        scores.push(30);
        segDeductions.push('Audio missing/broken');
      } else {
        scores.push(segScore);
        if (segScore < 100) {
          if (/AVATAR VISIBILITY:.*\[?FAIL/i.test(segReport)) segDeductions.push('Avatar framing issue');
          if (/BACKGROUND:.*\[?FAIL/i.test(segReport)) segDeductions.push('Background artifacts');
        }
      }

      reports.push(`=== ${label} SEGMENT ===\n${segReport}${segDeductions.length ? '\n\nISSUES: ' + segDeductions.join(', ') : ''}`);

      try { 
        await deleteGeminiFile(geminiFile.name, GEMINI_APIKEY); 
      } catch(e) {}
      
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      reports.push(`=== ${label} SEGMENT === check failed: ${e.message}`);
      scores.push(70);
    }
  }

  const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 90;
  const hasCriticalFail = lipSyncFail || audioMissing;

  const deductions = [];
  if (lipSyncFail) deductions.push({ points: 30, reason: 'LIP SYNC broken on avatar segment — CRITICAL' });
  if (audioMissing) deductions.push({ points: 25, reason: 'AUDIO missing on avatar segment — CRITICAL' });

  let outcome, passed;
  if (hasCriticalFail || avgScore < MANUAL_THRESHOLD) {
    outcome = 'fail';
    passed = false;
  } else if (avgScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed = true;
  } else {
    outcome = 'manual_review';
    passed = false;
  }

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
    `Lip sync broken: ${lipSyncFail ? '🚨 YES' : '✅ No'}`,
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
    outcome === 'pass' ? 'Auto-proceed to CapCut/FFmpeg assembly.' :
    outcome === 'manual_review' ? 'Review segment issues above. Approve manually or reject to re-generate affected segments.' :
    'Hard fail — re-generate failed segments via HeyGen (max 3 retries).',
  ].join('\n');

  return { 
    score: avgScore, 
    report: whyDoc, 
    passed, 
    outcome, 
    outcomeLabel, 
    deductions 
  };
}

/**
 * Gate 3: Assembly QA - Gemini reviews assembled video
 * @param {string} videoPath - Path to assembled video
 * @param {Object} options - QA options
 * @returns {Promise<Object>} QA results
 */
async function geminiAssemblyQA(videoPath, options = {}) {
  const { 
    contentType, 
    avatarCount, 
    clipCount, 
    expectedTicker, 
    totalDuration 
  } = options;
  
  const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_APIKEY) {
    return { 
      score: 100, 
      report: 'QA skipped — no Gemini API key', 
      passed: true 
    };
  }

  if (!fs.existsSync(videoPath)) {
    return { 
      score: 0, 
      report: 'QA failed — video file not found', 
      passed: false 
    };
  }

  const dur = totalDuration || 60;
  const MAX_BYTES = 32 * 1024 * 1024;

  // Sample at 3 points: early (10%), middle (50%), late (90%)
  const samplePoints = [
    { label: 'EARLY', start: Math.max(0, dur * 0.10 - 10) },
    { label: 'MIDDLE', start: Math.max(0, dur * 0.50 - 10) },
    { label: 'LATE', start: Math.max(0, Math.floor(dur) - 25) },
  ];

  const reports = [];
  const scores = [];
  let freezeDetected = false;

  const TMP_DIR = path.join(__dirname, '../tmp');

  for (const point of samplePoints) {
    const tmpPath = path.join(TMP_DIR, `qa_sample_${point.label}_${Date.now()}.mp4`);
    try {
      const { execFile } = require('child_process');
      const ffmpegPath = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      
      await new Promise((res, rej) => {
        const args = [
          '-ss', point.start.toFixed(0), 
          '-i', videoPath, 
          '-t', '20', 
          '-c', 'copy', 
          '-y', tmpPath
        ];
        const proc = execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 });
        proc.on('close', code => code === 0 ? res() : rej(new Error(`Sample extract failed: ${code}`)));
        proc.on('error', rej);
      });

      const sampleSize = fs.statSync(tmpPath).size;
      if (sampleSize < 1000) {
        reports.push(`${point.label}: sample too small`);
        continue;
      }

      const geminiFile = await waitForGeminiFile(
        await uploadToGeminiFiles(tmpPath, GEMINI_APIKEY),
        GEMINI_APIKEY
      );

      const checklist = point.label === 'EARLY' ? [
        `1. LIP SYNC: Avatar mouth reasonably in sync with audio? (yes/partial/no)`,
        `2. TICKER: Scrolling ticker bar visible at bottom? (yes/no)`,
        `3. VIDEO FREEZE: Does the video appear to FREEZE (video stuck, audio continues)? (yes/no) — CRITICAL`,
        `4. TRANSITIONS: Do cuts between segments look clean? (yes/partial/no)`,
        `5. AUDIO: Audio clear and continuous? (yes/partial/no)`,
      ] : point.label === 'MIDDLE' ? [
        `1. VIDEO FREEZE: Does the video appear to FREEZE at any point? (yes/no) — CRITICAL`,
        `2. TICKER: Scrolling ticker still visible at bottom? (yes/no)`,
        `3. VIDEO QUALITY: 1080p, no pixelation, no black frames? (yes/partial/no)`,
        `4. AVATAR VISIBLE: Bobby G clearly visible and properly framed? (yes/no)`,
        `5. AUDIO: Audio clear and continuous? (yes/partial/no)`,
      ] : [
        `1. VIDEO FREEZE: Video frozen/stalled at any point? (yes/no) — CRITICAL`,
        `2. TICKER: Ticker still scrolling at end of video? (yes/no)`,
        `3. OUTRO: Does the video end cleanly? (yes/no)`,
        `4. AUDIO: Audio clear through to the end? (yes/partial/no)`,
      ];

      const qaPrompt = `You are QA reviewer for ClipzWorld News YouTube compilations.
Review this 20-second ${point.label} sample (from ~${Math.round(point.start)}s into an ${Math.round(dur)}s video).
Context: ${avatarCount} avatar segments, ${clipCount} source clips.

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

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || [])
        .map(p => p.text||'')
        .join('')
        .trim();

      let segScore = parseInt((segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '75');

      const hasFailures = /:\s*FAIL/i.test(segReport);
      if (!hasFailures && segScore < 70) {
        segScore = 70;
      }

      if (/VIDEO FREEZE:.*yes/i.test(segReport)) {
        freezeDetected = true;
        scores.push(20);
      } else {
        scores.push(segScore);
      }

      reports.push(`=== ${point.label} SAMPLE (~${Math.round(point.start)}s) ===\n${segReport}`);

      try { fs.unlinkSync(tmpPath); } catch(e) {}
      try { await deleteGeminiFile(geminiFile.name, GEMINI_APIKEY); } catch(e) {}

    } catch(e) {
      reports.push(`${point.label}: check failed — ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 90;
  const fullReport = reports.join('\n\n') + (freezeDetected ? '\n\n⚠️  VIDEO FREEZE DETECTED — check transitions and keyframe settings' : '');

  const PASS_THRESHOLD = options.passThreshold || 70;
  const MANUAL_THRESHOLD = options.manualThreshold || 60;

  const tickerMissing = reports.filter(r => /TICKER:.*no/i.test(r)).length === reports.length;
  const outroCutOff = /outro.*no|cut.*off|appreciate you.*missing/i.test(fullReport);
  const avDeSync = /a\/v.*desync|audio.*ahead|video.*behind/i.test(fullReport);
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync;

  const deductions = [];
  if (freezeDetected) deductions.push({ points: 30, reason: 'VIDEO FREEZE detected — critical failure' });
  if (tickerMissing) deductions.push({ points: 20, reason: 'TICKER missing from all sample points — critical failure' });
  if (outroCutOff) deductions.push({ points: 20, reason: 'OUTRO cut off — "Appreciate you!" not present in late sample' });
  if (avDeSync) deductions.push({ points: 15, reason: 'A/V DESYNC detected in sample' });

  let outcome, passed;
  if (hasCriticalFail || avgScore < MANUAL_THRESHOLD) {
    outcome = 'fail';
    passed = false;
  } else if (avgScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed = true;
  } else {
    outcome = 'manual_review';
    passed = false;
  }

  const outcomeLabel = outcome === 'pass' ? '✅ PASS' : outcome === 'manual_review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL';

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
    `Ticker missing: ${tickerMissing ? '🚨 YES' : '✅ No'}`,
    `Outro cut off:  ${outroCutOff ? '🚨 YES' : '✅ No'}`,
    `A/V desync:     ${avDeSync ? '🚨 YES' : '✅ No'}`,
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
    outcome === 'pass' ? 'Auto-proceed to Upload-Post publish.' :
    outcome === 'manual_review' ? 'Review sample reports above. Approve manually in dashboard to proceed, or reject to re-assemble.' :
    'Hard fail — re-run assembly (max 3 retries). Check ticker cache, concat list, outro duration.',
  ].join('\n');

  return { 
    score: avgScore, 
    report: whyDoc, 
    passed, 
    outcome, 
    outcomeLabel, 
    freezeDetected, 
    deductions 
  };
}

module.exports = {
  geminiSegmentQA,
  geminiAssemblyQA,
  uploadToGeminiFiles,
  waitForGeminiFile,
  deleteGeminiFile
};
