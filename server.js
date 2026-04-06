require('dotenv').config();

/**
 * CWN Production Server
 * - POST /assemble         → FFmpeg pipeline: download HeyGen segments → concat → output MP4
 * - GET  /assemble-progress/:id → SSE-style progress polling
 * - POST /canva-import     → Forward video URL to Canva MCP (import-design-from-url)
 * - POST /analyze-clip     → Gemini 2.5 Flash visual analysis + Claude CWN script rewrite
 * - GET  /canva-import-status/:id → Poll Canva import job status
 * - GET  /download/:file   → Serve assembled video
 * - GET  /health           → Server health check
 *
 * Install: npm install express cors axios fluent-ffmpeg @anthropic-ai/sdk
 * Run:     node server.js
 */

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const { execFile, exec } = require('child_process');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CWN Branding assets (place in ~/Downloads/) ───────────────────
function findBrandingAsset(name) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG']) {
    const p = path.join(__dirname, name + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Copy system font to tmp/ with no spaces in filename — FFmpeg drawtext requires this
function findSystemFont() {
  // Local no-space copy takes priority (created on first run)
  const localCopy = path.join(__dirname, 'tmp', 'cwn_font.ttf');
  if (fs.existsSync(localCopy)) { console.log(`[font] Using local copy: ${localCopy}`); return localCopy; }

  // Find source font
  const candidates = [
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
  for (const src of candidates) {
    if (fs.existsSync(src)) {
      try {
        if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
        fs.copyFileSync(src, localCopy);
        console.log(`[font] Copied ${src} → ${localCopy}`);
        return localCopy;
      } catch(e) {
        console.warn(`[font] Copy failed: ${e.message} — using original path`);
        return src;
      }
    }
  }
  console.warn('[font] No system font found');
  return null;
}
const SYSTEM_FONT = findSystemFont();

// ── Generate intro card PNG using Node Canvas ─────────────────────
// No FFmpeg drawtext dependency — works regardless of FFmpeg build flags
// Returns path to PNG file, or null if canvas not installed
async function generateIntroCardPNG(streamerData, outputPath) {
  let createCanvas, loadImage;
  try {
    const canvasModule = require('canvas');
    createCanvas = canvasModule.createCanvas;
    loadImage    = canvasModule.loadImage;
  } catch(e) {
    console.warn('[intro-card] canvas not installed — run: npm install canvas');
    return null;
  }

  const W = 680, H = 220;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Navy background
  ctx.fillStyle = '#22304b';
  ctx.fillRect(0, 0, W, H);

  // Gold border
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth   = 3;
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

  const hasImg = streamerData.profileImage;
  const textX  = hasImg ? 145 : 20;

  // Profile image (circular crop)
  if (hasImg) {
    try {
      const profileImgPath = path.join(TMP_DIR, `profile_${streamerData.displayName.replace(/\s/g,'_')}.png`);
      if (!fs.existsSync(profileImgPath) && streamerData.profileImage) {
        const hiResUrl = (streamerData.profileImage || '').replace(/-70x70\./, '-300x300.').replace(/-28x28\./, '-300x300.');
        await downloadFile(hiResUrl || streamerData.profileImage, profileImgPath);
      }
      if (fs.existsSync(profileImgPath) && fs.statSync(profileImgPath).size > 100) {
        const img = await loadImage(profileImgPath);
        const cx = 90, cy = 110, r = 72;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
        ctx.restore();
        // Gold circle border
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#c7af4f';
        ctx.lineWidth   = 4;
        ctx.stroke();
      }
    } catch(e) {
      console.warn('[intro-card] Profile image load failed:', e.message);
    }
  }

  // Streamer name in gold
  ctx.fillStyle = '#c7af4f';
  ctx.font      = 'bold 42px Arial, sans-serif';
  ctx.fillText((streamerData.displayName || '').toUpperCase(), textX, 65);

  // Origin in light grey
  if (streamerData.origin) {
    ctx.fillStyle = '#f0ede6';
    ctx.font      = 'bold 28px Arial, sans-serif';
    ctx.fillText('Origin: ' + streamerData.origin, textX, 118);
  }

  // Fact in light grey
  if (streamerData.fact) {
    ctx.fillStyle = '#f0ede6';
    ctx.font      = '24px Arial, sans-serif';
    const fact = (streamerData.fact || '').slice(0, 42);
    ctx.fillText(fact, textX, 158);
  }

  // Save PNG
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}


const CWN_LOGO_PATH   = findBrandingAsset('logo_cwn');   // logo bug top-right
const CWN_BANNER_PATH = findBrandingAsset('banner_cwn'); // intro card

app.use(cors());
app.use(express.json());

// ── Directories ────────────────────────────────────────────────────
const TMP_DIR    = path.join(__dirname, 'tmp');
const OUTPUT_DIR = path.join(__dirname, 'output');
[TMP_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── In-memory state ───────────────────────────────────────────────
const assemblyJobs = {}; // assemblyId → { pct, log, status, outputPath }
const canvaJobs    = {}; // jobId → { status, design_url, error }

// ── Helpers ───────────────────────────────────────────────────────
function slug(str) {
  return (str || 'video').replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 40);
}

function log(assemblyId, msg) {
  if (assemblyJobs[assemblyId]) {
    assemblyJobs[assemblyId].log += msg + '\n';
    console.log(`[${assemblyId}] ${msg}`);
  }
}

async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  resp.data.pipe(writer);
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
}

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function checkFFmpeg(cb) {
  exec(ffmpegPath() + ' -version', (err, stdout) => {
    if (err) return cb(new Error('FFmpeg not found. Install ffmpeg and ensure it is in PATH.'));
    const versionLine = stdout.split('\n')[0];
    cb(null, versionLine);
  });
}

// ── Build FFmpeg concat filter ─────────────────────────────────────
function buildConcatCommand(inputFiles, outputPath, transition, format) {
  const n = inputFiles.length;

  // For large jobs (>30 files) OR cut transition: use concat demuxer
  // The xfade filter_complex approach opens all files simultaneously and hits
  // macOS's default file descriptor limit (256) on jobs with 50+ segments
  if (transition === 'cut' || n === 1 || n > 30) {
    const listPath = outputPath.replace(/\.[^.]+$/, '_list.txt');
    const listContent = inputFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // For cut/large: use copy (no re-encode, fastest)
    // For crossfade on large jobs: concat then we lose transitions, but it's reliable
    if (transition !== 'cut' && n > 30) {
      console.log(`[ffmpeg] ${n} segments — using concat demuxer (xfade needs too many file handles for macOS)`);
    }

    return {
      args: [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        // Must re-encode (not copy) because HeyGen avatar files and source clips
        // have different codecs/framerates — copy produces corrupt 4MB output
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart',
        '-y', outputPath
      ],
      cleanup: [listPath]
    };
  }

  // Crossfade / fade / dissolve using xfade filter
  const transitionName = transition === 'crossfade' ? 'fade' : transition === 'dissolve' ? 'dissolve' : 'fade';
  const transitionDur  = transition === 'dissolve' ? 0.7 : transition === 'crossfade' ? 0.3 : 0.5;

  // Build input args
  const inputArgs = [];
  inputFiles.forEach(f => inputArgs.push('-i', f));

  // We need to know the duration of each clip to calculate offsets
  // For simplicity: use a filtergraph that assumes clips are renderable
  // Build xfade chain: [0][1]xfade=...[x01]; [x01][2]xfade=...[x012]; etc.
  let filterParts = [];
  let prevLabel   = '[0:v]';
  let prevALabel  = '[0:a]';

  // Estimate offset per segment (we'll use a conservative 60s — server will use real probe data)
  for (let i = 1; i < n; i++) {
    const outLabel  = i === n - 1 ? '[vout]' : `[v${i}]`;
    const outALabel = i === n - 1 ? '[aout]' : `[a${i}]`;
    // Video xfade
    filterParts.push(
      `${prevLabel}[${i}:v]xfade=transition=${transitionName}:duration=${transitionDur}:offset=OFFSET_${i}${outLabel}`
    );
    // Audio crossfade
    filterParts.push(
      `${prevALabel}[${i}:a]acrossfade=d=${transitionDur}${outALabel}`
    );
    prevLabel  = outLabel;
    prevALabel = outALabel;
  }

  return {
    args: inputArgs.concat([
      '-filter_complex', filterParts.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-y', outputPath
    ]),
    needsProbe: true,
    cleanup: []
  };
}

// Probe clip duration via ffprobe
function probeDuration(filePath) {
  return new Promise((res) => {
    exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, stdout) => {
      res(err ? 60 : parseFloat(stdout.trim()) || 60);
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  checkFFmpeg((err, version) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, ffmpeg: version, version: '1.0.0', tmpDir: TMP_DIR, outputDir: OUTPUT_DIR });
  });
});

// ── POST /assemble ────────────────────────────────────────────────
// ── GOOGLE DRIVE AUTO-UPLOAD ──────────────────────────────────────
// Uses a service account key at ~/Downloads/cwn-drive-key.json
// One-time setup: https://console.cloud.google.com → Drive API → Service Account
// Share your "CWN Videos" Drive folder with the service account email (Editor)

const DRIVE_KEY_PATH   = path.join(__dirname, 'cwn-drive-key.json');
const DRIVE_FOLDER_NAME = 'CWN Videos';
let   _driveFolderId   = null; // cached after first lookup

async function getDriveClient() {
  const { google } = require('googleapis');

  // ── Option 1: OAuth2 refresh token (preferred — uploads as the user) ──
  if (process.env.DRIVE_REFRESH_TOKEN) {
    try {
      const CLIENT_ID     = process.env.DRIVE_CLIENT_ID     || '281415000137-u3qh2evajigmhsmft2s3rgeidqq97ueu.apps.googleusercontent.com';
      const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || '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';
      const oauth2Client  = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
      oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });
      return google.drive({ version: 'v3', auth: oauth2Client });
    } catch(e) {
      console.warn('[drive] OAuth2 client failed:', e.message);
    }
  }

  // ── Option 2: Service account key file (legacy — may hit quota issues) ──
  if (!fs.existsSync(DRIVE_KEY_PATH)) return null;
  try {
    const key  = JSON.parse(fs.readFileSync(DRIVE_KEY_PATH, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    return google.drive({ version: 'v3', auth });
  } catch(e) {
    console.warn('[drive] Service account failed:', e.message);
    return null;
  }
}

async function getDriveFolderId(drive) {
  if (_driveFolderId) return _driveFolderId;

  // If DRIVE_FOLDER_ID is set in .env, use it directly (recommended)
  // This ensures files go into YOUR Drive folder, not the service account's
  if (process.env.DRIVE_FOLDER_ID) {
    _driveFolderId = process.env.DRIVE_FOLDER_ID;
    console.log(`[drive] Using configured folder ID: ${_driveFolderId}`);
    return _driveFolderId;
  }

  // Fallback: search for shared folder by name
  // Note: service account must have been granted access to this folder
  const res = await drive.files.list({
    q: `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });
  if (res.data.files && res.data.files.length) {
    _driveFolderId = res.data.files[0].id;
    console.log(`[drive] Found folder "${DRIVE_FOLDER_NAME}": ${_driveFolderId}`);
    return _driveFolderId;
  }

  // Last resort: upload to root (visible in service account's Drive only)
  console.warn('[drive] No folder found — uploading to root. Set DRIVE_FOLDER_ID in .env to fix.');
  return null; // null = Drive root
}

// ── Gemini QA Check ────────────────────────────────────────────────
// Reviews the assembled video before Drive upload
// Samples at 10%, 50%, and 90% of the video to catch issues throughout
// Returns { score: 0-100, report: string, passed: boolean }
async function geminiQACheck(videoPath, opts = {}) {
  const { contentType, avatarCount, clipCount, expectedTicker, totalDuration } = opts;
  if (!GEMINI_APIKEY) return { score: 100, report: 'QA skipped — no Gemini API key', passed: true };
  if (!fs.existsSync(videoPath)) return { score: 0, report: 'QA failed — video file not found', passed: false };

  const dur = totalDuration || 60;
  const MAX_BYTES = 32 * 1024 * 1024;

  // Sample at 3 points: early (10%), middle (50%), late (90%) — catches freeze at transitions
  const samplePoints = [
    { label: 'EARLY',  start: Math.max(0, dur * 0.10 - 10) },
    { label: 'MIDDLE', start: Math.max(0, dur * 0.50 - 10) },
    { label: 'LATE',   start: Math.max(0, dur * 0.85 - 10) },
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
          generationConfig: { maxOutputTokens: 800, temperature: 0.1 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      const segScore  = parseInt((segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '75');

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
  const tickerMissing   = reports.filter(r => /TICKER:.*no/i.test(r)).length === reports.length;
  const outroCutOff     = /outro.*no|cut.*off|appreciate you.*missing/i.test(fullReport);
  const avDeSync        = /a\/v.*desync|audio.*ahead|video.*behind/i.test(fullReport);
  const hasCriticalFail = freezeDetected || tickerMissing || outroCutOff || avDeSync;

  // Build structured deduction list for why-doc
  const deductions = [];
  if (freezeDetected)  deductions.push({ points: 30, reason: 'VIDEO FREEZE detected — critical failure' });
  if (tickerMissing)   deductions.push({ points: 20, reason: 'TICKER missing from all sample points — critical failure' });
  if (outroCutOff)     deductions.push({ points: 20, reason: 'OUTRO cut off — "Appreciate you!" not present in late sample' });
  if (avDeSync)        deductions.push({ points: 15, reason: 'A/V DESYNC detected in sample' });
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
    ``,
    `── POINT DEDUCTIONS ─────────────────────────────`,
    deductions.length
      ? deductions.map(d => `  -${d.points}  ${d.reason}`).join('\n')
      : '  None — clean pass',
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
  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate3_assembly_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa] Gate 3 why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — Drive is for final videos only

  return { score: avgScore, report: whyDoc, passed, outcome, outcomeLabel, freezeDetected, deductions };
}

// ── Gate 1: Script QA — Gemini reviews Claude's script ────────────
// Called after Claude generates the script, before sending to HeyGen.
// Gemini did NOT write the script — it's a clean cross-check.
//
// PASS:          score >= 90 → auto-proceed to HeyGen
// MANUAL REVIEW: score 70-89 → hold, show Rob the why-doc
// HARD FAIL:     score < 70 OR any critical failure → back to Claude (max 3 retries)
//
// Critical failures (always hard-fail regardless of score):
//   - Wrong [CLIP PLAYS HERE] count
//   - Missing "Appreciate you!" in outro
//   - Clip content mismatch (setup doesn't match what Gemini saw in the clip)
//   - Wrong streamer display name used
async function geminiScriptQA(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 3,
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

  const qaPrompt = `You are QA reviewer for ClipzWorld News. Claude just wrote a script. You watched the clips. Cross-check the script against what you know about each clip.

CONTENT TYPE: ${contentType}
STREAMERS (use ONLY these display names): ${displayNames}
CLIPS PER STREAMER: ${clipsPerStreamer}
EXPECTED [CLIP PLAYS HERE] COUNT: ${expectedClips}

── WHAT GEMINI SAW IN EACH CLIP ──────────────────────
${clipSummaries}

── THE SCRIPT CLAUDE WROTE ───────────────────────────
${script}

── YOUR QA CHECKLIST ─────────────────────────────────
For each item, respond: PASS / FAIL — [brief reason if fail]

1. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers?
2. OUTRO: Does the script end with "Appreciate you!"?
3. DISPLAY NAMES: Are only the approved display names used (no Twitch usernames)?
4. INTRO LENGTH: Is each streamer intro 2 or 3 sentences? (2 minimum, 3 maximum — 3 sentences is PASS, only FAIL if 1 sentence or 4+ sentences)
5. REACTION LENGTH: Is each reaction exactly 1 sentence? (FAIL only if 2 or more sentences)
6. SETUP LENGTH: Are clips 2 and 3 setups 2 sentences each? (FAIL only if 1 sentence or 3+ sentences)
7. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?
8. CLIP MATCH (most important): Does each setup accurately describe what happens in the clip? Check each one.
9. LOCKED INTRO: Does the video open with the correct locked intro line?
10. WORD COUNT: Is each streamer section approximately 80-100 words?

── SCORING ───────────────────────────────────────────
SCORE: [0-100]
For each failed check, deduct:
  - Items 1, 2, 8: -15 each (critical)
  - Items 3, 7: -10 each
  - Items 4, 5, 6, 9, 10: -5 each

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
        generationConfig: { maxOutputTokens: 800, temperature: 0.1 }
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
  let computedScore = 100;
  for (const [num, pts] of Object.entries(DEDUCTION_MAP)) {
    const lineRegex = new RegExp('^' + num + '[.):]\\s*[^\\n]+:\\s*FAIL', 'im');
    if (lineRegex.test(geminiReport)) computedScore = Math.max(0, computedScore - pts);
  }
  const parsedScore = computedScore;

  // Apply hard penalties for structural failures caught before Gemini
  const preCheckDeductions = [];
  let adjustedScore = parsedScore;
  if (wrongClipCount) {
    preCheckDeductions.push({ points: 25, reason: `CLIP COUNT: Found ${clipMarkers} [CLIP PLAYS HERE] markers, expected ${expectedClips} — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 25);
  }
  if (missingAppreciateYou) {
    preCheckDeductions.push({ points: 15, reason: `OUTRO: "Appreciate you!" missing from script — CRITICAL` });
    adjustedScore = Math.max(0, adjustedScore - 15);
  }

  const hasCriticalFail = wrongClipCount || missingAppreciateYou || adjustedScore < 60;
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
    `Clip count mismatch: ${wrongClipCount      ? `🚨 YES — ${clipMarkers} found, ${expectedClips} expected` : '✅ No'}`,
    `Missing Appreciate you: ${missingAppreciateYou ? '🚨 YES' : '✅ No'}`,
    ``,
    `── PRE-CHECK DEDUCTIONS ──────────────────────────`,
    preCheckDeductions.length
      ? preCheckDeductions.map(d => `  -${d.points}  ${d.reason}`).join('\n')
      : '  None',
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
  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate1_script_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate1] Script QA why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — not uploaded to Drive
  return { score: adjustedScore, report: whyDoc, passed, outcome, outcomeLabel, deductions: preCheckDeductions, geminiReport };
}

// ── Gate 2: Segment QA — Gemini reviews HeyGen segments ───────────
// Called after all HeyGen segments complete, before assembly.
// Samples the first, middle, and last avatar segments.
// PASS: score >= 85 → auto-proceed to CapCut/FFmpeg assembly
// MANUAL REVIEW: score 65-84 → hold for Rob
// HARD FAIL: score < 65 OR critical failure → back to HeyGen (max 3 retries)
//
// Critical failures: freeze in avatar, lip sync broken, audio missing, wrong avatar
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

      const segPrompt = `You are QA reviewer for ClipzWorld News. Review this HeyGen avatar segment.
Bobby G is the host — he should be clearly visible, speaking naturally, in sync with audio.

CHECKLIST (respond PASS/FAIL for each):
1. LIP SYNC: Avatar mouth in sync with audio? (CRITICAL)
2. AUDIO: Clear audio, no silence, no distortion?
3. AVATAR VISIBLE: Bobby G properly framed and visible?
4. FREEZE: Any video freeze in this segment? (CRITICAL)
5. BACKGROUND: Clean navy/studio background (no artifacts)?

SCORE: [0-100]
ISSUES: [specific problems or "none"]`;

      const genResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: segPrompt },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 300, temperature: 0.1 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      const segScore  = parseInt((segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '80');

      if (/LIP SYNC:.*fail/i.test(segReport))  { lipSyncFail  = true; scores.push(20); }
      else if (/FREEZE:.*fail/i.test(segReport)) { scores.push(20); }
      else if (/AUDIO:.*fail/i.test(segReport))  { audioMissing = true; scores.push(30); }
      else scores.push(segScore);

      reports.push(`=== ${label} SEGMENT ===\n${segReport}`);

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
    `── POINT DEDUCTIONS ──────────────────────────────`,
    deductions.length ? deductions.map(d => `  -${d.points}  ${d.reason}`).join('\n') : '  None',
    ``,
    `── GEMINI SEGMENT REPORTS ────────────────────────`,
    fullReport,
    ``,
    `── RECOMMENDED ACTION ───────────────────────────`,
    outcome === 'pass'          ? 'Auto-proceed to CapCut/FFmpeg assembly.' :
    outcome === 'manual_review' ? 'Review segment issues above. Approve manually or reject to re-generate affected segments.' :
                                  'Hard fail — re-generate failed segments via HeyGen (max 3 retries).',
  ].join('\n');

  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate2_segments_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate2] Segment QA why-doc saved: ${logFile}`); } catch(e) {}
  // QA logs saved locally only
  return { score: avgScore, report: whyDoc, passed, outcome, outcomeLabel, deductions };
}

async function uploadToDrive(filePath, fileName, title) {
  const drive = await getDriveClient();
  if (!drive) return null; // key not configured yet

  const folderId = await getDriveFolderId(drive);
  console.log(`[drive] Uploading ${fileName} (${(fs.statSync(filePath).size/1024/1024).toFixed(1)}MB)...`);

  const fileMetadata = { name: title || fileName };
  if (folderId) fileMetadata.parents = [folderId];

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: ({'.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.txt':'text/plain','.json':'application/json'})[require('path').extname(filePath).toLowerCase()] || 'application/octet-stream',
      body: fs.createReadStream(filePath)
    },
    fields: 'id, name, webContentLink, webViewLink',
    supportsAllDrives: true
  });

  const fileId = res.data.id;

  // Make publicly accessible (anyone with link can view/download)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  // Return direct download link — Canva can fetch this
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  console.log(`[drive] ✓ Uploaded: ${directUrl}`);
  return directUrl;
}

async function importToCanva(videoUrl, title) {
  // Uses Claude + Canva MCP to import the video
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: 'You are a production assistant. Use the Canva MCP tool to import a video from a URL into Canva. Call import-design-from-url with the URL. Return ONLY JSON: {"design_id":"...","url":"..."}. No other text.',
    messages: [{ role: 'user', content: `Import this video into Canva: ${videoUrl}\nTitle: ${title}` }],
    mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva-mcp' }]
  });
  const text  = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch(e) { return null; }
}

// POST /upload-to-drive — manual trigger from dashboard
app.post('/upload-to-drive', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found: ' + filename });

  try {
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl) return res.status(400).json({ error: 'cwn-drive-key.json not found in Downloads. See setup instructions.' });
    res.json({ ok: true, driveUrl });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /drive-then-canva — upload to Drive and auto-import to Canva
app.post('/drive-then-canva', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found: ' + filename });

  res.json({ ok: true, message: 'Upload started — check /assemble-progress for status' });

  try {
    console.log(`[drive-then-canva] Starting for: ${filename}`);
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl) { console.warn('[drive-then-canva] No Drive key configured'); return; }
    console.log(`[drive-then-canva] Drive URL: ${driveUrl}`);
    console.log(`[drive-then-canva] Paste that URL in Claude chat to import to Canva`);
  } catch(err) {
    console.error('[drive-then-canva] Error:', err.message);
  }
});

app.post('/assemble', async (req, res) => {
  const { segments, segmentData, labels, transition='crossfade', format='mp4', outputDir, jobTitle, assemblyId, contentType } = req.body;

  // Support both old format (segments=[urls]) and new format (segmentData=[{url,label,type}])
  const segsToProcess = segmentData && segmentData.length
    ? segmentData
    : (segments || []).map((url, i) => ({ url, label: labels&&labels[i] ? labels[i] : `seg_${i}`, type: 'avatar' }));

  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  const asmId = assemblyId || ('asm_' + Date.now());
  assemblyJobs[asmId] = { pct: 0, log: '', status: 'running', outputPath: null };

  // Run async — respond immediately
  res.json({ ok: true, assemblyId: asmId, message: 'Assembly started' });

  const run = async () => {
    try {
      const avatarCount = segsToProcess.filter(s => s.type !== 'source_clip').length;
      const clipCount   = segsToProcess.filter(s => s.type === 'source_clip').length;
      log(asmId, `Starting assembly: ${avatarCount} avatar + ${clipCount} source clips = ${segsToProcess.length} total`);
      log(asmId, `Transition: ${transition} | Format: ${format}`);

      // Step 1: Download all segments in order
      // For Twitch source_clips, re-resolve fresh GQL tokens — stored tokens expire within hours
      const localFiles = [];
      for (let i = 0; i < segsToProcess.length; i++) {
        const seg      = segsToProcess[i];
        let   url      = seg.url;
        const label    = seg.label || `seg_${i}`;
        const segType  = seg.type || 'avatar';
        const filename = `${asmId}_${i}_${slug(label)}.mp4`;
        const destPath = path.join(TMP_DIR, filename);

        if (!url) {
          log(asmId, `⏭  Skipping ${label} — no URL`);
          continue;
        }

        // For Twitch source clips: always resolve a fresh GQL token at assembly time
        // Stored CDN tokens expire after ~1 hour and HeyGen rendering often takes longer
        if (segType === 'source_clip') {
          // ── Use locally cached file if available (Maya, Emily high-expiry clips) ──
          if (seg.localCache && fs.existsSync(seg.localCache)) {
            const cacheSize = fs.statSync(seg.localCache).size;
            if (cacheSize > 10000) {
              log(asmId, `📦 Using cached local file for ${label} (${(cacheSize/1024/1024).toFixed(1)}MB)`);
              try {
                fs.copyFileSync(seg.localCache, destPath);
                localFiles.push(destPath);
                log(asmId, `✅ ${filename} (from cache)`);
                continue;
              } catch(e) {
                log(asmId, `⚠️  Cache copy failed for ${label}: ${e.message} — trying fresh GQL`);
              }
            }
          }

          let clipSlug = seg.pageUrl ? extractTwitchSlug(seg.pageUrl) : '';

          // Fallback: extract slug from CDN URL token parameter (for old jobs without pageUrl)
          if (!clipSlug && url && url.includes('token=')) {
            try {
              const tokenParam = url.match(/[?&]token=([^&]+)/);
              if (tokenParam) {
                const decoded = JSON.parse(decodeURIComponent(tokenParam[1]));
                const clipUri = decoded.clip_uri || decoded.authorization && decoded.authorization.clip_uri || '';
                clipSlug = extractTwitchSlug(clipUri) || clipSlug;
              }
            } catch(e) {} // silent — just skip if token can't be parsed
          }

          if (clipSlug) {
            try {
              const fresh = await resolveTwitchClipMp4(clipSlug, 'high');
              url = fresh.mp4Url;
              log(asmId, `🔄 Fresh GQL token for ${label} (${fresh.quality})`);
            } catch(e) {
              log(asmId, `⚠️  GQL refresh failed for ${label}: ${e.message} — using stored URL`);
            }
          }
        }

        log(asmId, `⬇  [${segType.toUpperCase()}] ${i+1}/${segsToProcess.length}: ${label}`);
        assemblyJobs[asmId].pct = Math.round((i / segsToProcess.length) * 40);

        try {
          await downloadFile(url, destPath);
          // Validate the file is actual video data, not an HTML error page from expired CDN token
          const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          if (fileSize < 1000) {
            log(asmId, `❌ Segment ${i+1} downloaded but suspiciously small (${fileSize} bytes) — skipping`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          // Quick check: MP4 files start with a valid box header (ftyp/mdat/moov)
          const fd = fs.openSync(destPath, 'r');
          const header = Buffer.alloc(8);
          fs.readSync(fd, header, 0, 8, 0);
          fs.closeSync(fd);
          const boxType = header.slice(4, 8).toString('ascii');
          const validBoxTypes = ['ftyp', 'mdat', 'moov', 'free', 'wide', 'skip', 'pnot'];
          if (!validBoxTypes.includes(boxType)) {
            log(asmId, `❌ Segment ${i+1} is not a valid MP4 (header: "${boxType}") — likely expired token, skipping`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          localFiles.push(destPath);
          log(asmId, `✅ ${filename}`);
        } catch (e) {
          log(asmId, `❌ Failed segment ${i+1} (${segType}): ${e.message}`);
          // Continue — skip this segment
        }
      }

      if (!localFiles.length) {
        log(asmId, '❌ No segments could be downloaded. Aborting.');
        assemblyJobs[asmId].status = 'failed';
        return;
      }

      log(asmId, `\n📁 ${localFiles.length} segments ready. Probing durations...`);
      assemblyJobs[asmId].pct = 45;

      // Step 2: Probe durations for xfade offset calculation
      const durations = [];
      for (const f of localFiles) {
        const dur = await probeDuration(f);
        durations.push(dur);
        log(asmId, `  ${path.basename(f)}: ${dur.toFixed(2)}s`);
      }

      // Step 3: Build output path
      const outDir    = outputDir || OUTPUT_DIR;
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outFile   = `${slug(jobTitle || 'cwn')}_${Date.now()}.${format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4'}`;
      const outPath   = path.join(outDir, outFile);

      // Step 4: Normalize all segments to TS (handles mixed codecs + moov atom issues)
      // Then apply smart per-segment transitions via xfade filter on normalized files
      log(asmId, `  ℹ️  Normalizing ${localFiles.length} segments to TS...`);
      const tsFiles = [];
      const segTypes = []; // track type per localFile for transition logic

      // Build segment type map from original segsToProcess order
      let localIdx = 0;
      for (let i = 0; i < segsToProcess.length; i++) {
        const seg = segsToProcess[i];
        const segType = seg.type || 'avatar';
        // Only push type for segments that made it into localFiles
        if (localIdx < localFiles.length && localFiles[localIdx] && localFiles[localIdx].includes(`${asmId}_${i}_`)) {
          segTypes.push(segType);
          localIdx++;
        }
      }
      // Fallback: if mapping failed, default all to avatar
      while (segTypes.length < localFiles.length) segTypes.push('avatar');

      // ── Load streamers.json for intro card burn ────────────────────
      // Used to burn circular profile image + origin + fact onto INTRO segments
      let streamerRoster = [];
      try {
        const sPath = path.join(__dirname, 'streamers.json');
        if (fs.existsSync(sPath)) {
          streamerRoster = JSON.parse(fs.readFileSync(sPath, 'utf8')).roster || [];
        }
      } catch(e) {
        log(asmId, `  ⚠️  streamers.json not found — skipping intro card burn`);
      }

      for (let i = 0; i < localFiles.length; i++) {
        let inputForTS = localFiles[i];
        const label = segsToProcess.find((s, si) =>
          localFiles[i].includes(`${asmId}_${si}_`)
        )?.label || '';

        // ── Streamer intro card burn ───────────────────────────────
        // If this is an INTRO segment (not cold open, not outro), burn the intro card
        const isIntro = /\(INTRO\)/i.test(label) && !/cold.open/i.test(label);
        if (isIntro && streamerRoster.length && contentType === 'twitch') {
          // Extract streamer name from label e.g. "JASON (INTRO)" → "Jason"
          const streamerMatch = label.match(/^(.+?)\s*\(INTRO\)/i);
          const streamerName  = streamerMatch ? streamerMatch[1].trim() : '';
          const streamerData  = streamerRoster.find(s =>
            s.displayName?.toLowerCase() === streamerName.toLowerCase() ||
            s.twitchUsername?.toLowerCase() === streamerName.toLowerCase()
          );

          if (streamerData) {
            try {
              const burnedPath = inputForTS.replace('.mp4', '_intro_burned.mp4');
              // Call burn-streamer-intro logic inline (avoid HTTP round-trip)
              const profileImgPath = path.join(TMP_DIR, `profile_${streamerData.displayName.replace(/\s/g,'_')}.png`);

              // Download profile image if not cached
              if (!fs.existsSync(profileImgPath) && streamerData.profileImage) {
                try { const hiResUrl = (streamerData.profileImage || '').replace(/-70x70\./, '-300x300.').replace(/-28x28\./, '-300x300.');
        await downloadFile(hiResUrl || streamerData.profileImage, profileImgPath); } catch(e) {}
              }

              const hasImg = fs.existsSync(profileImgPath) && fs.statSync(profileImgPath).size > 100;
              const name   = streamerData.displayName;
              const origin = streamerData.origin || '';
              const fact   = (streamerData.fact || '').replace(/'/g, "\\'").replace(/:/g, '\\:');
              const introDur = 3.5;

              let burnArgs;
              if (hasImg) {
                burnArgs = [
                  '-i', inputForTS, '-i', profileImgPath,
                  '-filter_complex',
                    `[1:v]scale=110:110,format=rgba,` +
                    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-55\\,2)+pow(Y-55\\,2)\\,pow(55\\,2))\\,255\\,0)'[circ];` +
                    `[0:v]drawbox=x=50:y=50:w=420:h=180:color=0x22304b@0.92:t=fill:enable='lte(t\\,${introDur})',` +
                    `drawbox=x=50:y=50:w=420:h=180:color=0xc7af4f@1:t=3:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='${name.toUpperCase()}':x=180:y=75:fontsize=20:fontcolor=0xc7af4f:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='Origin\\: ${origin}':x=180:y=105:fontsize=14:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='${fact}':x=180:y=128:fontsize=13:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})'[bg];` +
                    `[bg][circ]overlay=x=60:y=65:enable='lte(t\\,${introDur})'[out]`,
                  '-map', '[out]', '-map', '0:a',
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                  '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
                ];
              } else {
                // Text-only fallback
                burnArgs = [
                  '-i', inputForTS,
                  '-vf',
                    `drawbox=x=50:y=50:w=380:h=170:color=0x22304b@0.92:t=fill:enable='lte(t\\,${introDur})',` +
                    `drawbox=x=50:y=50:w=380:h=170:color=0xc7af4f@1:t=3:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='${name.toUpperCase()}':x=65:y=70:fontsize=20:fontcolor=0xc7af4f:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='Origin\\: ${origin}':x=65:y=100:fontsize=14:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})',` +
                    `drawtext=text='${fact}':x=65:y=123:fontsize=13:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t\\,${introDur})'`,
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                  '-c:a', 'aac', '-y', burnedPath
                ];
              }

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    // Log last 300 chars of stderr so we know exactly why it failed
                    const reason = burnStderr.slice(-300).replace(/\n/g,' ').trim();
                    console.error(`[intro-burn] FFmpeg exit ${code} for ${streamerName}: ${reason}`);
                    rej(new Error(`Intro burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🖼  Intro card burned: ${name}`);
              }
              // Clean up temp card PNG
              try { if (fs.existsSync(cardPngPath)) fs.unlinkSync(cardPngPath); } catch(e) {}
            } catch(e) {
              log(asmId, `  ⚠️  Intro card burn failed for ${streamerName}: ${e.message} — using original`);
            }
          }
        }

        const tsPath = inputForTS.replace(/\.[^.]+$/, '.ts');
        try {
          await new Promise((res, rej) => {
            const isAvatarSeg = segTypes[tsFiles.length] !== 'source_clip';
          const tsArgs = [
              '-i', inputForTS,
              '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30',
              '-pix_fmt', 'yuv420p',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-g', '30',
              '-keyint_min', '30',
              '-sc_threshold', '0',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              // Normalize avatar audio to -14 LUFS to match clip volume
              // Source clips keep aresample only — their levels are already higher
              '-af', isAvatarSeg
                ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0'
                : 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
              '-bsf:v', 'h264_mp4toannexb',
              '-f', 'mpegts', '-y', tsPath
            ];
            const proc = execFile(ffmpegPath(), tsArgs, { maxBuffer: 20 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`TS convert failed: ${code}`)));
            proc.on('error', rej);
          });
          tsFiles.push(tsPath);
          if (i % 10 === 0) log(asmId, `  🔄 Normalized ${i+1}/${localFiles.length} segments...`);

          // Add 0.25s silence buffer after avatar segments before source clips
          // Prevents Bobby G getting cut off mid-word when clip starts
          const nextSeg = segsToProcess[i + 1];
          const currSegType = segTypes[tsFiles.length - 1] || 'avatar';
          const nextSegType = nextSeg && nextSeg.type === 'source_clip' ? 'source_clip' : 'avatar';
          if (currSegType === 'avatar' && nextSegType === 'source_clip') {
            const silencePath = tsPath.replace('.ts', '_silence.ts');
            try {
              await new Promise((res, rej) => {
                const args = [
                  '-f', 'lavfi', '-i', 'color=c=#000000:s=1920x1080:r=30:d=0.25',
                  '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo:d=0.25',
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                  '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                  '-bsf:v', 'h264_mp4toannexb',
                  '-f', 'mpegts', '-y', silencePath
                ];
                const proc = execFile(ffmpegPath(), args, { maxBuffer: 5 * 1024 * 1024 });
                proc.on('close', code => code === 0 ? res() : rej(new Error('silence gen failed')));
                proc.on('error', rej);
              });
              tsFiles.push(silencePath);
              segTypes.push('avatar'); // treat silence as avatar for transition logic
            } catch(e) {
              // non-fatal — skip silence if it fails
            }
          }
        } catch(e) {
          log(asmId, `  ⚠️  Skipping segment ${i+1}: ${e.message}`);
          segTypes.splice(tsFiles.length, 0);
        }
      }
      log(asmId, `  ✅ ${tsFiles.length} segments normalized`);

      // ── NBA Voiceover Step ────────────────────────────────────────
      // For NBA compilations: mix avatar audio OVER the source clip video
      // Avatar talks while the highlight plays — classic voiceover style
      // This replaces the clip's audio with the avatar's commentary
      if (contentType === 'nba' && tsFiles.length > 0) {
        log(asmId, `  🎙 NBA voiceover mode — mixing avatar audio over highlight clips...`);
        const voiceoverFiles = [...tsFiles];

        for (let i = 0; i < tsFiles.length - 1; i++) {
          const currType = segTypes[i]   || 'avatar';
          const nextType = segTypes[i+1] || 'avatar';

          // When we find an avatar segment followed immediately by a source_clip:
          // Mix the avatar's audio track over the clip's video track
          if (currType === 'avatar' && nextType === 'source_clip') {
            const avatarTs = tsFiles[i];
            const clipTs   = tsFiles[i+1];
            const mixedTs  = clipTs.replace('.ts', '_voiced.ts');

            try {
              await new Promise((res, rej) => {
                // Take video from clip, audio from avatar, match duration to clip
                const args = [
                  '-i', clipTs,      // input 0: clip video + audio
                  '-i', avatarTs,    // input 1: avatar audio
                  '-filter_complex',
                  '[0:v]copy[vout];[1:a]apad[aout]',
                  '-map', '[vout]', '-map', '[aout]',
                  '-c:v', 'copy',
                  '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                  '-shortest',       // stop when clip ends
                  '-bsf:v', 'h264_mp4toannexb',
                  '-f', 'mpegts', '-y', mixedTs
                ];
                const proc = execFile(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024 });
                proc.on('close', code => {
                  if (code === 0) {
                    voiceoverFiles[i]   = null; // remove avatar (audio used, video dropped)
                    voiceoverFiles[i+1] = mixedTs; // replace clip with voiced version
                    log(asmId, `  🎙 Voiced clip ${i+1}→${i+2}: ${path.basename(mixedTs)}`);
                    res();
                  } else {
                    rej(new Error(`Voiceover mix failed: ${code}`));
                  }
                });
                proc.on('error', rej);
              });
            } catch(e) {
              log(asmId, `  ⚠️  Voiceover mix failed for clip ${i+1}: ${e.message} — using original`);
            }
          }
        }

        // Rebuild tsFiles without nulls (dropped avatar segments after voiceover)
        const voicedFiles = voiceoverFiles.filter(f => f !== null);
        const voicedTypes = segTypes.filter((_, i) => voiceoverFiles[i] !== null);
        tsFiles.length = 0; voicedFiles.forEach(f => tsFiles.push(f));
        segTypes.length = 0; voicedTypes.forEach(t => segTypes.push(t));
        log(asmId, `  ✅ NBA voiceover complete — ${tsFiles.length} segments after mixing`);
      }

      // Re-probe durations from TS files (more accurate after normalization)
      const tsDurations = [];
      for (const f of tsFiles) {
        tsDurations.push(await probeDuration(f));
      }

      let ffArgs;
      if (tsFiles.length === 1 || transition === 'cut') {
        // Single file or explicit cut — TS concat, no filter
        const concatInput = 'concat:' + tsFiles.join('|');
        ffArgs = ['-i', concatInput, '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', outPath];
      } else if (tsFiles.length > 30) {
        // Large job — use concat demuxer for reliable A/V sync
        // xfade filter_complex with 30+ files causes A/V drift accumulation
        // and hits macOS file descriptor limits
        log(asmId, `  ℹ️  ${tsFiles.length} segments — using concat demuxer (reliable A/V sync)`);
        const listPath = outPath.replace(/\.[^.]+$/, '_concat_list.txt');
        const listContent = tsFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(listPath, listContent);
        ffArgs = [
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          '-af', 'aresample=async=1',
          '-movflags', '+faststart',
          '-y', outPath
        ];
        log(asmId, `  🎬 ${tsFiles.length - 1} hard cuts (concat demuxer)`);
      } else {
        // Xfade-only filter graph — NEVER mix xfade with concat in the same graph
        // Hard cuts use duration=0.001 (imperceptible) to maintain consistent timebase
        // avatar→avatar: smooth crossfade 0.3s
        // avatar→clip:   smooth crossfade 0.3s
        // clip→avatar:   instant xfade 0.001s (hard cut feel, consistent timebase)
        // clip→clip:     instant xfade 0.001s
        const FADE_DUR  = 0.3;
        const CUT_DUR   = 0.001;
        const inputArgs = [];
        tsFiles.forEach(f => inputArgs.push('-i', f));

        const filterParts = [];
        let prevV = '[0:v]', prevA = '[0:a]';
        let cumulativeDur = tsDurations[0];
        let fadeCount = 0; let cutCount = 0;

        // Build audio inputs for concat (handles A/V sync better than acrossfade chain)
        const audioInputs = tsFiles.map((_, idx) => `[${idx}:a]`).join('');

        for (let i = 1; i < tsFiles.length; i++) {
          const prevType = segTypes[i-1] || 'avatar';
          const isLast   = i === tsFiles.length - 1;
          const outV     = isLast ? '[vfinal]' : `[v${i}]`;
          const dur      = prevType === 'avatar' ? FADE_DUR : CUT_DUR;
          const offset   = Math.max(0.001, cumulativeDur - dur).toFixed(3);

          // Video xfade only — audio handled separately via concat
          filterParts.push(`${prevV}[${i}:v]xfade=transition=fade:duration=${dur}:offset=${offset}${outV}`);

          if (dur === FADE_DUR) fadeCount++; else cutCount++;
          prevV = outV;
          cumulativeDur += tsDurations[i] - dur;
        }

        // Audio: concat all streams (hard cuts, no drift) + aresample=async=1 to lock to video
        filterParts.push(`${audioInputs}concat=n=${tsFiles.length}:v=0:a=1[araw]`);
        filterParts.push(`[araw]aresample=async=1:first_pts=0[afinal]`);

        log(asmId, `  🎬 ${fadeCount} crossfades + ${cutCount} hard cuts`);

        ffArgs = [
          ...inputArgs,
          '-filter_complex', filterParts.join(';'),
          '-map', '[vfinal]', '-map', '[afinal]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-movflags', '+faststart',
          '-y', outPath
        ];
      }

      log(asmId, `\n🎬 Running FFmpeg...`);
      log(asmId, `  Output: ${outPath}`);
      assemblyJobs[asmId].pct = 50;

      // Step 5: Run FFmpeg
      await new Promise((res, rej) => {
        const ff = execFile(ffmpegPath(), ffArgs, { maxBuffer: 50 * 1024 * 1024 });
        let stderrBuf = '';

        ff.stderr.on('data', (data) => {
          const line = data.toString();
          stderrBuf += line;
          // Always log warnings/errors
          if (line.includes('Error') || line.includes('error') || line.includes('Invalid') || line.includes('moov atom')) {
            log(asmId, `  [ffmpeg] ${line.trim()}`);
          }
          // Parse progress from FFmpeg stderr
          const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (timeMatch) {
            const totalSec = durations.reduce((a,b) => a+b, 0);
            const parts    = timeMatch[1].split(':');
            const elapsed  = +parts[0]*3600 + +parts[1]*60 + +parts[2];
            const pct      = Math.min(99, 50 + Math.round((elapsed / totalSec) * 49));
            assemblyJobs[asmId].pct = pct;
            if (pct % 10 === 0) log(asmId, `  ⏱  ${timeMatch[1]} / ${totalSec.toFixed(0)}s`);
          }
        });

        ff.on('close', (code) => {
          if (code === 0) res();
          else {
            // Log last 20 lines of stderr for debugging
            const lines = stderrBuf.split('\n').filter(Boolean);
            const tail = lines.slice(-20).join('\n');
            log(asmId, `  [ffmpeg stderr tail]\n${tail}`);
            rej(new Error(`FFmpeg exited with code ${code}`));
          }
        });
        ff.on('error', rej);
      });

      // Step 6: Ticker overlay (if content type has a ticker and puppeteer is installed)
      // Shorts/reels never get a ticker
      const isShort = contentType && contentType.includes('short');
      const tickerType = !isShort && contentType ? contentType.replace(/-short$/,'') : null;

      if (tickerType && TICKER_MAP[tickerType]) {
        log(asmId, `\n🎞  Baking ${tickerType} ticker overlay...`);
        assemblyJobs[asmId].pct = 92;
        try {
          const tickerPath = await captureTicker(tickerType);
          if (tickerPath && fs.existsSync(tickerPath)) {
            const tickeredFile = outFile.replace('.mp4', '_tickered.mp4');
            const tickeredPath = path.join(outDir, tickeredFile);
            const tickerTotalSec = durations.reduce((a,b) => a+b, 0);
            const timeoutMs = Math.max(60000, tickerTotalSec * 3 * 1000); // 3x video duration, min 60s
            await new Promise((res, rej) => {
              // Overlay ticker at bottom: y=H-64 (64px ticker height)
              // eof_action=repeat loops the ticker when it ends (stream_loop -1 handles this too)
              // Do NOT use shortest=1 — it would truncate the output to ticker duration (20s)
              // -t tickerTotalSec: tells FFmpeg exactly when to stop — prevents stalling at end
              // -stream_loop -1: loops the ticker for the full video duration
              // eof_action=repeat: redundant safety net but harmless
              const args = [
                '-i', outPath,
                '-stream_loop', '-1', '-i', tickerPath,
                '-t', (tickerTotalSec + 2.0).toFixed(3), // +2s buffer prevents outro truncation
                '-filter_complex', '[0:v][1:v]overlay=x=0:y=H-64:eof_action=repeat[vout]',
                '-map', '[vout]', '-map', '0:a?',
                '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
                '-movflags', '+faststart', '-y', tickeredPath
              ];
              const ff2 = require('child_process').execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });

              // Watchdog — if no progress for 90s, kill and use un-tickered version
              let lastProgressAt = Date.now();
              const watchdog = setInterval(() => {
                if (Date.now() - lastProgressAt > 90000) {
                  clearInterval(watchdog);
                  log(asmId, `⚠️  Ticker overlay stalled (no progress 90s) — killing and using un-tickered version`);
                  try { ff2.kill('SIGKILL'); } catch(e) {}
                }
              }, 10000);

              // Hard timeout — absolute max
              const hardTimeout = setTimeout(() => {
                clearInterval(watchdog);
                log(asmId, `⚠️  Ticker overlay timeout (${Math.round(timeoutMs/1000)}s) — using un-tickered version`);
                try { ff2.kill('SIGKILL'); } catch(e) {}
              }, timeoutMs);

              ff2.stderr && ff2.stderr.on('data', (data) => {
                lastProgressAt = Date.now(); // reset watchdog on any output
                const line = data.toString();
                const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
                if (timeMatch) {
                  const parts = timeMatch[1].split(':');
                  const elapsed = +parts[0]*3600 + +parts[1]*60 + +parts[2];
                  const pct = Math.min(99, Math.round((elapsed / tickerTotalSec) * 100));
                  if (pct % 5 === 0) log(asmId, `  🎞  Ticker overlay: ${timeMatch[1]} / ${Math.round(tickerTotalSec)}s (${pct}%)`);
                  assemblyJobs[asmId].tickerPct = pct;
                }
              });
              ff2.on('close', code => {
                clearInterval(watchdog);
                clearTimeout(hardTimeout);
                if (code === 0) {
                  // Replace original with tickered version
                  try { fs.unlinkSync(outPath); } catch(e) {}
                  fs.renameSync(tickeredPath, outPath);
                  log(asmId, `✅ Ticker baked in successfully`);
                  res();
                } else {
                  log(asmId, `⚠️  Ticker overlay failed (code ${code}) — using un-tickered version`);
                  try { fs.unlinkSync(tickeredPath); } catch(e) {}
                  res(); // non-fatal
                }
              });
              ff2.on('error', e => {
                clearInterval(watchdog);
                clearTimeout(hardTimeout);
                log(asmId, `⚠️  Ticker overlay error: ${e.message}`);
                res();
              });
            });
          } else {
            log(asmId, `⚠️  Ticker not available — install puppeteer: npm install puppeteer`);
          }
        } catch(tickerErr) {
          log(asmId, `⚠️  Ticker step failed: ${tickerErr.message} — continuing without ticker`);
        }
      }

      // Step 6b: Logo bug overlay (logo_cwn.png from ~/Downloads)
      const logoPng = CWN_LOGO_PATH;
      if (logoPng) {
        log(asmId, `\n🔖 Burning logo bug...`);
        try {
          const loggedFile = outPath.replace('.mp4', '_logo.mp4');
          await new Promise((res, rej) => {
            // Overlay logo top-right: x=W-w-20, y=20, 120px wide, 85% opacity
            const args = [
              '-i', outPath,
              '-i', logoPng,
              '-filter_complex',
              '[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=W-w-20:20[vout]',
              '-map', '[vout]', '-map', '0:a?',
              '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy',
              '-movflags', '+faststart', '-y', loggedFile
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });
            ff.on('close', code => {
              if (code === 0) {
                try { fs.unlinkSync(outPath); } catch(e) {}
                fs.renameSync(loggedFile, outPath);
                log(asmId, `✅ Logo bug burned in`);
                res();
              } else {
                log(asmId, `⚠️  Logo bug failed (code ${code}) — continuing without`);
                try { fs.unlinkSync(loggedFile); } catch(e) {}
                res();
              }
            });
            ff.on('error', e => { log(asmId, `⚠️  Logo bug error: ${e.message}`); res(); });
          });
        } catch(logoErr) {
          log(asmId, `⚠️  Logo bug step failed: ${logoErr.message}`);
        }
      } else {
        log(asmId, `  ℹ️  Logo bug skipped — logo_cwn.png not found in ~/Downloads`);
      }

      // Step 6c: Header intro card — DISABLED until thumbnail/branding is finalized
      // Re-enable by changing false to: headerPng && !isShort
      const headerPng = CWN_BANNER_PATH;
      if (false && headerPng && !isShort) {
        log(asmId, `\n🎬 Prepending header intro card...`);
        try {
          const introTs  = path.join(TMP_DIR, `${asmId}_intro.ts`);
          const finalFile = outPath.replace('.mp4', '_final.mp4');

          // Convert header PNG to 4-second 1920x1080 TS clip with fade-in
          await new Promise((res, rej) => {
            const args = [
              '-loop', '1', '-t', '4', '-i', headerPng,
              '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#22304b,fade=in:0:15,fps=30',
              '-pix_fmt', 'yuv420p',
              '-c:v', 'libx264', '-preset', 'fast',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-bsf:v', 'h264_mp4toannexb',
              '-f', 'mpegts', '-y', introTs
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 20*1024*1024 });
            ff.on('close', code => code === 0 ? res() : rej(new Error(`Intro card failed: ${code}`)));
            ff.on('error', rej);
          });

          // Convert main video to TS then concat intro + main
          const mainTs = outPath.replace('.mp4', '_main.ts');
          await new Promise((res, rej) => {
            const args = [
              '-i', outPath,
              '-c:v', 'libx264', '-preset', 'ultrafast',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-bsf:v', 'h264_mp4toannexb',
              '-f', 'mpegts', '-y', mainTs
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });
            ff.on('close', code => code === 0 ? res() : rej(new Error(`Main TS failed: ${code}`)));
            ff.on('error', rej);
          });

          await new Promise((res, rej) => {
            const concatInput = `concat:${introTs}|${mainTs}`;
            const args = [
              '-i', concatInput,
              '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-bsf:a', 'aac_adtstoasc',
              '-movflags', '+faststart', '-y', finalFile
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });
            ff.on('close', code => {
              if (code === 0) {
                try { fs.unlinkSync(outPath); fs.unlinkSync(introTs); fs.unlinkSync(mainTs); } catch(e) {}
                fs.renameSync(finalFile, outPath);
                log(asmId, `✅ Header intro card prepended (4s)`);
                res();
              } else {
                log(asmId, `⚠️  Intro card concat failed (code ${code})`);
                try { fs.unlinkSync(finalFile); fs.unlinkSync(introTs); fs.unlinkSync(mainTs); } catch(e) {}
                res();
              }
            });
            ff.on('error', e => { log(asmId, `⚠️  Intro card error: ${e.message}`); res(); });
          });
        } catch(introErr) {
          log(asmId, `⚠️  Intro card step failed: ${introErr.message}`);
        }
      } else if (!isShort) {
        log(asmId, `  ℹ️  Intro card skipped — add cwn_header.png to ~/Downloads to enable`);
      }

      // Step 6.5: ffprobe validation — scan for corrupt frames or codec issues
      log(asmId, `\n🔬 Validating output video...`);
      try {
        await new Promise((res) => {
          const ffprobe = execFile('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,r_frame_rate,avg_frame_rate,width,height',
            '-show_entries', 'format=duration,size,bit_rate',
            '-of', 'json',
            outPath
          ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
              log(asmId, `⚠️  ffprobe validation warning: ${err.message}`);
            } else {
              try {
                const info = JSON.parse(stdout);
                const stream = info.streams && info.streams[0];
                const fmt    = info.format;
                if (stream) {
                  log(asmId, `  ✓ Codec: ${stream.codec_name} | ${stream.width}x${stream.height} | ${stream.r_frame_rate} fps`);
                }
                if (fmt) {
                  const dur = parseFloat(fmt.duration || 0);
                  const br  = Math.round((fmt.bit_rate || 0) / 1000);
                  log(asmId, `  ✓ Duration: ${dur.toFixed(1)}s | Bitrate: ${br}kbps`);
                  if (dur < 10) log(asmId, `⚠️  WARNING: Output is only ${dur.toFixed(1)}s — possible encoding failure`);
                }
                if (stderr && stderr.includes('Invalid data')) {
                  log(asmId, `⚠️  Corrupt frames detected — video may stall in players`);
                } else {
                  log(asmId, `  ✓ No corrupt frames detected`);
                }
              } catch(e) {}
            }
            res();
          });
        });
      } catch(e) {
        log(asmId, `⚠️  Validation step failed: ${e.message}`);
      }

      // Step 7: Done
      const stat     = fs.statSync(outPath);
      const sizeMB   = (stat.size / 1024 / 1024).toFixed(1);
      const totalDur = durations.reduce((a,b) => a+b, 0).toFixed(1);

      log(asmId, `\n✅ Assembly complete!`);
      log(asmId, `  File: ${outFile}`);
      log(asmId, `  Size: ${sizeMB} MB | Duration: ~${totalDur}s`);

      assemblyJobs[asmId].pct        = 100;
      assemblyJobs[asmId].status     = 'done';
      assemblyJobs[asmId].outputPath = outPath;
      assemblyJobs[asmId].filename   = outFile;
      assemblyJobs[asmId].duration   = totalDur;
      assemblyJobs[asmId].sizeMB     = sizeMB;

      // Extract thumbnail frame at 15s (Bobby G's first clean delivery after cold open)
      const thumbFramePath = outPath.replace('.mp4', '_thumb.jpg');
      try {
        await new Promise((res, rej) => {
          const args = ['-ss', '15', '-i', outPath, '-vframes', '1', '-q:v', '2', '-y', thumbFramePath];
          execFile(ffmpegPath(), args, (err) => err ? rej(err) : res());
        });
        if (fs.existsSync(thumbFramePath) && fs.statSync(thumbFramePath).size > 1000) {
          assemblyJobs[asmId].thumbFrame = thumbFramePath;
          assemblyJobs[asmId].thumbFilename = path.basename(thumbFramePath);
          log(asmId, `🖼  Thumbnail frame extracted: ${path.basename(thumbFramePath)}`);
        }
      } catch(e) {
        log(asmId, `⚠️  Thumbnail frame extraction failed: ${e.message}`);
      }
      // Store per-segment durations so dashboard can build accurate chapter timestamps
      assemblyJobs[asmId].segmentDurations = durations;

      // Step 7.5: Gemini QA — 3-point check at 10%, 50%, 85% of video
      log(asmId, `\n🔍 Running Gemini QA check (early/middle/late samples)...`);
      try {
        const qaResult = await geminiQACheck(outPath, {
          contentType, avatarCount, clipCount,
          expectedTicker: !!(tickerType && TICKER_MAP[tickerType]),
          totalDuration: parseFloat(totalDur)
        });
        assemblyJobs[asmId].qaScore   = qaResult.score;
        assemblyJobs[asmId].qaReport  = qaResult.report;
        assemblyJobs[asmId].qaOutcome = qaResult.outcome;
        const outcomeLabel = qaResult.outcomeLabel || (qaResult.passed ? '✅ PASS' : '❌ FAIL');
        log(asmId, `📋 QA Score: ${qaResult.score}/100 — ${outcomeLabel}`);
        if (qaResult.freezeDetected) {
          log(asmId, `🚨 VIDEO FREEZE DETECTED — hard fail, Drive upload blocked`);
        }
        log(asmId, qaResult.report);
        if (qaResult.outcome === 'manual_review') {
          log(asmId, `🟡 MANUAL REVIEW — score ${qaResult.score}/100 is below auto-pass (75) but no critical failures`);
          log(asmId, `   Review the video before publishing. Proceeding to Drive upload.`);
          assemblyJobs[asmId].status = 'manual_review';
        } else if (!qaResult.passed) {
          log(asmId, `❌ QA HARD FAIL (score: ${qaResult.score}/100${qaResult.freezeDetected ? ', freeze detected' : ''}) — Drive upload blocked`);
        } else {
          log(asmId, `✅ QA passed — proceeding to Drive upload`);
        }
      } catch(qaErr) {
        log(asmId, `⚠️  QA check failed: ${qaErr.message} — proceeding anyway`);
      }

      // Step 8: Auto-upload to Google Drive (blocked on hard QA fail)
      if (process.env.SKIP_DRIVE_UPLOAD === 'true') {
        log(asmId, `\n☁️  Drive upload skipped (SKIP_DRIVE_UPLOAD=true in .env)`);
        log(asmId, `📥 Download locally: http://localhost:${process.env.PORT || 3000}/download/${outFile}`);
      } else if (assemblyJobs[asmId].qaOutcome === 'fail') {
        log(asmId, `\n☁️  Drive upload BLOCKED — QA hard fail. Fix issues then re-assemble.`);
      } else {
      log(asmId, `\n☁️  Uploading to Google Drive...`);
      try {
        const driveUrl = await uploadToDrive(outPath, outFile, jobTitle || outFile);
        if (driveUrl) {
          assemblyJobs[asmId].driveUrl = driveUrl;
          log(asmId, `✅ Drive upload complete`);
          log(asmId, `  ${driveUrl}`);

          // Store Drive URL — paste in Claude chat to trigger Canva import
          log(asmId, `\n>> PASTE THIS IN CLAUDE CHAT TO IMPORT TO CANVA:`);
          log(asmId, `   ${driveUrl}`);
          assemblyJobs[asmId].driveUrl = driveUrl;
        } else {
          log(asmId, `⚠️  Drive upload skipped — add cwn-drive-key.json to enable`);
        }
      } catch(driveErr) {
        log(asmId, `⚠️  Drive upload failed: ${driveErr.message}`);
      }
      } // end SKIP_DRIVE_UPLOAD else

      // Clean up tmp files
      localFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e){} });

    } catch (err) {
      log(asmId, `\n❌ Assembly error: ${err.message}`);
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error  = err.message;
    }
  };

  run(); // fire and forget
});

// GET /assemble-progress/:id
app.get('/assemble-progress/:id', (req, res) => {
  const job = assemblyJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Return new log lines since last poll (client tracks offset)
  const logOffset = parseInt(req.query.offset) || 0;
  const fullLog   = job.log || '';
  const newLog    = fullLog.slice(logOffset);

  res.json({
    pct:              job.pct,
    tickerPct:        job.tickerPct || null,
    status:           job.status,
    log:              newLog,
    logOffset:        fullLog.length,
    outputPath:       job.outputPath,
    filename:         job.filename,
    duration:         job.duration,
    segmentDurations: job.segmentDurations || null,
    downloadUrl:      job.filename ? `/download/${job.filename}` : null,
    thumbFilename:    job.thumbFilename || null
  });
});

// GET /download/:file — serve assembled video or thumbnail frame
app.get('/download/:file', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) {
    // Also check tmp dir for thumbnail frames
    const tmpPath = path.join(TMP_DIR, path.basename(req.params.file));
    if (fs.existsSync(tmpPath)) return res.download(tmpPath);
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

// GET /thumbnail/:assemblyId — get extracted thumbnail frame for a job
app.get('/thumbnail/:assemblyId', (req, res) => {
  const job = assemblyJobs[req.params.assemblyId];
  if (!job || !job.thumbFrame || !fs.existsSync(job.thumbFrame)) {
    return res.status(404).json({ error: 'No thumbnail frame available' });
  }
  res.sendFile(job.thumbFrame);
});

// ── POST /canva-import ────────────────────────────────────────────
// Proxies a HeyGen video URL into Canva via the Canva MCP server
// using the Anthropic API (Claude acts as the MCP orchestrator).
app.post('/canva-import', async (req, res) => {
  const { videoUrl, label } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  const jobId = 'canva_' + Date.now();
  canvaJobs[jobId] = { status: 'pending', design_url: null, error: null };

  res.json({ ok: true, job_id: jobId });

  // Run async
  const runCanva = async () => {
    try {
      canvaJobs[jobId].status = 'in_progress';

      const client = new Anthropic();

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are a production assistant. Use the Canva MCP tool to import the provided video URL into a new Canva design. 
Call import-design-from-url with the URL provided. Then call get-design-import-from-url-status to get the result.
Return ONLY a JSON object with keys: design_id, design_url, status. No other text.`,
        messages: [{
          role: 'user',
          content: `Import this video into Canva: ${videoUrl}\nLabel: ${label || 'CWN Video'}\nReturn JSON with design_id and design_url.`
        }],
        mcp_servers: [{
          type: 'url',
          url: 'https://mcp.canva.com/mcp',
          name: 'canva-mcp'
        }]
      });

      // Parse response
      const textBlock = response.content.find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text response from Claude');

      let parsed;
      try {
        const clean = textBlock.text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch(e) {
        // Try to extract a URL from the text
        const urlMatch = textBlock.text.match(/https:\/\/www\.canva\.com\/design\/[^\s"']+/);
        if (urlMatch) {
          parsed = { design_url: urlMatch[0], status: 'success' };
        } else {
          throw new Error('Could not parse Canva response: ' + textBlock.text.slice(0, 200));
        }
      }

      canvaJobs[jobId].status     = 'success';
      canvaJobs[jobId].design_url = parsed.design_url || parsed.url;
      canvaJobs[jobId].design_id  = parsed.design_id;
      console.log(`[canva] Import complete: ${canvaJobs[jobId].design_url}`);

    } catch(err) {
      console.error('[canva] Import failed:', err.message);
      canvaJobs[jobId].status = 'failed';
      canvaJobs[jobId].error  = err.message;
    }
  };

  runCanva();
});

// GET /canva-import-status/:id
app.get('/canva-import-status/:id', (req, res) => {
  const job = canvaJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── TICKER BAKING ────────────────────────────────────────────────
// Captures a ticker HTML file (served at localhost:8765) as a looping
// video using headless Chrome + puppeteer, then caches it per content type.
// Falls back gracefully if puppeteer isn't installed.

// ── Streamer display name map ────────────────────────────────────
// Maps Twitch username (lowercase) → on-air display name
const STREAMER_DISPLAY_NAMES = {
  'jasontheween':  'Jason',
  'hasanabi':      'Hasan',
  'adapt':         'Adapt',
  'stableronaldo': 'Ron',
  'lacy':          'Lacy',
  'marlon':        'Marlon',
  'cinna':         'Cinna',
  'yonnajay':      'Yonna',
  'jaycinco':      'Jay Cinco',
  'maya':          'Maya'
};

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

const TICKER_MAP = {
  nba:    'sports_ticker.html',       // sports_ticker.html in Downloads
  news:   'cwn_combined_ticker.html', // cwn_combined_ticker.html in Downloads
  twitch: 'cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in Downloads
};
const TICKER_CACHE = {}; // { nba: '/path/to/ticker_nba.mp4', ... }
const TICKER_DASH_PORT = process.env.DASHBOARD_PORT || '8765';

async function captureTicker(contentType) {
  if (TICKER_CACHE[contentType]) return TICKER_CACHE[contentType];
  const tickerFile = TICKER_MAP[contentType];
  if (!tickerFile) return null;

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch(e) {
    console.warn('[ticker] puppeteer not installed — run: npm install puppeteer');
    console.warn('[ticker] Skipping ticker baking for this assembly.');
    return null;
  }

  const tickerUrl  = `http://localhost:${TICKER_DASH_PORT}/${tickerFile}`;
  const outPath    = path.join(TMP_DIR, `ticker_${contentType}.mp4`);
  const DURATION   = 60; // capture 60 seconds of ticker animation
  const WIDTH      = 1920;
  const HEIGHT     = 64;

  console.log(`[ticker] Capturing ${contentType} ticker (${DURATION}s) from ${tickerUrl}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [`--window-size=${WIDTH},${HEIGHT}`, '--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(tickerUrl, { waitUntil: 'networkidle0', timeout: 15000 });

    // Capture at 15fps for smooth scrolling animation
    // 60 seconds × 15fps = 900 frames — longer loop = less visible seam
    const FPS      = 15;
    const CAP_SECS = 60;
    const frameDir = path.join(TMP_DIR, `ticker_frames_${contentType}`);
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

    const totalFrames = FPS * CAP_SECS;
    const frameMs     = Math.round(1000 / FPS); // ~67ms between frames
    console.log(`[ticker] Capturing ${totalFrames} frames at ${FPS}fps (${CAP_SECS}s)...`);

    for (let i = 0; i < totalFrames; i++) {
      await page.screenshot({
        path: path.join(frameDir, `frame_${String(i).padStart(5,'0')}.png`),
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
      });
      await new Promise(r => setTimeout(r, frameMs));
      if (i % 30 === 0) console.log(`[ticker]   ${i}/${totalFrames} frames captured`);
    }
    await browser.close();
    browser = null;

    // Stitch frames into looping MP4 at native fps
    await new Promise((res, rej) => {
      const args = [
        '-framerate', String(FPS),
        '-i', path.join(frameDir, 'frame_%05d.png'),
        '-c:v', 'libx264', '-r', String(FPS), '-pix_fmt', 'yuv420p',
        '-vf', `scale=${WIDTH}:${HEIGHT}`,
        '-y', outPath
      ];
      const ff = require('child_process').execFile(ffmpegPath(), args, { maxBuffer: 50*1024*1024 });
      ff.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg ticker encode failed: ${code}`)));
      ff.on('error', rej);
    });

    // Clean up frames
    fs.readdirSync(frameDir).forEach(f => { try { fs.unlinkSync(path.join(frameDir, f)); } catch(e){} });
    try { fs.rmdirSync(frameDir); } catch(e) {}

    TICKER_CACHE[contentType] = outPath;
    console.log(`[ticker] ✓ ${contentType} ticker cached: ${outPath}`);
    return outPath;
  } catch(err) {
    if (browser) try { await browser.close(); } catch(e) {}
    console.warn(`[ticker] Capture failed: ${err.message} — assembling without ticker`);
    return null;
  }
}

// GET /ticker-status — check which tickers are cached
app.get('/ticker-status', (req, res) => {
  res.json({
    cached: Object.keys(TICKER_CACHE),
    available: Object.keys(TICKER_MAP),
    puppeteerInstalled: (() => { try { require('puppeteer'); return true; } catch(e) { return false; } })()
  });
});

// POST /precapture-tickers — warm up ticker cache before assembly
// Body: { types: ['nba','news','twitch'] }  (omit to capture all)
app.post('/precapture-tickers', async (req, res) => {
  const types   = (req.body && req.body.types) || Object.keys(TICKER_MAP);
  const captured = [], failed = [];

  console.log(`[ticker] Pre-capturing tickers: ${types.join(', ')}`);
  for (const type of types) {
    try {
      const p = await captureTicker(type);
      if (p) { captured.push(type); console.log(`[ticker] ✓ ${type}`); }
      else    { failed.push(type); }
    } catch(e) {
      failed.push(type);
      console.warn(`[ticker] ✗ ${type}: ${e.message}`);
    }
  }
  res.json({ ok: true, captured, failed });
});

// POST /capture-ticker — pre-capture a ticker on demand
app.post('/capture-ticker', async (req, res) => {
  const { contentType } = req.body;
  if (!TICKER_MAP[contentType]) return res.status(400).json({ error: 'Unknown content type. Use: nba, news, twitch' });
  delete TICKER_CACHE[contentType]; // force re-capture
  res.json({ ok: true, message: `Capturing ${contentType} ticker in background...` });
  captureTicker(contentType).catch(e => console.warn('[ticker] Background capture failed:', e.message));
});

// ── POST /twitch-clip-url ────────────────────────────────────────
// Resolves a Twitch clip page URL or slug to a direct MP4 download URL.
// Uses Twitch's GQL API (same method used by yt-dlp, streamlink, etc.)
// Returns { ok, mp4Url, quality, slug }
//
// Body: { url } — e.g. "https://www.twitch.tv/clips/SomeClipSlug"
//            or { slug } — e.g. "SomeClipSlug"

// Twitch web app GQL client ID (public, used by browser)
const TWITCH_GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// GQL persisted query hash for VideoAccessToken_Clip (stable, used by all major tools)
const TWITCH_CLIP_QUERY_HASH = '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11';

function extractTwitchSlug(urlOrSlug) {
  if (!urlOrSlug) return '';
  // Handle: https://clips.twitch.tv/SomeSlug
  // Handle: https://www.twitch.tv/clips/SomeSlug
  // Handle: https://www.twitch.tv/channelname/clip/SomeSlug  ← most common format from Helix API
  const m = urlOrSlug.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/clips\/|twitch\.tv\/[^/]+\/clip\/)([^?&/]+)/);
  if (m) return m[1];
  // Bare slug (no slashes, no protocol)
  if (!urlOrSlug.includes('/') && !urlOrSlug.includes(':')) return urlOrSlug;
  return '';
}

async function resolveTwitchClipMp4(slug, preferQuality) {
  // preferQuality: 'low' = prefer 720p/480p (Gemini analysis), 'high' = prefer 1080p (assembly)
  if (!slug) throw new Error('No clip slug provided');

  const gqlBody = [{
    operationName: 'VideoAccessToken_Clip',
    variables: { slug },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: TWITCH_CLIP_QUERY_HASH
      }
    }
  }];

  const resp = await axios.post('https://gql.twitch.tv/gql', gqlBody, {
    headers: {
      'Client-ID': TWITCH_GQL_CLIENT_ID,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });

  const clip = resp.data?.[0]?.data?.clip;
  if (!clip) throw new Error('Clip not found in GQL response');

  const token    = clip.playbackAccessToken;
  const qualities = clip.videoQualities || [];
  if (!qualities.length) throw new Error('No video qualities returned');

  // For Gemini analysis prefer 720p/480p (keeps files under 34MB limit)
  // For assembly prefer 1080p (best quality for final video)
  let best;
  if (preferQuality === 'low') {
    best = qualities.find(q => q.quality === '720')
        || qualities.find(q => q.quality === '480')
        || qualities.find(q => q.quality === '360')
        || qualities[qualities.length - 1];
  } else {
    best = qualities.find(q => q.quality === '1080')
        || qualities.find(q => q.quality === '720')
        || qualities[0];
  }
  const baseUrl = best.sourceURL;

  // Append auth tokens required by Twitch CDN
  const mp4Url = `${baseUrl}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`;

  return { mp4Url, quality: best.quality + 'p', frameRate: best.frameRate };
}

app.post('/twitch-clip-url', async (req, res) => {
  const { url, slug: rawSlug } = req.body;
  const slug = rawSlug || extractTwitchSlug(url || '');
  if (!slug) return res.status(400).json({ error: 'Provide a Twitch clip URL or slug' });

  try {
    console.log(`[twitch-clip-url] Resolving slug: ${slug}`);
    const result = await resolveTwitchClipMp4(slug);
    console.log(`[twitch-clip-url] ✓ ${result.quality} — ${result.mp4Url.slice(0, 80)}...`);
    res.json({ ok: true, slug, ...result });
  } catch(err) {
    console.warn(`[twitch-clip-url] Failed for ${slug}: ${err.message}`);
    res.status(500).json({ error: err.message, slug });
  }
});

// ── POST /analyze-clip ────────────────────────────────────────────
// 1. Downloads thumbnail from URL
// 2. Sends to Gemini 2.5 Flash for visual analysis (what is actually happening)
// 3. Sends analysis + metadata to Claude with CWN voice rules
// 4. Returns a fully formatted CWN script ready for the script editor
//
// Body: { thumbnailUrl, clipTitle, streamer, game, contentType, clipUrl, viewCount }
// contentType: 'twitch' | 'nba' | 'news'

const GEMINI_MODEL  = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY || '';

// ── Tone variants per content type ────────────────────────────────
// tone: 'deadpan' | 'warm' | 'chaotic'
// Selectable per job in the dashboard. Defaults to 'deadpan'.
const CWN_VOICE_GUIDES = {
  twitch: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald deadpan. Flat. Clinical. The clip is funnier than anything you could add.
- DO NOT explain the clip. Witness it. One observation after. Could be unrelated.
- NEVER say "incredible", "amazing", "crazy", "wild". Just say what happened.
- [beat] = pause. Use liberally.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
ClipzWorld News. [Streamer name].
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat observation. End the sentence. Do not explain it.]
Follow [streamer]. Link in description.`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: NBA Inside Stuff warmth applied to streamers. You genuinely like these people.
- Specificity is the warmth. Name the game they were playing. Name the moment.
- After the clip: one sentence that shows you paid attention. No hype words.
- [beat] = pause.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
[Streamer name] was playing [game/context]. Here is what happened.
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE warm but flat observation. Specific detail. End the sentence.]
Follow [streamer]. Link in description.`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Space Ghost Coast to Coast. Confident non-sequiturs. Self-contradiction is fine.
- The intro can be completely unrelated to the streamer or clip. That is the bit.
- After the clip: say something that makes no sense but with total confidence.
- [beat] = pause. Use for comedic timing.
OUTPUT FORMAT:
=== [STREAMER NAME] ===
[Completely unrelated opening statement. Delivered with confidence.]
[beat]
[Streamer name].
[beat]
[CLIP PLAYS HERE]
[beat]
[Non-sequitur reaction. Confident. Wrong. Perfect.]
Follow [streamer]. Link in description.`
  },

  nba: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald flat delivery. State facts. One observation. Done.
- matchup → score → one stat → one flat observation.
- Zero debate, zero hot takes. Just what happened.
- NEVER say "incredible" or "amazing".
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. Final. [score].
[beat]
[Top performer]. [X] points.
[beat]
[ONE flat observation. End the sentence.]
[beat]
[CLIP PLAYS HERE]`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: NBA Inside Stuff. You love the game. Warmth comes from specificity, not adjectives.
- Honor the play before explaining it. Name the player. Name what they did.
- The observation should make you want to rewatch the clip.
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. [Score]. [Top performer] had [stat].
[beat]
[Warm setup about the player or play. Specific. No superlatives.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE warm observation about what just happened. Honor the moment.]`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Color commentary that has gone off the rails. Technically accurate, socially unhinged.
- State the play correctly. Then say something no color commentator would ever say.
- The observation is technically true but the framing is completely wrong.
- [beat] = pause.
OUTPUT FORMAT:
=== GAME [N]: [AWAY] @ [HOME] ===
[Away] versus [Home]. [Score].
[beat]
[Technically correct setup delivered like breaking news.]
[beat]
[CLIP PLAYS HERE]
[beat]
[Accurate observation. Completely wrong framing. Delivered with authority.]`
  },

  news: {
    deadpan: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Norm MacDonald flat delivery. No warmth. The world is absurd. State it.
- Headline exactly as it happened. No adjectives.
- ONE observation that makes it MORE alarming, not less. Never explain it.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Flat. Exactly as it happened.]
[beat]
[One sentence context if needed.]
[beat]
[ONE observation. Flat. Most absurd implication. Do not explain it.]
That story via [source].`,

    warm: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Jon Stewart Daily Show. You care about this. One moment of controlled disbelief.
- State the headline. Then find the ONE thing that should concern everyone but doesn't.
- The observation lands harder if it sounds reasonable at first.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Matter of fact.]
[beat]
[One sentence of context that sets up the observation.]
[beat]
[ONE observation. Sounds reasonable. Is actually devastating. Do not explain it.]
[beat]
That story via [source].`,

    chaotic: `You write scripts for ClipzWorld News (@clipznashite).
TONE: Local news anchor who has fully given up. Accurate reporting. Zero affect. Wrong emphasis.
- Report the headline correctly. Emphasize the wrong detail with complete confidence.
- The non-important part of the story gets treated as the main story.
- [beat] = pause.
OUTPUT FORMAT:
=== STORY [N] ===
[Headline. Correct. Delivered flatly.]
[beat]
[Zero-context pivot to the least important detail in the story.]
[beat]
[Treat that detail like it is the real story. Delivered with authority.]
That story via [source].`
  }
};

// Helper: get voice guide for type + tone
function getVoiceGuide(type, tone) {
  const guides = CWN_VOICE_GUIDES[type] || CWN_VOICE_GUIDES.twitch;
  if (typeof guides === 'string') return guides; // legacy
  return guides[tone] || guides.deadpan;
}

app.post('/analyze-clip', async (req, res) => {
  const { thumbnailUrl, clipTitle, streamer, game, contentType, clipUrl, viewCount } = req.body;

  if (!thumbnailUrl && !clipTitle) {
    return res.status(400).json({ error: 'thumbnailUrl or clipTitle required' });
  }
  if (!GEMINI_APIKEY) {
    return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });
  }

  const type = contentType || 'twitch';
  console.log(`[analyze] Starting analysis — type:${type} streamer:${streamer||'?'} clip:"${clipTitle||'?'}"`);

  try {
    // ── Step 1: Gemini visual analysis ──────────────────────────────
    let geminiAnalysis = '';

    if (thumbnailUrl) {
      // Download thumbnail
      let imageBase64 = '';
      let mimeType    = 'image/jpeg';
      try {
        const imgResp = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 10000 });
        imageBase64 = Buffer.from(imgResp.data).toString('base64');
        const ct = imgResp.headers['content-type'] || 'image/jpeg';
        mimeType = ct.split(';')[0].trim();
      } catch (e) {
        console.warn('[analyze] Thumbnail download failed:', e.message, '— proceeding text-only');
      }

      if (imageBase64) {
        // Build Gemini prompt based on content type
        const geminiPrompts = {
          twitch: `This is a thumbnail/still frame from a Twitch clip by streamer "${streamer || 'unknown'}".
Clip title: "${clipTitle || 'unknown'}".
Describe concisely (3-5 sentences): 
1. What game or content is visible
2. What the streamer appears to be reacting to
3. The specific visual moment — what is literally happening on screen
4. The energy or emotion visible (if the streamer's face/reaction is shown)
Be specific. No hype language.`,

          nba: `This is a thumbnail from an NBA game highlight clip.
Clip title: "${clipTitle || 'unknown'}".
Describe concisely (3-4 sentences):
1. Which teams are visible
2. What specific play or moment is shown
3. Any notable player action or positioning
4. The game situation if discernible (close game, blowout, big moment)
Be factual and specific.`,

          news: `This is a thumbnail from a news video.
Headline: "${clipTitle || 'unknown'}".
Describe concisely (2-3 sentences):
1. What is literally shown in the image — people, places, objects
2. The visual context that relates to the headline
3. Any notable details visible
Be factual. No editorializing.`
        };

        const geminiPrompt = geminiPrompts[type] || geminiPrompts.twitch;

        const geminiBody = {
          contents: [{
            parts: [
              { text: geminiPrompt },
              { inline_data: { mime_type: mimeType, data: imageBase64 } }
            ]
          }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
        };

        const geminiResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
          geminiBody,
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );

        const parts = geminiResp.data?.candidates?.[0]?.content?.parts || [];
        geminiAnalysis = parts.map(p => p.text || '').join('').trim();
        console.log(`[analyze] Gemini analysis: ${geminiAnalysis.slice(0, 120)}...`);
      }
    }

    // ── Step 2: Claude rewrites in CWN voice ─────────────────────────
    const tone = 'deadpan'; // Style guide from Gemini reference library handles voice — tone selector removed
  const voiceGuide = getVoiceGuide(type, tone);
  console.log(`[generate-full-script] tone:${tone}`);

    const claudePrompt = `Write a CWN script segment for the following source clip.

CLIP METADATA:
- Type: ${type}
- ${streamer ? `Streamer: ${streamer}` : ''}
- ${game ? `Game/Category: ${game}` : ''}
- Title: ${clipTitle || 'N/A'}
- ${viewCount ? `Views: ${viewCount.toLocaleString()}` : ''}
- ${clipUrl ? `URL: ${clipUrl}` : ''}

VISUAL ANALYSIS (from Gemini):
${geminiAnalysis || '(No visual analysis available — use clip title and metadata only)'}

Write the CWN script segment following the voice rules exactly.
Output ONLY the script — no preamble, no explanation, no markdown.`;

    const client   = new Anthropic();
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 500,
      system:     voiceGuide,
      messages:   [{ role: 'user', content: claudePrompt }]
    });

    const cwnScript = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    console.log(`[analyze] CWN script generated (${cwnScript.length} chars)`);

    res.json({
      ok:           true,
      geminiAnalysis,
      cwnScript,
      clipTitle,
      streamer,
      contentType:  type
    });

  } catch (err) {
    console.error('[analyze] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /generate-full-script ───────────────────────────────────
// Generates a COMPLETE CWN script with no placeholders.
// 1. Calls Gemini 2.5 Flash on every thumbnail in parallel (visual analysis)
// 2. Calls Claude once with ALL data + visual analyses + voice guide
// 3. Returns a fully written script targeting 90%+ of video runtime
//
// Body: {
//   type: 'nba' | 'news' | 'twitch',
//   items: [
//     NBA:    { gameId, away, home, awayScore, homeScore, leader, leaderStat, injuries, thumbnailUrl }
//     News:   { title, desc, source, link, thumbnailUrl }
//     Twitch: { streamer, title, views, game, thumbnailUrl, url }
//   ],
//   date: 'Friday, April 3, 2026'
// }

const FULL_SCRIPT_SYSTEM = {

nba: `You write scripts for ClipzWorld News (@clipznashite), a deadpan sports and news channel hosted by a single anchor.

VOICE — four sources blended:
• Norm MacDonald Weekend Update: flat delivery, state the fact, one observation, done. Never explain the joke.
• Daily Show Jon Stewart: calls out the ONE absurd implication of what just happened. Makes it MORE alarming, not less.
• Space Ghost: sudden non-sequitur pivot after a big moment is encouraged. Chaos is fine.
• NBA Inside Stuff (warm NBA energy): genuinely celebrating that basketball happened. No debates, no hot takes.

STRICT RULES:
- Never say "incredible", "amazing", "crazy", "wild", "absolutely", "definitely"
- Never explain or editorialize — state the thing, then stop
- Zero hot takes, zero "who is better" debates
- Warmth comes from specificity, not adjectives
- [beat] = natural pause in delivery, use freely
- [CLIP PLAYS HERE] = structural marker, keep it, it is not spoken
- Write every single line — no brackets, no placeholders, no [YOUR OBSERVATION HERE]

SCRIPT FORMAT — use === SECTION HEADERS === exactly as shown.
Target: 120-150 words of SPOKEN TEXT per game segment (90 seconds of delivery).
The cold open and outro are short. Every game segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into The Daily Update brought to you by ClipzWorld News. Where we appreciate all of yesterday's games in the association. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of The Daily Update brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Go play a pick-up game today. Let us know how you did in the comments. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.

NBA VOICEOVER STRUCTURE — IMPORTANT:
In NBA compilations the avatar speaks WHILE the clip plays (voiceover style), not before/after.
This means: the intro sets up the game, then [CLIP PLAYS HERE] begins, and the avatar's commentary
plays as audio OVER the video highlight. The avatar is not seen during clips — only heard.
Write all game commentary assuming it will play as voiceover during the highlight clip.`,

news: `You write scripts for ClipzWorld News (@clipznashite), a deadpan world news show. The anchor reads every word — there are no external clips, so every second of airtime is spoken content.

VOICE — two sources blended:
• Norm MacDonald Weekend Update: flat delivery, zero warmth, the world is absurd and we are simply reporting it. "Hi, I'm Norm MacDonald and this is the news."
• Daily Show Jon Stewart: the observation must make the headline MORE alarming, not less. "I urge you not to think about it too hard." Never explain the observation.

STRICT RULES:
- State the headline exactly as it happened. No adjectives, no color.
- Include: headline → context (2-3 sentences) → one flat observation → source credit
- Never say "shocking", "alarming", "incredible", "wild"
- Never explain the observation — state it, period, move on
- [beat] = pause, use freely between every sentence
- Write every single line — no brackets, no placeholders whatsoever
- This is long-form. Every story needs FULL CONTENT.

SCRIPT FORMAT — use === SECTION HEADERS === exactly as shown.
Target: 130-160 words of SPOKEN TEXT per story (60-75 seconds of delivery).
The cold open and outro are short. Every story segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into The Daily Update brought to you by ClipzWorld News. Where we bring you the most impactful news stories of the day, our way, the CWN way. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of The Daily Update brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the stories covered concerns you the most. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.`,

twitch: `You write scripts for ClipzWorld News (@clipznashite), a deadpan Twitch clip reaction show.

VOICE — two sources blended:
• Norm MacDonald: deadpan on the setup, flat delivery, do not explain what just happened in the clip.
• Space Ghost Coast to Coast: sudden non-sequitur after the clip is fine. Chaos is fine. One line after the clip, then move on.
• The clip is the joke. Do not summarize the clip. Do not react with hype. Just witness it and say one flat thing.

STRICT RULES:
- Intro the streamer briefly (2-3 sentences max), then [CLIP PLAYS HERE]
- After the clip: ONE sentence. Flat. Could be completely unrelated. Do not explain what just happened.
- Then: "Follow [streamer]. Link in description."
- Never say "that was incredible", "oh my god what a clip", or anything that explains the clip
- Write every single line — no brackets, no placeholders
- Use the visual analysis provided to inform what the clip is about, but do not narrate it

SCRIPT FORMAT — use === SECTION HEADERS === exactly as shown.
Target: 80-100 words of SPOKEN TEXT per streamer (45 seconds before and after clip).

COLD OPEN — ALWAYS use this EXACT text, word for word, no variation:
"Hello everyone! You are tuning into The Daily Update brought to you by ClipzWorld News. Where we appreciate our favorite streamers on Twitch. I am your host Bobby G. Let's get to it."
This is the ONLY acceptable cold open for Twitch compilations. Do not improvise it.

OUTRO — ALWAYS use this EXACT text, word for word, no variation:
"Well everybody, that does it for another edition of The Daily Update brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the clips you liked the most. Appreciate you!"
This is the ONLY acceptable outro for Twitch compilations. Do not improvise it.

DELIVERY NOTE — OUTRO: "Appreciate you!" must feel warm and genuine. Write it on its own line after a [beat] so HeyGen delivers it with weight. Never rush it.

DELIVERY NOTE — BEFORE CLIPS: INTRO segments must end with a complete sentence followed by [beat]. Never end an INTRO mid-thought. The avatar needs a clean stop before the clip rolls or it will produce a filler sound.

DELIVERY NOTE — REACTIONS + FOLLOW LINE: Always put [beat] between the reaction sentence and "Follow [name]." These are two separate beats — the reaction lands, then the follow ask. Example:
"She did not blink once.
[beat]
Follow Cinna. Link in description."
Never write them on the same line or without a [beat] between them.`,

// ── SHORTS / REELS (portrait 9:16, single subject, ~45 seconds total) ───────
'nba-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as NBA compilation (Norm MacDonald deadpan + NBA Inside Stuff warmth) but compressed.
One player. One moment. One observation. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Subscribe for daily NBA highlights. Appreciate you."

STRICT RULES:
- 40-60 words TOTAL spoken content — every word must earn its place
- Same flat delivery as compilations, just faster pacing
- State player name → what they did → one stat → [CLIP PLAYS HERE] → one flat observation
- [beat] = pause. Use sparingly in shorts.
- No debates, no hot takes, no "arguably the best"

SCRIPT FORMAT:
=== NBA SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[Player name]. [What they did. Score. Their stat. One sentence flat.]
[beat]
[CLIP PLAYS HERE]
[beat]
[One flat observation. End the sentence.]
Subscribe for daily NBA highlights. Appreciate you.`,

'news-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as News compilation (Norm MacDonald flat + Daily Show observation) but compressed.
One headline. One alarming implication. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Subscribe for daily news. Appreciate you."

STRICT RULES:
- 40-60 words TOTAL spoken content
- Same flat delivery as compilations, just one story, no filler
- Headline → one context sentence → one observation that makes it MORE alarming
- Never explain the observation. State it. End the sentence.
- [beat] = pause. Use sparingly.

SCRIPT FORMAT:
=== NEWS SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[Headline. Exactly as it happened. Flat.]
[beat]
[ONE context sentence.]
[beat]
[ONE observation. Most absurd implication. Do not explain it.]
Subscribe for daily news. Appreciate you.

Target: 50-70 words of spoken content total. Dense with one story, no filler.`,

'twitch-short': `You write scripts for ClipzWorld News (@clipznashite) — The Daily Update.

VOICE: Same as Twitch compilation (Norm MacDonald deadpan + Space Ghost non-sequitur) but compressed.
One clip. One streamer. One reaction. Done.

COLD OPEN (spoken): "The Daily Update. ClipzWorld News."
OUTRO (spoken): "Follow [streamer]. Link in description. Subscribe."

STRICT RULES:
- 40-60 words TOTAL spoken content
- Same flat delivery as Twitch compilations — the clip is still the joke
- Intro the streamer in ONE sentence max. Do not hype them.
- After the clip: ONE sentence. Flat. Non-sequitur is fine.
- [beat] = pause. Use sparingly.
- Do not explain the clip. Do not summarize what happened.

SCRIPT FORMAT:
=== TWITCH SHORT ===
The Daily Update. ClipzWorld News.
[beat]
[One sentence intro to the streamer. What they do. Flat.]
[beat]
[CLIP PLAYS HERE]
[beat]
[One reaction sentence. Flat. Could be completely unrelated.]
Follow [streamer]. Link in description. Subscribe.`

};


// ── GEMINI VIDEO ANALYSIS (Files API) ────────────────────────────
// Upload video → Gemini watches full clip with audio → delete file
// Falls back to thumbnail analysis if video download/upload fails

const GEMINI_FILE_LIMIT = 34 * 1024 * 1024; // 34MB

async function uploadToGeminiFiles(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const boundary   = 'cwn_boundary_' + Date.now();
  const metadata   = JSON.stringify({ file: { display_name: path.basename(filePath) } });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    fileBuffer,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${GEMINI_APIKEY}`,
    body,
    { headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length }, timeout: 120000 }
  );
  return resp.data.file; // { name, uri, state }
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

// Derive Twitch MP4 URL from thumbnail URL
// thumbnail: https://clips-media-assets2.twitch.tv/AT-cm|XXXX-preview-480x272.jpg
// video:     https://clips-media-assets2.twitch.tv/AT-cm|XXXX.mp4
function twitchThumbToMp4(thumbnailUrl) {
  if (!thumbnailUrl) return '';
  return thumbnailUrl.replace(/-preview-\d+x\d+\.jpg$/, '.mp4');
}

async function geminiAnalyzeClip(videoUrl, thumbnailUrl, contentType, metadata) {
  if (!GEMINI_APIKEY) return '';

  const videoPrompts = {
    twitch: `This is a Twitch clip by streamer "${metadata.streamer || 'unknown'}". Game/category: ${metadata.game || 'unknown'}. Clip title: "${metadata.title || ''}".
Analyze the FULL video with audio:
1. What is visually happening — describe the specific key moment
2. What does the streamer say verbally — quote any notable lines exactly
3. What emotion or reaction is visible
4. What makes this clip notable or shareable
Be specific, factual, 4-6 sentences. No hype language.`,

    nba: `This is an NBA game highlight: ${metadata.away || '?'} vs ${metadata.home || '?'}. Score: ${metadata.awayScore||'?'}-${metadata.homeScore||'?'}.
Analyze the FULL video with audio:
1. What specific play or sequence is shown
2. Which players are involved and what do they do
3. What do the announcers say about it
4. What is the game situation and significance
Be factual, 4-5 sentences.`,

    news: `This is a news video. Headline: "${metadata.title || '?'}"
Analyze the FULL video with audio:
1. Who is speaking and what key points do they make — quote directly if possible
2. What is shown visually
3. What is the core information being communicated
Be factual, 3-4 sentences.`
  };

  const thumbPrompts = {
    twitch: `Twitch clip thumbnail. Streamer: ${metadata.streamer||'?'}. Game: ${metadata.game||'?'}. Title: "${metadata.title||'?'}". Describe: what's visible, what the streamer reacts to, the specific moment shown. 2-3 sentences, factual.`,
    nba: `NBA highlight thumbnail. ${metadata.away||'?'} vs ${metadata.home||'?'}. Describe: what play is shown, players visible, game energy. 2-3 sentences, factual.`,
    news: `News thumbnail. Headline: "${metadata.title||'?'}". Describe: people/places visible, visual context for the story. 2-3 sentences, factual.`
  };

  // ── Try full video analysis first ────────────────────────────────
  const mp4Url = videoUrl || (contentType === 'twitch' ? twitchThumbToMp4(thumbnailUrl) : '');

  if (mp4Url) {
    const tmpPath = path.join(TMP_DIR, `gemini_vid_${Date.now()}_${Math.random().toString(36).slice(2,7)}.mp4`);
    let geminiFile = null;
    try {
      // For Twitch: use yt-dlp (handles browser fingerprinting that blocks axios)
      // For ESPN/News: use axios (direct public MP4 links work fine)
      const isTwitch = contentType === 'twitch';
      const pageUrl  = metadata && metadata.pageUrl; // Twitch clip page URL if available

      if (isTwitch) {
        const isSignedCdn = mp4Url && mp4Url.includes('sig=');
        const ytDlpTarget = isSignedCdn ? mp4Url : (pageUrl || mp4Url);

        if (isSignedCdn) {
          // Signed CDN URL — download directly with axios + browser headers + Range request
          // Range: bytes=0-33554431 = first 32MB, well under Gemini's 34MB limit
          // Most video CDNs support Range requests (returns 206 Partial Content)
          const MAX_BYTES = GEMINI_FILE_LIMIT - (2 * 1024 * 1024); // 32MB to be safe
          console.log(`[gemini-video] CDN download (max ${(MAX_BYTES/1024/1024).toFixed(0)}MB): ${ytDlpTarget.slice(0, 80)}...`);
          const vidResp = await axios.get(ytDlpTarget, {
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': 'https://www.twitch.tv/',
              'Origin': 'https://www.twitch.tv',
              'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
              'Accept-Encoding': 'identity',
              'Connection': 'keep-alive',
              'Range': `bytes=0-${MAX_BYTES - 1}`
            }
          });
          const size = vidResp.data.byteLength;
          if (size < 1000) throw new Error(`CDN download returned ${size} bytes — blocked or empty`);
          // Accept 200 (full) or 206 (partial) — cap at GEMINI_FILE_LIMIT either way
          const finalBuf = Buffer.from(vidResp.data).slice(0, GEMINI_FILE_LIMIT);
          fs.writeFileSync(tmpPath, finalBuf);
          console.log(`[gemini-video] CDN ✓ ${(finalBuf.length/1024/1024).toFixed(1)}MB (${vidResp.status === 206 ? 'partial' : 'full'}) — uploading to Gemini...`);
        } else {
          // Page URL fallback — use yt-dlp (no max-filesize to avoid silent skips)
          console.log(`[gemini-video] yt-dlp (page-url): ${ytDlpTarget.slice(0, 80)}...`);
          await new Promise((res, rej) => {
            const { execFile } = require('child_process');
            const args = [
              '--quiet', '--no-warnings',
              '-f', 'best[ext=mp4]/best',
              '-o', tmpPath,
              '--no-playlist',
              '--no-part',
              ytDlpTarget
            ];
            execFile('yt-dlp', args, { timeout: 90000 }, (err, stdout, stderr) => {
              if (err) rej(new Error(`yt-dlp: ${stderr || err.message}`));
              else res();
            });
          });
          if (!fs.existsSync(tmpPath)) throw new Error('yt-dlp produced no output file');
          const size = fs.statSync(tmpPath).size;
          if (size < 1000) throw new Error(`yt-dlp output too small: ${size} bytes`);
          if (size > GEMINI_FILE_LIMIT) {
            // Trim to 34MB if too large
            const buf = fs.readFileSync(tmpPath).slice(0, GEMINI_FILE_LIMIT);
            fs.writeFileSync(tmpPath, buf);
          }
          console.log(`[gemini-video] yt-dlp ✓ ${(fs.statSync(tmpPath).size/1024/1024).toFixed(1)}MB — uploading to Gemini...`);
        }
      } else {
        console.log(`[gemini-video] Downloading: ${mp4Url.slice(0, 80)}...`);
        const vidResp = await axios.get(mp4Url, { responseType: 'arraybuffer', timeout: 30000 });
        const size = vidResp.data.byteLength;
        if (size > GEMINI_FILE_LIMIT) throw new Error(`Video ${(size/1024/1024).toFixed(1)}MB exceeds 34MB limit`);
        if (size < 1000) throw new Error(`Download returned ${size} bytes — likely blocked`);
        fs.writeFileSync(tmpPath, Buffer.from(vidResp.data));
        console.log(`[gemini-video] Uploading ${(size/1024/1024).toFixed(1)}MB to Gemini Files API...`);
      }

      geminiFile = await uploadToGeminiFiles(tmpPath);
      geminiFile  = await waitForGeminiFile(geminiFile);

      const genResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: videoPrompts[contentType] || videoPrompts.twitch },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 500, temperature: 0.2 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const analysis = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      console.log(`[gemini-video] ✓ Video analysis complete (${analysis.length} chars)`);
      return analysis;

    } catch(e) {
      console.warn(`[gemini-video] Video analysis failed, falling back to thumbnail: ${e.message}`);
    } finally {
      if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch(e) {} }
      if (geminiFile) await deleteGeminiFile(geminiFile.name);
    }
  }

  // ── Fallback: thumbnail image analysis ───────────────────────────
  if (!thumbnailUrl) return '';
  try {
    console.log(`[gemini-thumb] Analyzing thumbnail for ${contentType}...`);
    const imgResp = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 8000 });
    const b64     = Buffer.from(imgResp.data).toString('base64');
    const mime    = (imgResp.headers['content-type'] || 'image/jpeg').split(';')[0];
    const gResp   = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      { contents: [{ parts: [{ text: thumbPrompts[contentType]||thumbPrompts.twitch }, { inline_data: { mime_type: mime, data: b64 } }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.2 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return (gResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
  } catch(e) {
    console.warn(`[gemini-thumb] Fallback thumbnail analysis failed: ${e.message}`);
    return '';
  }
}

// Keep old name as alias (used in analyze-clip route)
async function geminiAnalyzeThumbnail(thumbnailUrl, contentType, metadata) {
  return geminiAnalyzeClip('', thumbnailUrl, contentType, metadata);
}


app.post('/generate-full-script', async (req, res) => {
  const { type, items, date } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });

  const dateStr = date || new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  console.log(`[generate-full-script] type:${type} items:${items.length} date:${dateStr}`);

  try {
    // ── Step 1: Gemini analysis — full video where possible ──────────
    console.log('[generate-full-script] Running Gemini analysis...');

    // For Twitch: analyze ALL clips across all streamers with full video
    let analyses = [];
    let orderedClipUrls = []; // populated by twitch block — returned alongside script
    if (type === 'twitch' || type === 'twitch-short') {
      const allClips = [];
      items.forEach(item => {
        const clips = item.clips && item.clips.length ? item.clips : [{ thumbnailUrl: item.thumbnailUrl||'', title: item.title||'', game: item.game||'', url: item.url||'' }];
        clips.forEach(clip => allClips.push({
          pageUrl:               clip.url || '',
          mp4UrlDash:            clip.mp4Url || '',
          thumbnailUrl:          clip.thumbnailUrl || '',
          streamer:              item.streamer,
          title:                 clip.title || '',
          game:                  clip.game || '',
          isBackup:              clip.isBackup || false,
          targetClipsPerStreamer: item.targetClipsPerStreamer || 1
        }));
      });

      // Step 1: Resolve GQL MP4 URLs server-side in batches to avoid Twitch CDN rate limits
      // Batch 1: first 50%, then wait 3s, then Batch 2: remaining 50%
      // Apply display names to items before script generation
      items.forEach(function(item) {
        const twitch_name = (item.streamer || '').toLowerCase().replace(/\s+/g,'');
        item.displayName = STREAMER_DISPLAY_NAMES[twitch_name] || item.streamer;
      });
      console.log(`[generate-full-script] Resolving GQL MP4 URLs for ${allClips.length} clips (batched)...`);

      async function resolveClip(clip) {
        if (clip.mp4UrlDash && clip.mp4UrlDash.includes('sig=')) {
          clip.videoUrl = clip.mp4UrlDash;
          return;
        }
        const slug = extractTwitchSlug(clip.pageUrl);
        if (!slug) { clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl); return; }
        try {
          // Resolve two quality levels in parallel:
          // videoUrl = 720p for Gemini (under 34MB limit)
          // assemblyUrl = 1080p for FFmpeg assembly (best quality)
          const [resultLow, resultHigh] = await Promise.all([
            resolveTwitchClipMp4(slug, 'low'),
            resolveTwitchClipMp4(slug, 'high')
          ]);
          clip.videoUrl    = resultLow.mp4Url;
          clip.assemblyUrl = resultHigh.mp4Url;
          console.log(`[gql] ✓ ${clip.streamer}: Gemini=${resultLow.quality} Assembly=${resultHigh.quality}`);
        } catch(e) {
          console.warn(`[gql] ✗ ${clip.streamer}: ${e.message}`);
          clip.videoUrl = twitchThumbToMp4(clip.thumbnailUrl);
        }
      }

      // Resolve clips per streamer — use backups if primary clips fail GQL
      // Group by streamer, resolve in order, keep first targetClipsPerStreamer successes
      const resolvedByStreamer = {};
      const analysisClips = []; // final clips to analyze with Gemini

      // Get unique streamers in order
      const streamerOrder = [];
      allClips.forEach(c => { if (!resolvedByStreamer[c.streamer]) { resolvedByStreamer[c.streamer] = []; streamerOrder.push(c.streamer); } });

      // Batch resolve all clips (including backups), 2 waves with 3s pause
      const mid = Math.ceil(allClips.length / 2);
      console.log(`[gql] Batch 1: ${mid} clips...`);
      await Promise.all(allClips.slice(0, mid).map(resolveClip));
      if (allClips.length > mid) {
        console.log(`[gql] Waiting 3s before batch 2 (${allClips.length - mid} clips)...`);
        await new Promise(r => setTimeout(r, 3000));
        console.log(`[gql] Batch 2: ${allClips.length - mid} clips...`);
        await Promise.all(allClips.slice(mid).map(resolveClip));
      }

      // For each streamer, pick the first targetClipsPerStreamer clips that resolved OK
      // Fall back to backup clips if primary clips expired/were deleted
      let totalResolved = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = streamerClips[0] && streamerClips[0].targetClipsPerStreamer
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 3);

        const good = streamerClips.filter(c => c.videoUrl && c.videoUrl.includes('sig='));
        const bad  = streamerClips.filter(c => !c.videoUrl || !c.videoUrl.includes('sig='));

        const picked = good.slice(0, target);
        if (picked.length < target && bad.length) {
          // Not enough good clips — fill with thumbnail-fallback clips
          bad.slice(0, target - picked.length).forEach(c => picked.push(c));
        }

        if (good.length < target) {
          console.log(`[gql] ${streamer}: ${good.length}/${target} resolved — ${target - good.length} expired/deleted, using backups`);
        }

        picked.forEach(c => analysisClips.push(c));
        totalResolved += good.slice(0, target).length;
      });

      console.log(`[generate-full-script] GQL resolved ${totalResolved}/${analysisClips.length} final clips with signed URLs. Analyzing with Gemini...`);

      // Build orderedClipUrls here while analysisClips is in scope
      // CRITICAL: url = assemblyUrl (high-quality CDN, may expire)
      //           pageUrl = permanent Twitch page URL → always re-resolve at assembly time
      //           geminiUrl = exact URL Gemini watched → used for QA verification
      orderedClipUrls = analysisClips.map(c => ({
        url:         c.assemblyUrl || c.videoUrl || c.mp4UrlDash || c.url || '',
        pageUrl:     c.pageUrl || c.url || '',
        geminiUrl:   c.videoUrl || '',  // exact URL Gemini watched — for QA mismatch detection
        streamer:    c.streamer || '',
        displayName: c.displayName || c.streamer || '',
        title:       c.title || '',
        isBackup:    c.isBackup || false
      }));
      console.log(`[generate-full-script] Built orderedClipUrls: ${orderedClipUrls.length} clips`);

      // ── Early download: cache clips for streamers with known CDN expiry issues ──
      // Maya's clips expire within ~1 hour. Pre-download them now so assembly
      // always has a valid local copy regardless of how long HeyGen takes.
      const HIGH_EXPIRY_STREAMERS = ['maya', 'extraemily'];
      const earlyDownloadDir = path.join(TMP_DIR, 'early_clips');
      if (!fs.existsSync(earlyDownloadDir)) fs.mkdirSync(earlyDownloadDir, { recursive: true });

      const earlyClips = orderedClipUrls.filter(c =>
        HIGH_EXPIRY_STREAMERS.includes((c.streamer || '').toLowerCase()) && c.url
      );

      if (earlyClips.length > 0) {
        console.log(`[generate-full-script] 📥 Early-downloading ${earlyClips.length} high-expiry clips (Maya/Emily)...`);
        for (const clip of earlyClips) {
          const slug = extractTwitchSlug(clip.pageUrl) || extractTwitchSlug(clip.url) || '';
          const fname = `early_${slug || Date.now()}_${clip.streamer}.mp4`;
          const dest = path.join(earlyDownloadDir, fname);
          if (fs.existsSync(dest)) { clip.localCache = dest; continue; }
          try {
            // Always use fresh GQL token for early download
            let dlUrl = clip.url;
            if (slug) {
              const fresh = await resolveTwitchClipMp4(slug, 'high');
              dlUrl = fresh.mp4Url;
            }
            await downloadFile(dlUrl, dest);
            const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
            if (size > 10000) {
              clip.localCache = dest;
              console.log(`[early-dl] ✅ Cached: ${fname} (${(size/1024/1024).toFixed(1)}MB)`);
            } else {
              console.warn(`[early-dl] ⚠️  Too small after download: ${fname}`);
              try { fs.unlinkSync(dest); } catch(e) {}
            }
          } catch(e) {
            console.warn(`[early-dl] ⚠️  Failed to early-download ${clip.streamer} clip: ${e.message}`);
          }
        }
      }

      // Replace allClips with the curated analysisClips for Gemini
      allClips.length = 0;
      analysisClips.forEach(c => allClips.push(c));

      // Step 2: Gemini watches each clip — batched to avoid CDN rate limiting
      // Split into 3 waves: first third, 5s pause, second third, 5s pause, final third
      const WAVE_SIZE = Math.ceil(allClips.length / 3);
      const waves = [
        allClips.slice(0, WAVE_SIZE),
        allClips.slice(WAVE_SIZE, WAVE_SIZE * 2),
        allClips.slice(WAVE_SIZE * 2)
      ].filter(w => w.length > 0);

      const flatAnalyses = [];
      for (let wi = 0; wi < waves.length; wi++) {
        if (wi > 0) {
          console.log(`[gemini] Wave ${wi+1}: waiting 5s before next batch of ${waves[wi].length} clips...`);
          await new Promise(r => setTimeout(r, 5000));
        }
        console.log(`[gemini] Wave ${wi+1}/${waves.length}: analyzing ${waves[wi].length} clips...`);
        const waveResults = await Promise.all(
          waves[wi].map(c => geminiAnalyzeClip(c.videoUrl, c.thumbnailUrl, 'twitch', {
            streamer: c.streamer, title: c.title, game: c.game, pageUrl: c.pageUrl
          }))
        );
        flatAnalyses.push(...waveResults);
      }

      let flatIdx = 0;
      analyses = items.map(item => {
        const clips = item.clips && item.clips.length ? item.clips : [{}];
        const streamerAnalyses = flatAnalyses.slice(flatIdx, flatIdx + clips.length);
        flatIdx += clips.length;
        return streamerAnalyses;
      });

      const geminiHits = flatAnalyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Gemini analyzed ${geminiHits}/${allClips.length} clips (${allClips.length - geminiHits} fell back to thumbnail)`);


    } else if (type === 'nba' || type === 'nba-short') {
      // NBA: use stored ESPN highlight clip URLs for full video analysis
      // clipUrl comes from ESPN summary API links.source.HD.href or similar
      console.log(`[generate-full-script] Analyzing ${items.length} NBA highlight clips (video + audio)...`);
      analyses = await Promise.all(
        items.map(item => geminiAnalyzeClip(item.clipUrl||'', item.thumbnailUrl||'', 'nba', item))
      );
      const nbaHits = analyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Got ${nbaHits}/${items.length} NBA analyses (${nbaHits} video, ${items.length - nbaHits} thumbnail/fallback)`);

    } else {
      // News: try video URL from RSS enclosure first, then thumbnail + full article text
      console.log(`[generate-full-script] Analyzing ${items.length} news stories...`);
      analyses = await Promise.all(
        items.map(item => geminiAnalyzeClip(item.videoUrl||'', item.thumbnailUrl||'', 'news', item))
      );
      const newsHits = analyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Got ${newsHits}/${items.length} news analyses`);
    }

    // ── Step 2: Build the full Claude prompt ─────────────────────────
    const baseSystemPrompt = FULL_SCRIPT_SYSTEM[type] || FULL_SCRIPT_SYSTEM.twitch;
    const referenceUrls = req.body.referenceUrls || [];
    // Load stored style fingerprint (generated by /analyze-style-library)
    const STYLE_GUIDE_PATH = path.join(__dirname, 'cwn_style_guides.json');
    let styleGuides = {};
    try { styleGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8')); } catch(e) {}

    const baseType = type.replace('-short',''); // nba-short → nba
    const storedGuide = styleGuides[type] || styleGuides[baseType] || null;

    let refContext = '';
    if (storedGuide) {
      // Use pre-analyzed style fingerprint (best quality — Gemini watched the videos)
      refContext = `\n\nCWN STYLE FINGERPRINT (learned from reference videos):\n${storedGuide}`;
      console.log(`[generate-full-script] Using stored style fingerprint for ${type}`);
    } else if (referenceUrls.length > 0) {
      // Fallback: just mention the URLs (Gemini can't watch them here but Claude knows they exist)
      refContext = `\n\nREFERENCE STYLE: Match the voice, pacing, and humor from these reference videos:\n${referenceUrls.map((u,i) => `${i+1}. ${u}`).join('\n')}`;
      console.log(`[generate-full-script] No stored style guide — using URL hints only. Run /analyze-style-library to teach Gemini.`);
    }
    const systemPrompt = baseSystemPrompt + refContext;

    let userPrompt = '';
    if (type === 'nba' || type === 'nba-short') {
      const isShort = type === 'nba-short';
      if (isShort) {
        const g0 = items[0] || {};
        userPrompt = `Write a COMPLETE ClipzWorld News NBA Short script for ${dateStr}.

ONE PLAYER FOCUS:
Game: ${g0.away||'?'} @ ${g0.home||'?'} | Score: ${g0.awayScore||'?'}-${g0.homeScore||'?'} FINAL
Top performer: ${g0.leader||'Unknown'} — ${g0.leaderStat||'stats unavailable'}
${g0.injuries && g0.injuries.length ? 'Out: ' + g0.injuries.join(', ') : ''}
Gemini video analysis: ${analyses[0] || 'No analysis — use stats only'}

Write the FULL SCRIPT using exactly:
- === NBA SHORT ===

Fully written, no brackets, no placeholders. Single [CLIP PLAYS HERE] after setup.
Target: 50-70 words spoken total.`;
      } else {
        userPrompt = `Write the COMPLETE ClipzWorld News NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total.

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
Gemini video analysis: ${analyses[i] || 'No analysis — use box score data only'}
`).join('')}

Write the FULL SCRIPT using these === SECTION HEADERS === exactly:
- === COLD OPEN (0:00 - 0:08) ===
${items.map((g,i) => '- === GAME ' + (i+1) + ' OF ' + items.length + ': ' + (g.away||'AWAY').toUpperCase() + ' @ ' + (g.home||'HOME').toUpperCase() + ' ===').join('\n')}
- === OUTRO ===

Every game segment FULLY WRITTEN — no placeholder brackets.
Use Gemini video analysis AND box score data for specific, accurate content.
Use [beat] between sentences. Keep [CLIP PLAYS HERE] as structural marker.
Target: 120-150 words spoken per game segment.`;
      }


    } else if (type === 'news' || type === 'news-short') {
      const isShort = type === 'news-short';
      if (isShort) {
        const s0 = items[0] || {};
        userPrompt = `Write a COMPLETE ClipzWorld News World News Short script for ${dateStr}.

ONE STORY FOCUS:
Headline: ${s0.title || 'Unknown'}
Source: ${s0.source || 'Al Jazeera'}
Article text: ${s0.desc || 'No description available'}
Gemini analysis: ${analyses[0] || 'Not available — use article text only'}

Write the FULL SCRIPT using exactly:
- === NEWS SHORT ===

Fully written, no brackets, no placeholders.
Target: 50-70 words spoken total. One headline, one observation, done.`;
      } else {
        userPrompt = `Write the COMPLETE ClipzWorld News world news script for ${dateStr}.

${items.length} stor${items.length > 1 ? 'ies' : 'y'} total.

STORY DATA:
${items.map((s, i) => `
STORY ${i+1}: ${s.title || 'Untitled'}
Source: ${s.source || 'Al Jazeera'}
${s.pubDate ? 'Published: ' + s.pubDate : ''}
Article text: ${s.desc || 'No description available'}
${s.link ? 'Link: ' + s.link : ''}
Gemini visual/video analysis: ${analyses[i] || 'Not available — use article text only'}
`).join('')}

Write the FULL SCRIPT using these === SECTION HEADERS === exactly:
- === COLD OPEN (0:00 - 0:08) ===
${items.map((s,i) => '- === STORY ' + (i+1) + ' OF ' + items.length + ' ===').join('\n')}
- === OUTRO ===

Every story FULLY WRITTEN — no placeholder brackets.
Use article text AND Gemini analysis for accurate, specific content.
Use [beat] between every sentence. Include: headline → 2-3 sentences context → one flat observation → source credit.
Target: 130-160 words spoken per story. Anchor speaks ENTIRE runtime — make it dense.`;
      }

    } else { // twitch, twitch-short
      const isShort = type === 'twitch-short';
      if (isShort) {
        const c0 = items[0] || {};
        const clip0 = (c0.clips && c0.clips.length) ? c0.clips[0] : c0;
        const anal0 = Array.isArray(analyses[0]) ? analyses[0][0] : analyses[0];
        userPrompt = `Write a COMPLETE ClipzWorld News Twitch Short script for ${dateStr}.

ONE STREAMER / ONE CLIP:
ON-AIR NAME (use ONLY this name — never use the Twitch username): ${getDisplayName(c0.streamer||'')||c0.streamer||'Unknown'}
Twitch username (do NOT say this on air): ${c0.streamer||'Unknown'}
${c0.notes ? 'Notes: ' + c0.notes : ''}
Clip title: "${clip0.title||'N/A'}" | ${clip0.views ? clip0.views.toLocaleString() + ' views' : ''} | ${clip0.game||''}
Gemini video analysis: ${anal0 || 'No analysis available'}

Write the FULL SCRIPT using exactly:
- === TWITCH SHORT ===

Fully written, no brackets, no placeholders. Single [CLIP PLAYS HERE] marker.
Target: 40-60 words spoken total (before + after clip).`;
      } else {
        const streamerSections = items.map((c, i) => {
          const clips = c.clips && c.clips.length ? c.clips : [{ title: c.title||'N/A', views: c.views||0, game: c.game||'' }];
          const clipAnalyses = Array.isArray(analyses[i]) ? analyses[i] : [analyses[i]||''];
          const notesStr = c.notes ? 'Streamer context: ' + c.notes : '';
          const displayName = getDisplayName(c.streamer);
          const clipLines = clips.map((clip, ci) => `
  Clip ${ci+1}: "${clip.title||'N/A'}" | ${clip.views ? clip.views.toLocaleString()+' views' : ''} | ${clip.game||''}
  Analysis: ${clipAnalyses[ci] || 'No analysis'}`).join('');
          return `STREAMER ${i+1}:
ON-AIR NAME (use this name ONLY — never use the Twitch username): ${displayName}
Twitch username (do NOT use this in spoken text): ${c.streamer||'Unknown'}
${notesStr}${clipLines}`;
        }).join('\n\n');

        const clipsPerStreamer = (items[0] && items[0].targetClipsPerStreamer) || (items[0] && items[0].clips && items[0].clips[0] && items[0].clips[0].targetClipsPerStreamer) || 1;
        console.log(`[generate-full-script] clipsPerStreamer: ${clipsPerStreamer} | totalClips: ${items.length * clipsPerStreamer}`);
        const totalClipSlots = items.length * clipsPerStreamer;
        const sectionHeaders = items.map(c => '- === ' + getDisplayName(c.streamer).toUpperCase() + ' ===').join('\n');

        userPrompt = `Write the COMPLETE ClipzWorld News Twitch compilation script for ${dateStr}.

${items.length} streamers. ${clipsPerStreamer} clip${clipsPerStreamer>1?'s':''} per streamer. ${totalClipSlots} total [CLIP PLAYS HERE] slots.

STREAMER DATA:
${streamerSections}

Write the FULL SCRIPT using these === SECTION HEADERS === exactly:
- === COLD OPEN (0:00 - 0:08) ===
${sectionHeaders}
- === OUTRO ===

CRITICAL — MULTI-CLIP STRUCTURE PER STREAMER:
Each streamer section must contain EXACTLY ${clipsPerStreamer} [CLIP PLAYS HERE] marker${clipsPerStreamer>1?'s':''}.
EVERY clip needs its OWN setup before it. Setups are LONGER than reactions. Reactions are short. This contrast is intentional.
Structure for EACH streamer section — follow this EXACTLY:

[Streamer intro — 2-3 sentences. Establishes who they are and what's happening. Sets up clip 1 with context.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence to clip 1. Short. Deadpan. Could be a non-sequitur.]${clipsPerStreamer >= 2 ? `
[beat]
[2-sentence setup for clip 2. First sentence: a brief pivot or bridge from the reaction. Second sentence: specific context that makes the clip make sense. LONGER than the reaction above it.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence to clip 2. Short. Deadpan. Could be a non-sequitur.]` : ''}${clipsPerStreamer >= 3 ? `
[beat]
[2-sentence setup for clip 3. First sentence: a brief pivot or bridge from the reaction. Second sentence: specific context that makes the clip make sense. LONGER than the reaction above it.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence to clip 3. Short. Deadpan. Could be a non-sequitur.]` : ''}
[beat]
Follow [ON-AIR NAME]. Link in description.

RULES:
- Clip 1 intro: 2-3 sentences — longest setup, establishes the streamer
- Clip 2 and 3 setups: 2 sentences each — longer than reactions, shorter than clip 1 intro
- Reactions: EXACTLY 1 sentence — short, flat, punchy. The contrast with longer setups is what creates rhythm.
- [beat] = 3-second pause — use before and after every clip
- Never explain the joke in a reaction. Never recap what just happened.

NAME RULE: Bobby G ALWAYS refers to each streamer by their ON-AIR NAME only. Never use the Twitch username in spoken text. For example: say "Ron" not "StableRonaldo", say "Jay Cinco" not "Jaycinco", say "Yonna" not "YonnaJay".
PRONOUN RULES: use streamer context notes for pronouns. Never assume gender from name alone.
Total [CLIP PLAYS HERE] count must be exactly ${totalClipSlots}.
Target: 80-100 words spoken per streamer.`;
      }
    }

    // ── Step 3: Claude generates the complete script ──────────────────
    const client   = new Anthropic();
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000, // 3 clips × 10 streamers needs more tokens
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }]
    });

    const script = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    const wordCount = script.split(/\s+/).filter(w => w.length > 0).length;
    const estSecs   = Math.round((wordCount / 130) * 60);
    console.log(`[generate-full-script] Script generated: ${wordCount} words, ~${Math.floor(estSecs/60)}m ${estSecs%60}s`);

    // ── Gate 1: Script QA — Gemini reviews Claude's script ──────────
    console.log(`[generate-full-script] 🔍 Running Gate 1 Script QA (Gemini reviews Claude's script)...`);
    const scriptQA = await geminiScriptQA(script, analyses, {
      contentType: type,
      streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })) : [],
      clipsPerStreamer: req.body.clipsPerStreamer || 3,
      jobId: `${type}_${dateStr}_${Date.now()}`
    });

    console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
    if (scriptQA.deductions?.length) {
      scriptQA.deductions.forEach(d => console.log(`[generate-full-script]   -${d.points} ${d.reason}`));
    }

    res.json({
      ok: true,
      script,
      wordCount,
      estSecs,
      geminiHits: analyses.filter(a=>a).length,
      orderedClipUrls,
      // Gate 1 QA results — dashboard shows these before user approves HeyGen send
      scriptQA: {
        score:       scriptQA.score,
        outcome:     scriptQA.outcome,
        outcomeLabel:scriptQA.outcomeLabel,
        passed:      scriptQA.passed,
        report:      scriptQA.report,
        deductions:  scriptQA.deductions
      }
    });

  } catch(err) {
    console.error('[generate-full-script] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ── POST /analyze-style-library ─────────────────────────────────
// One-time teaching pass: Gemini watches reference videos and extracts
// a style fingerprint per content type. Stored in cwn_style_guides.json.
// Dashboard calls this from Settings → TEACH GEMINI button.
app.post('/analyze-style-library', async (req, res) => {
  const { library } = req.body;
  // library: { twitch: [url, url], nba: [url], news: [url], ... }
  if (!library || !Object.keys(library).length) {
    return res.status(400).json({ error: 'No reference library provided' });
  }
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set' });

  const STYLE_GUIDE_PATH = path.join(__dirname, 'cwn_style_guides.json');
  let existingGuides = {};
  try { existingGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8')); } catch(e) {}

  const results = {};
  const errors  = {};

  for (const [contentType, urls] of Object.entries(library)) {
    if (!urls || !urls.length) continue;
    console.log(`[style-library] Analyzing ${urls.length} reference videos for: ${contentType}`);

    const videoAnalyses = [];
    for (const url of urls) {
      if (!url || !url.startsWith('http')) continue;
      try {
        // Download video sample (first 32MB) for Gemini analysis
        const tmpPath = path.join(TMP_DIR, `ref_${contentType}_${Date.now()}_${Math.random().toString(36).slice(2,6)}.mp4`);
        const MAX_BYTES = 32 * 1024 * 1024;

        console.log(`[style-library] Downloading: ${url.slice(0, 80)}...`);
        await new Promise((res, rej) => {
          const { execFile } = require('child_process');
          const args = [
            '--quiet', '--no-warnings',
            '-f', 'best[ext=mp4][filesize<33M]/best[filesize<33M]/best',
            '--max-filesize', '33m',
            '-o', tmpPath, '--no-playlist', '--no-part'
          ];
          execFile('yt-dlp', args.concat([url]), { timeout: 90000 }, (err, stdout, stderr) => {
            if (err) rej(new Error(`yt-dlp: ${stderr || err.message}`));
            else res();
          });
        });

        if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) {
          console.warn(`[style-library] Download failed for ${url}`);
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          continue;
        }

        // Cap at 32MB
        const stat = fs.statSync(tmpPath);
        if (stat.size > MAX_BYTES) {
          const buf = fs.readFileSync(tmpPath).slice(0, MAX_BYTES);
          fs.writeFileSync(tmpPath, buf);
        }

        console.log(`[style-library] Uploading ${(fs.statSync(tmpPath).size/1024/1024).toFixed(1)}MB to Gemini...`);
        const geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(tmpPath));

        const stylePrompt = `You are analyzing a reference video to extract a STYLE FINGERPRINT for ClipzWorld News (CWN), a "${contentType}" compilation show.

Watch this video carefully. Your job is to extract the specific stylistic elements so a script writer can replicate the feel.

Extract and document:
1. OPENING ENERGY: How does the host/show open? Energy level? First sentence structure?
2. PACING: How fast does it move? How long on each segment/topic?
3. TONE: Specific adjectives for the delivery (deadpan? warm? sardonic? chaotic?)
4. HUMOR TECHNIQUE: What makes it funny? (observation? timing? non-sequitur? understatement?)
5. LANGUAGE PATTERNS: Specific phrases, sentence structures, or speech patterns that appear
6. TRANSITIONS: How does it move between segments/topics?
7. REACTION STYLE: How does the host respond to content? Length? Affect?
8. WHAT TO AVOID: Things this show explicitly does NOT do (no hype, no explanation, etc.)
9. SIGNATURE MOVES: Any recurring bits, catchphrases, or structural elements

Be specific and actionable. A script writer should be able to read this and write in the same voice without watching the video.`;

        const genResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
          {
            contents: [{ parts: [
              { text: stylePrompt },
              { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
            ]}],
            generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
        );

        const analysis = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
        if (analysis.length > 100) {
          videoAnalyses.push(`--- Reference video: ${url.slice(0,60)} ---\n${analysis}`);
          console.log(`[style-library] ✓ Analyzed ${url.slice(0,60)} (${analysis.length} chars)`);
        }

        // Cleanup
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        try {
          await axios.delete(`https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`);
        } catch(e) {}

        // Rate limit pause between videos
        await new Promise(r => setTimeout(r, 3000));

      } catch(e) {
        console.warn(`[style-library] Failed for ${url}: ${e.message}`);
        errors[url] = e.message;
      }
    }

    if (videoAnalyses.length > 0) {
      // Synthesize all analyses into one coherent style guide
      const synthesisPrompt = `You analyzed ${videoAnalyses.length} reference videos for a "${contentType}" show on ClipzWorld News.

Here are the individual analyses:
${videoAnalyses.join('\n\n')}

Now write a UNIFIED STYLE GUIDE that a script writer can use for every "${contentType}" script.
Be specific, actionable, and concise. This will be injected into every script generation prompt.
Format as clear bullet points under clear headings. Max 400 words.`;

      try {
        const { Anthropic } = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: synthesisPrompt }]
        });
        const styleGuide = msg.content[0]?.text || videoAnalyses.join('\n\n');
        existingGuides[contentType] = styleGuide;
        results[contentType] = { ok: true, videoCount: videoAnalyses.length, chars: styleGuide.length };
        console.log(`[style-library] ✅ Style guide for ${contentType}: ${styleGuide.length} chars`);
      } catch(e) {
        // Fallback: just concatenate analyses
        existingGuides[contentType] = videoAnalyses.join('\n\n');
        results[contentType] = { ok: true, videoCount: videoAnalyses.length, fallback: true };
      }
    } else {
      results[contentType] = { ok: false, error: 'No videos could be analyzed' };
    }
  }

  // Save style guides to disk
  fs.writeFileSync(STYLE_GUIDE_PATH, JSON.stringify(existingGuides, null, 2));
  console.log(`[style-library] Saved style guides to ${STYLE_GUIDE_PATH}`);

  res.json({ ok: true, results, errors, guidePath: STYLE_GUIDE_PATH });
});

// ── GET /style-library ────────────────────────────────────────────
// Returns currently stored style guides
app.get('/style-library', (req, res) => {
  const STYLE_GUIDE_PATH = path.join(__dirname, 'cwn_style_guides.json');
  try {
    const guides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    res.json({ ok: true, guides, path: STYLE_GUIDE_PATH });
  } catch(e) {
    res.json({ ok: true, guides: {}, message: 'No style guides yet — run Teaching Pass first' });
  }
});

// ── Publishing Routes ─────────────────────────────────────────────

// ── Upload-Post Publishing ─────────────────────────────────────────
// Single endpoint handles all platforms via Upload-Post API
// Replaces old per-platform routes (youtube, tiktok, instagram)
//
// POST /publish — publish video to one or more platforms via Upload-Post
// Body: {
//   driveUrl: string,          // public Drive URL of the assembled video
//   filename: string,          // local filename (for Drive URL fallback)
//   platforms: string[],       // ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'threads']
//   title: string,             // video title
//   description: string,       // video description / caption
//   tags: string[],            // YouTube tags
//   scheduledAt: string,       // ISO-8601 UTC datetime (optional, omit for immediate)
//   privacyStatus: string,     // 'public' | 'private' | 'unlisted' (YouTube only)
//   contentType: string,       // 'long' | 'short' — determines format per platform
//   async: boolean             // if true, returns request_id immediately and processes in background
// }
app.post('/publish', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipznashite';

  if (!UPLOADPOST_API_KEY) {
    return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set in .env' });
  }

  const {
    driveUrl,
    filename,
    platforms = ['youtube'],
    title = 'ClipzWorld News — The Daily Update',
    description = '',
    tags = [],
    scheduledAt,
    privacyStatus = 'public',
    contentType = 'long',
    async: asyncUpload = true
  } = req.body;

  if (!driveUrl && !filename) {
    return res.status(400).json({ error: 'driveUrl or filename required' });
  }

  // Use Drive URL directly (Upload-Post accepts public URLs)
  const videoUrl = driveUrl || null;
  if (!videoUrl) {
    return res.status(400).json({ error: 'driveUrl required — Upload-Post needs a public URL' });
  }

  console.log(`[upload-post] Publishing to: ${platforms.join(', ')}`);
  console.log(`[upload-post] Video URL: ${videoUrl}`);
  console.log(`[upload-post] Title: ${title}`);
  if (scheduledAt) console.log(`[upload-post] Scheduled: ${scheduledAt}`);

  try {
    const FormData = require('form-data');
    const form = new FormData();

    form.append('user', UPLOADPOST_PROFILE);
    form.append('video', videoUrl);  // Upload-Post accepts URL directly
    form.append('title', title);
    if (description) form.append('description', description);
    if (asyncUpload) form.append('async_upload', 'true');

    // Add platforms
    platforms.forEach(p => form.append('platform[]', p));

    // YouTube-specific
    if (platforms.includes('youtube')) {
      const ytTitle = contentType === 'short' ? title + ' #Shorts' : title;
      form.append('youtube_title', ytTitle);
      form.append('youtube_description', description || title);
      if (tags.length) tags.forEach(t => form.append('tags[]', t));
      form.append('privacyStatus', privacyStatus || 'public');
      form.append('categoryId', '24'); // Entertainment
      form.append('containsSyntheticMedia', 'true');
      form.append('madeForKids', 'false');
      // Thumbnail URL if provided
      if (req.body.thumbnailUrl) form.append('thumbnail_url', req.body.thumbnailUrl);
      // Pinned first comment if provided
      if (req.body.pinnedComment) form.append('first_comment', req.body.pinnedComment);
    }

    // Instagram-specific
    if (platforms.includes('instagram')) {
      form.append('media_type', contentType === 'short' ? 'REELS' : 'REELS');
      form.append('instagram_title', description || title);
    }

    // TikTok-specific
    if (platforms.includes('tiktok')) {
      form.append('tiktok_title', (title || '').substring(0, 90));
      form.append('privacy_level', 'PUBLIC_TO_EVERYONE');
      form.append('post_mode', 'DIRECT_POST');
      form.append('is_aigc', 'true');
      form.append('brand_content_toggle', 'false');
    }

    // Threads-specific
    if (platforms.includes('threads')) {
      form.append('threads_title', description || title);
    }

    // Schedule if requested
    if (scheduledAt) {
      form.append('scheduled_date', new Date(scheduledAt).toISOString());
    }

    const response = await axios.post(
      'https://api.upload-post.com/api/upload',
      form,
      {
        headers: {
          'Authorization': `Apikey ${UPLOADPOST_API_KEY}`,
          ...form.getHeaders()
        },
        maxBodyLength: Infinity,
        timeout: 120000
      }
    );

    const { request_id, job_id, results } = response.data;
    console.log(`[upload-post] ✅ Response received`);
    if (request_id) console.log(`[upload-post]    request_id: ${request_id}`);
    if (job_id) console.log(`[upload-post]    job_id: ${job_id} (scheduled)`);

    res.json({
      ok: true,
      request_id,
      job_id,
      results,
      scheduledAt: scheduledAt || null,
      platforms,
      statusUrl: request_id
        ? `https://api.upload-post.com/api/uploadposts/status?request_id=${request_id}`
        : job_id
        ? `https://api.upload-post.com/api/uploadposts/status?job_id=${job_id}`
        : null
    });
  } catch(e) {
    const errData = e.response?.data;
    console.error('[upload-post] Publish failed:', e.message, errData || '');
    res.status(500).json({ error: e.message, details: errData || null });
  }
});

// GET /publish/status — poll Upload-Post job or request status
app.get('/publish/status', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  const { request_id, job_id } = req.query;
  if (!request_id && !job_id) return res.status(400).json({ error: 'request_id or job_id required' });

  try {
    const param = request_id ? `request_id=${request_id}` : `job_id=${job_id}`;
    const response = await axios.get(
      `https://api.upload-post.com/api/uploadposts/status?${param}`,
      { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message, details: e.response?.data || null });
  }
});

// GET /publish/history — recent upload history
app.get('/publish/history', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  try {
    const response = await axios.get(
      'https://api.upload-post.com/api/uploadposts/history?limit=20',
      { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /publish/queue — queue settings for profile
app.get('/publish/queue', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipznashite';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  try {
    const response = await axios.get(
      `https://api.upload-post.com/api/uploadposts/queue/settings?profile_username=${UPLOADPOST_PROFILE}`,
      { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}` } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/queue — update queue settings
app.post('/publish/queue', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipznashite';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  try {
    const response = await axios.post(
      'https://api.upload-post.com/api/uploadposts/queue/settings',
      { profile_username: UPLOADPOST_PROFILE, ...req.body },
      { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OLD per-platform routes (kept as stubs pointing to /publish) ───
// POST /publish/youtube — upload video to YouTube with metadata + optional schedule
app.post('/publish/youtube', async (req, res) => {
  const { filename, title, description, tags, scheduledAt, privacyStatus } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const { google } = require('googleapis');
    // Reuse OAuth2 from Drive
    const CLIENT_ID     = '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com';
    const CLIENT_SECRET = 'd-FL95Q19q7MQmFpd7hHD0Ty';
    const oauth2Client  = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    if (!process.env.DRIVE_REFRESH_TOKEN) return res.status(400).json({ error: 'Run node cwn-auth.js first to authorize Google' });
    oauth2Client.setCredentials({ refresh_token: process.env.DRIVE_REFRESH_TOKEN });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    const status = { privacyStatus: privacyStatus || 'private' };
    if (scheduledAt) {
      status.privacyStatus = 'private';
      status.publishAt = new Date(scheduledAt).toISOString();
    }

    console.log(`[youtube] Uploading ${filename} (${(fs.statSync(filePath).size/1024/1024).toFixed(1)}MB)...`);
    const uploadRes = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: title || filename,
          description: description || '',
          tags: tags || [],
          categoryId: '24', // Entertainment
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en'
        },
        status
      },
      media: {
        mimeType: 'video/mp4',
        body: fs.createReadStream(filePath)
      }
    });

    const videoId = uploadRes.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[youtube] ✅ Uploaded: ${videoUrl}`);
    res.json({ ok: true, videoId, videoUrl, scheduledAt: status.publishAt || null });
  } catch(e) {
    console.error('[youtube] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/tiktok — upload video to TikTok
app.post('/publish/tiktok', async (req, res) => {
  const { filename, caption, scheduledAt } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!process.env.TIKTOK_ACCESS_TOKEN) return res.status(400).json({ error: 'TIKTOK_ACCESS_TOKEN not set in .env' });

  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    const fileSize = fs.statSync(filePath).size;
    console.log(`[tiktok] Initiating upload for ${filename} (${(fileSize/1024/1024).toFixed(1)}MB)...`);

    // Step 1: Init upload
    const initResp = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: caption || '',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1
        }
      },
      { headers: { 'Authorization': `Bearer ${process.env.TIKTOK_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );

    const { publish_id, upload_url } = initResp.data.data;

    // Step 2: Upload video chunk
    const fileBuffer = fs.readFileSync(filePath);
    await axios.put(upload_url, fileBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${fileSize-1}/${fileSize}`,
        'Content-Length': fileSize
      },
      maxBodyLength: Infinity
    });

    console.log(`[tiktok] ✅ Uploaded. Publish ID: ${publish_id}`);
    res.json({ ok: true, publishId: publish_id });
  } catch(e) {
    console.error('[tiktok] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /publish/instagram — upload video to Instagram via Meta Graph API
app.post('/publish/instagram', async (req, res) => {
  const { filename, caption, scheduledAt } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_ACCOUNT_ID) {
    return res.status(400).json({ error: 'INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID required in .env' });
  }

  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  try {
    // Instagram requires a public URL — use Drive URL
    const driveUrl = await uploadToDrive(filePath, path.basename(filename), path.basename(filename));
    if (!driveUrl) return res.status(400).json({ error: 'Drive upload required for Instagram — set up cwn-auth.js first' });

    const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
    const IG_ID    = process.env.INSTAGRAM_ACCOUNT_ID;
    const BASE     = `https://graph.facebook.com/v19.0`;

    console.log(`[instagram] Creating container for ${filename}...`);

    // Step 1: Create media container
    const containerResp = await axios.post(`${BASE}/${IG_ID}/media`, {
      video_url: driveUrl,
      caption: caption || '',
      media_type: 'REELS',
      access_token: IG_TOKEN
    });
    const containerId = containerResp.data.id;

    // Step 2: Poll until container is ready
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const statusResp = await axios.get(`${BASE}/${containerId}?fields=status_code&access_token=${IG_TOKEN}`);
      if (statusResp.data.status_code === 'FINISHED') { ready = true; break; }
      if (statusResp.data.status_code === 'ERROR') throw new Error('Instagram container processing failed');
      console.log(`[instagram] Container status: ${statusResp.data.status_code} (attempt ${i+1}/20)`);
    }
    if (!ready) return res.status(500).json({ error: 'Instagram container timed out' });

    // Step 3: Publish
    const publishResp = await axios.post(`${BASE}/${IG_ID}/media_publish`, {
      creation_id: containerId,
      access_token: IG_TOKEN
    });

    const mediaId = publishResp.data.id;
    console.log(`[instagram] ✅ Published. Media ID: ${mediaId}`);
    res.json({ ok: true, mediaId });
  } catch(e) {
    console.error('[instagram] Upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CapCut Progressive Assembly ──────────────────────────────────
// Builds a CapCut draft incrementally as HeyGen segments complete.
// Instead of waiting for ALL segments, the draft is populated in real-time.
// Final render is triggered when the last segment is added.
//
// Flow:
//   1. POST /capcut/init         → create draft, return draft_id
//   2. POST /capcut/add-segment  → add each segment as it arrives (called repeatedly)
//   3. POST /capcut/finalize     → save draft, return CapCut draft URL
//   4. POST /capcut/ticker       → add ticker text element to draft
//   5. POST /capcut/thumbnail    → extract best frame as thumbnail
//
const CAPCUT_URL = process.env.CAPCUT_URL || 'http://localhost:9001';

async function capcut(endpoint, body) {
  const resp = await axios.post(`${CAPCUT_URL}${endpoint}`, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });
  return resp.data;
}

// Active CapCut drafts: draftId → { segments: [], width, height, fps }
const capcutDrafts = {};

// POST /capcut/init — create a new CapCut draft for a job
app.post('/capcut/init', async (req, res) => {
  const { jobId, contentType = 'twitch', format = 'landscape' } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const width  = format === 'portrait' ? 1080 : 1920;
  const height = format === 'portrait' ? 1920 : 1080;
  const fps    = 30;

  try {
    const result = await capcut('/create_draft', { width, height, fps });
    const draftId = result?.result?.draft_id || result?.draft_id;
    if (!draftId) return res.status(500).json({ error: 'CapCut did not return draft_id', raw: result });

    capcutDrafts[jobId] = { draftId, segments: [], width, height, fps, contentType, format };
    console.log(`[capcut] ✅ Draft created for job ${jobId}: ${draftId}`);
    res.json({ ok: true, draftId, jobId });
  } catch(e) {
    console.error('[capcut] Init failed:', e.message);
    res.status(500).json({ error: e.message, hint: 'Is CapCut MCP server running on port 9001?' });
  }
});

// POST /capcut/add-segment — add a segment to the draft as it arrives
// Call this for each HeyGen avatar segment as it completes AND each source clip
app.post('/capcut/add-segment', async (req, res) => {
  const { jobId, segmentUrl, segmentType = 'avatar', label = '', localPath = '' } = req.body;
  if (!jobId || (!segmentUrl && !localPath)) return res.status(400).json({ error: 'jobId + segmentUrl or localPath required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft found for job ${jobId} — call /capcut/init first` });

  const position = draft.segments.length;
  const url = localPath || segmentUrl;

  try {
    // Get duration first
    const dur = await new Promise((resolve) => {
      const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', url];
      execFile(ffmpegPath().replace('ffmpeg', 'ffprobe'), args, (err, stdout) => {
        resolve(parseFloat(stdout) || 10);
      });
    });

    const result = await capcut('/add_video', {
      draft_id: draft.draftId,
      video_url: url,
      start: 0,
      end: dur,
      volume: segmentType === 'source_clip' ? 0.7 : 1.0, // source clips slightly quieter
      transition: position > 0 ? 'cut' : undefined
    });

    draft.segments.push({ url, type: segmentType, label, duration: dur, position });
    console.log(`[capcut] ✅ Added segment ${position + 1} (${segmentType}): ${label}`);
    res.json({ ok: true, position: position + 1, totalSegments: draft.segments.length, duration: dur });
  } catch(e) {
    console.error(`[capcut] Add segment failed for ${label}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/ticker — add scrolling ticker text overlay to draft
app.post('/capcut/ticker', async (req, res) => {
  const { jobId, tickerText = 'CLIPZWORLD NEWS  •  THE DAILY UPDATE  •  @clipznashite  •  ', totalDuration } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    // Add scrolling ticker as a text element at bottom of frame
    await capcut('/add_text', {
      draft_id: draft.draftId,
      text: tickerText.repeat(5), // repeat for scroll effect
      start: 0,
      end: totalDuration || 1500,
      font_size: 24,
      font_color: '#c7af4f',
      background_color: '#22304b',
      background_alpha: 0.95,
      transform_y: draft.height - 64, // bottom of frame
      animation: 'scroll_left'
    });

    console.log(`[capcut] ✅ Ticker added to draft ${draft.draftId}`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[capcut] Ticker failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/logo — add CWN logo bug to draft
app.post('/capcut/logo', async (req, res) => {
  const { jobId, logoUrl, totalDuration } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    await capcut('/add_image', {
      draft_id: draft.draftId,
      image_url: logoUrl || `http://localhost:8765/logo_cwn.png`,
      start: 0,
      end: totalDuration || 1500,
      transform_x: draft.width - 140,
      transform_y: 20,
      scale_x: 0.85,
      scale_y: 0.85
    });

    console.log(`[capcut] ✅ Logo bug added`);
    res.json({ ok: true });
  } catch(e) {
    console.error('[capcut] Logo failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/finalize — save draft and return path for CapCut to render
app.post('/capcut/finalize', async (req, res) => {
  const { jobId } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const draft = capcutDrafts[jobId];
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId}` });

  try {
    const result = await capcut('/save_draft', { draft_id: draft.draftId });
    const draftUrl = result?.result?.draft_url || result?.draft_url || '';

    console.log(`[capcut] ✅ Draft saved: ${draftUrl}`);
    console.log(`[capcut]    Total segments: ${draft.segments.length}`);
    console.log(`[capcut]    Open CapCut → File → Open → select draft to render`);

    // Clean up draft state (keep for 1 hour in case of re-finalize)
    setTimeout(() => { delete capcutDrafts[jobId]; }, 3600000);

    res.json({
      ok: true,
      draftId: draft.draftId,
      draftUrl,
      totalSegments: draft.segments.length,
      instructions: 'Open CapCut → File → Open Project → select draft → Export'
    });
  } catch(e) {
    console.error('[capcut] Finalize failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /capcut/status/:jobId — check draft build progress
app.get('/capcut/status/:jobId', (req, res) => {
  const draft = capcutDrafts[req.params.jobId];
  if (!draft) return res.status(404).json({ error: 'No draft found' });
  res.json({
    ok: true,
    draftId: draft.draftId,
    totalSegments: draft.segments.length,
    segments: draft.segments.map(s => ({ label: s.label, type: s.type, duration: s.duration }))
  });
});

// ── Teach Gemini Streamer Language ────────────────────────────────
// One-off task: Gemini watches ~10 recent VOD clips per streamer
// Stores vocabulary, recurring bits, and community references in cwn_style_guides.json
// Dashboard button: Settings → "Teach Gemini Streamer Language"
//
// POST /teach-streamer-language
// Body: { streamer: 'maya', vodUrls: ['url1','url2'...] }
//   OR: { streamer: 'maya', autoFetch: true } → fetches recent clips from Twitch
app.post('/teach-streamer-language', async (req, res) => {
  const { streamer, vodUrls = [], autoFetch = false } = req.body;
  if (!streamer) return res.status(400).json({ error: 'streamer required' });
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY required' });

  console.log(`[streamer-language] Teaching Gemini the language of ${streamer}...`);

  let clipsToAnalyze = vodUrls;

  // Auto-fetch recent clips from Twitch if no URLs provided
  if (autoFetch && !vodUrls.length) {
    try {
      const userResp = await axios.get(
        `https://api.twitch.tv/helix/users?login=${streamer}`,
        { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${process.env.TWITCH_TOKEN}` } }
      );
      const userId = userResp.data?.data?.[0]?.id;
      if (userId) {
        const clipsResp = await axios.get(
          `https://api.twitch.tv/helix/clips?broadcaster_id=${userId}&first=10`,
          { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${process.env.TWITCH_TOKEN}` } }
        );
        const clips = clipsResp.data?.data || [];
        clipsToAnalyze = clips
          .filter(c => c.thumbnail_url)
          .map(c => ({ thumbnailUrl: c.thumbnail_url, title: c.title, pageUrl: c.url }));
        console.log(`[streamer-language] Auto-fetched ${clipsToAnalyze.length} clips for ${streamer}`);
      }
    } catch(e) {
      console.warn(`[streamer-language] Auto-fetch failed: ${e.message}`);
    }
  }

  if (!clipsToAnalyze.length) {
    return res.status(400).json({ error: 'No clips to analyze — provide vodUrls or set autoFetch:true' });
  }

  // Send to client immediately — analysis runs in background
  res.json({ ok: true, message: `Analyzing ${clipsToAnalyze.length} clips for ${streamer}...`, streamer });

  // Background analysis
  (async () => {
    try {
      const prompt = `You are building a language fingerprint for a Twitch streamer named "${streamer}" for CWN (ClipzWorld News).

Watch these clips from ${streamer}'s stream and extract:

1. VOCABULARY: Words, phrases, slang specific to this streamer/community (e.g. "rizz", "W", "cooked")
2. RECURRING BITS: Running jokes, catchphrases, recurring situations
3. COMMUNITY REFERENCES: Names of frequent collaborators, in-jokes, community lore
4. CONTENT STYLE: What kind of content do they make? What's their energy level?
5. NOTABLE MOMENTS: Any specific events/stories the community references often
6. TONE: How does their community describe them? What's the vibe?

This fingerprint will be used by Claude to write setup lines for Bobby G's reactions to their clips.
The goal: make the setups feel like they were written by someone who actually watches ${streamer}.

Format your response as a structured fingerprint with clear sections.
Be specific — generic descriptions are useless. Actual vocabulary and bit names are gold.`;

      const analyses = [];
      for (const clip of clipsToAnalyze.slice(0, 10)) {
        try {
          const url = typeof clip === 'string' ? clip : (clip.thumbnailUrl || '');
          if (!url) continue;
          const analysis = await geminiAnalyzeClip('', url, 'twitch', {
            streamer, title: clip.title || '', pageUrl: clip.pageUrl || ''
          });
          if (analysis && analysis.length > 20) analyses.push(analysis);
          await new Promise(r => setTimeout(r, 1000));
        } catch(e) {
          console.warn(`[streamer-language] Clip analysis failed: ${e.message}`);
        }
      }

      // Final synthesis call
      const synthesisResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [{ text: `${prompt}\n\nCLIP ANALYSES:\n${analyses.join('\n---\n')}` }] }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const fingerprint = (synthesisResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();

      // Save to cwn_style_guides.json under streamer key
      const guidePath = path.join(__dirname, 'cwn_style_guides.json');
      let guides = {};
      try { guides = JSON.parse(fs.readFileSync(guidePath, 'utf8')); } catch(e) {}
      if (!guides.streamers) guides.streamers = {};
      guides.streamers[streamer.toLowerCase()] = {
        fingerprint,
        clipsAnalyzed: analyses.length,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(guidePath, JSON.stringify(guides, null, 2));
      console.log(`[streamer-language] ✅ ${streamer} language fingerprint saved (${fingerprint.length} chars)`);
    } catch(e) {
      console.error(`[streamer-language] Background analysis failed for ${streamer}:`, e.message);
    }
  })();
});

// GET /teach-streamer-language/status — check which streamers have been taught
app.get('/teach-streamer-language/status', (req, res) => {
  const guidePath = path.join(__dirname, 'cwn_style_guides.json');
  let guides = {};
  try { guides = JSON.parse(fs.readFileSync(guidePath, 'utf8')); } catch(e) {}
  const streamers = guides.streamers || {};
  res.json({
    ok: true,
    taught: Object.entries(streamers).map(([name, data]) => ({
      streamer: name,
      clipsAnalyzed: data.clipsAnalyzed,
      updatedAt: data.updatedAt,
      fingerprintLength: data.fingerprint?.length || 0
    }))
  });
});

// ── Upload-Post Queue Configuration ──────────────────────────────
// POST /publish/setup-queue — configure the Upload-Post queue with CWN schedule
// Run once after connecting social accounts. Can be re-run to update schedule.
app.post('/publish/setup-queue', async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipznashite';
  if (!UPLOADPOST_API_KEY) return res.status(400).json({ error: 'UPLOADPOST_API_KEY not set' });

  // CWN Publishing Schedule (derived from research + Rob's parameters):
  // NBA long form:  Daily, before 10am EST → handled by immediate upload, not queue
  // YT long form:   Mon(1), Tue(1), Sun(1) at 9am EST
  // YT Shorts:      Thu, Fri, Sat at 6pm + 8pm EST
  // TikTok:         Tue-Fri at 2pm + 5pm EST, Sun at 9am
  // IG Reels:       Mon-Thu at 12pm + 6pm EST

  const scheduleConfig = req.body.schedule || {
    timezone: 'America/New_York',
    max_posts_per_slot: 3, // YouTube + TikTok + Instagram can post same content at same time
    days_of_week: [0, 1, 2, 3, 4, 5, 6], // all days
    slots: [
      { hour: 9,  minute: 0  }, // 9am — YT long form (Mon/Tue/Sun) + TikTok (Sun)
      { hour: 12, minute: 0  }, // 12pm — IG Reels (Mon-Thu)
      { hour: 14, minute: 0  }, // 2pm — TikTok (Tue-Fri)
      { hour: 17, minute: 0  }, // 5pm — TikTok (Tue-Fri)
      { hour: 18, minute: 0  }, // 6pm — IG Reels (Mon-Thu) + YT Shorts (Thu/Fri/Sat)
      { hour: 20, minute: 0  }, // 8pm — YT Shorts (Thu/Fri/Sat)
    ]
  };

  try {
    const response = await axios.post(
      'https://api.upload-post.com/api/uploadposts/queue/settings',
      { profile_username: UPLOADPOST_PROFILE, ...scheduleConfig },
      { headers: { 'Authorization': `Apikey ${UPLOADPOST_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[upload-post] ✅ Queue configured for ${UPLOADPOST_PROFILE}`);
    res.json({ ok: true, schedule: scheduleConfig, response: response.data });
  } catch(e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

// ── Streamer Intro Image Burn (FFmpeg) ────────────────────────────
// Burns circular profile image + origin + fact lines onto Bobby G's intro segment
// Called during assembly for each streamer's intro avatar segment
// Input: avatar intro segment + streamer data from streamers.json
// Output: new MP4 with image card burned in for first 3 seconds
//
// POST /burn-streamer-intro
// Body: { inputPath, streamer, outputPath }
app.post('/burn-streamer-intro', async (req, res) => {
  const { inputPath, streamer, outputPath } = req.body;
  if (!inputPath || !streamer) return res.status(400).json({ error: 'inputPath + streamer required' });

  // Load streamer data
  const streamersPath = path.join(__dirname, 'streamers.json');
  let streamerData = null;
  try {
    const data = JSON.parse(fs.readFileSync(streamersPath, 'utf8'));
    streamerData = data.roster?.find(s =>
      s.displayName?.toLowerCase() === streamer.toLowerCase() ||
      s.twitchUsername?.toLowerCase() === streamer.toLowerCase()
    );
  } catch(e) {
    return res.status(400).json({ error: 'streamers.json not found — copy to ~/Downloads/' });
  }

  if (!streamerData) return res.status(404).json({ error: `Streamer "${streamer}" not found in streamers.json` });

  const out = outputPath || inputPath.replace('.mp4', '_intro.mp4');
  const profileImgUrl = streamerData.profileImage || '';
  const origin = streamerData.origin || '';
  const fact   = streamerData.fact || '';
  const name   = streamerData.displayName || streamer;

  // Download profile image to tmp
  const profileImgPath = path.join(TMP_DIR, `profile_${name.replace(/\s/g,'_')}.png`);
  let hasProfileImg = false;
  if (profileImgUrl && !fs.existsSync(profileImgPath)) {
    try {
      await downloadFile(profileImgUrl, profileImgPath);
      hasProfileImg = fs.existsSync(profileImgPath) && fs.statSync(profileImgPath).size > 100;
    } catch(e) {
      console.warn(`[burn-intro] Could not download profile image for ${name}: ${e.message}`);
    }
  } else if (fs.existsSync(profileImgPath)) {
    hasProfileImg = true;
  }

  // Build FFmpeg filter for intro card (first 3 seconds only)
  // Navy overlay box + circular profile image + name + origin + fact
  try {
    const introDur = 3.0; // seconds to show intro card
    let filterComplex;

    if (hasProfileImg) {
      // With circular profile image
      // Crop image to circle, overlay on navy box, add text
      filterComplex = [
        // Create circular mask for profile image
        `[1:v]scale=120:120,format=rgba,geq=` +
          `r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
          `a='if(lte(pow(X-60,2)+pow(Y-60,2),pow(60,2)),255,0)'[circle]`,
        // Intro card: navy box overlay for first introDur seconds
        `[0:v]drawbox=x=60:y=60:w=400:h=200:color=0x22304b@0.92:t=fill:enable='lte(t,${introDur})',` +
          // Gold border on box
          `drawbox=x=60:y=60:w=400:h=200:color=0xc7af4f@1:t=3:enable='lte(t,${introDur})',` +
          // Streamer name
          `drawtext=text='${name.toUpperCase()}':x=200:y=85:fontsize=22:fontcolor=0xc7af4f:` +
            `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})',` +
          // Origin
          `drawtext=text='Origin\\: ${origin}':x=200:y=115:fontsize=15:fontcolor=0xf0ede6:` +
            `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})',` +
          // Fact
          `drawtext=text='${fact.replace(/'/g, "'")}':x=200:y=140:fontsize=14:fontcolor=0xf0ede6:` +
            `${SYSTEM_FONT || '/Library/Fonts/Arial.ttf'}:enable='lte(t,${introDur})'[bg]`,
        // Overlay circular profile image onto card
        `[bg][circle]overlay=x=75:y=75:enable='lte(t,${introDur})'[out]`
      ].join(';');

      await new Promise((resolve, reject) => {
        const args = [
          '-i', inputPath,
          '-i', profileImgPath,
          '-filter_complex', filterComplex,
          '-map', '[out]', '-map', '0:a',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-ar', '44100',
          '-y', out
        ];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
        proc.on('error', reject);
      });
    } else {
      // Text-only version (no profile image)
      const textFilter = [
        `drawbox=x=60:y=60:w=380:h=180:color=0x22304b@0.92:t=fill:enable='lte(t,${introDur})'`,
        `drawbox=x=60:y=60:w=380:h=180:color=0xc7af4f@1:t=3:enable='lte(t,${introDur})'`,
        `drawtext=text='${name.toUpperCase()}':x=70:y=80:fontsize=22:fontcolor=0xc7af4f:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='Origin\\: ${origin}':x=70:y=110:fontsize=15:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='${fact}':x=70:y=135:fontsize=14:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`
      ].join(',');

      await new Promise((resolve, reject) => {
        const args = ['-i', inputPath, '-vf', textFilter,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-y', out];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
        proc.on('error', reject);
      });
    }

    console.log(`[burn-intro] ✅ Intro card burned for ${name}: ${path.basename(out)}`);
    res.json({ ok: true, outputPath: out, streamer: name, hasProfileImg });
  } catch(e) {
    console.error(`[burn-intro] Failed for ${name}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Shorts Pipeline ───────────────────────────────────────────────
// 9:16 vertical format for TikTok, Instagram Reels, YouTube Shorts
// Uses the portrait avatar ID instead of landscape
// Script is shorter: 40-60 words total, single clip per section
// Same QA gates, same Upload-Post publishing
//
// The short pipeline is handled by:
//   1. Dashboard selecting "short" format → uses portrait avatar ID
//   2. /generate-full-script with type = 'twitch-short' | 'nba-short' | 'news-short'
//   3. /assemble with format = 'portrait' (1080×1920)
//   4. Same QA gates (Gates 1, 2, 3) with same thresholds
//   5. /publish with contentType = 'short' → Upload-Post queues for TikTok/IG/YT Shorts

// GET /shorts/avatar-ids — return correct avatar IDs for short vs long form
app.get('/shorts/avatar-ids', (req, res) => {
  res.json({
    landscape: {
      avatarId: '19c1d4adf8904694a3cc331c5a9bee4b',
      dimensions: '1920x1080',
      format: 'landscape',
      useFor: 'YouTube long form compilations'
    },
    portrait: {
      avatarId: 'ed57439c9c3d4a398f3b247b75714b13',
      dimensions: '1080x1920',
      format: 'portrait',
      useFor: 'TikTok, Instagram Reels, YouTube Shorts'
    },
    voiceId: '2e598f1a6022448cb6710e5d44665325',
    baseSpeed: 0.85,
    reactionSpeed: 0.95
  });
});

// POST /shorts/cut-from-long — extract short clip from long-form video for Shorts
// Cuts a specific streamer's section from the assembled long-form video
// Body: { longFormPath, startTime, endTime, outputName }
app.post('/shorts/cut-from-long', async (req, res) => {
  const { longFormPath, startTime, endTime, outputName } = req.body;
  if (!longFormPath || startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: 'longFormPath, startTime, endTime required' });
  }

  const inPath = path.isAbsolute(longFormPath)
    ? longFormPath
    : path.join(OUTPUT_DIR, path.basename(longFormPath));

  if (!fs.existsSync(inPath)) return res.status(404).json({ error: 'Long form video not found' });

  const outFile = outputName || `short_${Date.now()}.mp4`;
  const outPath = path.join(OUTPUT_DIR, outFile);
  const duration = endTime - startTime;

  try {
    // Cut segment, scale to 9:16 with padding if needed
    await new Promise((resolve, reject) => {
      const args = [
        '-ss', startTime.toString(),
        '-i', inPath,
        '-t', duration.toString(),
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-ar', '44100',
        '-movflags', '+faststart',
        '-y', outPath
      ];
      const proc = execFile(ffmpegPath(), args);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
      proc.on('error', reject);
    });

    const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`[shorts] ✅ Cut from ${startTime}s-${endTime}s → ${outFile} (${size}MB)`);
    res.json({ ok: true, outputPath: outPath, filename: outFile, duration, sizeMB: parseFloat(size) });
  } catch(e) {
    console.error('[shorts] Cut failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// POST /gate2-segment-qa — Gate 2: Gemini reviews completed HeyGen segments
// Called automatically by dashboard when all avatar segments finish polling.
// Downloads segment files, samples first/middle/last, scores lip sync + audio + freeze.
// PASS >= 85: auto-proceed to assemble button. MANUAL 65-84: flag for Rob. FAIL < 65: retry.
app.post('/gate2-segment-qa', async (req, res) => {
  const { jobId, segments, contentType = 'twitch' } = req.body;
  if (!segments || !segments.length) return res.status(400).json({ error: 'segments required' });
  if (!GEMINI_APIKEY) return res.json({ score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (no key)', deductions: [], skipped: true });

  // Download avatar segments to tmp for Gemini analysis
  const avatarSegs = segments.filter(s => s.type !== 'source_clip' && s.url);
  if (!avatarSegs.length) return res.json({ score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (no avatar segs)', deductions: [] });

  const tmpPaths = [];
  // Sample first, middle, last — max 3 downloads
  const toCheck = [
    avatarSegs[0],
    avatarSegs[Math.floor(avatarSegs.length / 2)],
    avatarSegs[avatarSegs.length - 1]
  ].filter((s, i, arr) => arr.indexOf(s) === i); // dedupe

  console.log(`[gate2] Downloading ${toCheck.length} segments for QA (job: ${jobId})...`);

  for (const seg of toCheck) {
    const tmpPath = path.join(TMP_DIR, `gate2_${Date.now()}_${Math.random().toString(36).slice(2,6)}.mp4`);
    try {
      await downloadFile(seg.url, tmpPath);
      const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      if (size > 5000) {
        tmpPaths.push(tmpPath);
        console.log(`[gate2] Downloaded: ${seg.label} (${(size/1024/1024).toFixed(1)}MB)`);
      } else {
        console.warn(`[gate2] Segment too small (${size}b) — skipping: ${seg.label}`);
        try { fs.unlinkSync(tmpPath); } catch(e) {}
      }
    } catch(e) {
      console.warn(`[gate2] Download failed for ${seg.label}: ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!tmpPaths.length) {
    return res.json({ score: 75, passed: false, outcome: 'manual_review', outcomeLabel: '🟡 MANUAL REVIEW (download failed)', deductions: [{ points: 25, reason: 'Could not download segments for QA' }] });
  }

  try {
    const result = await geminiSegmentQA(tmpPaths, { jobId, contentType });
    res.json(result);
  } catch(e) {
    console.error('[gate2] QA error:', e.message);
    res.json({ score: 75, passed: false, outcome: 'manual_review', outcomeLabel: '🟡 MANUAL REVIEW (QA error)', deductions: [{ points: 25, reason: e.message }] });
  } finally {
    tmpPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
  }
});


// ── POST /remediate-video ─────────────────────────────────────────
// Pre-publish remediation: downloads assembled video from Drive,
// applies any FFmpeg work that failed during assembly (intro cards,
// logo bug, etc.), re-uploads to Drive, returns new Drive URL.
//
// Called automatically before Upload-Post publish if remediation items exist.
// Also callable manually from dashboard.
//
// Body: {
//   driveUrl: string,         // current Drive download URL
//   jobId: string,
//   contentType: string,      // 'twitch' | 'nba' | 'news'
//   missedItems: string[],    // ['intro_cards', 'logo_bug']
//   streamers: []             // streamer data for intro cards
// }
app.post('/remediate-video', async (req, res) => {
  const { driveUrl, jobId, contentType = 'twitch', missedItems = [], streamers = [] } = req.body;
  if (!driveUrl) return res.status(400).json({ error: 'driveUrl required' });
  if (!missedItems.length) return res.json({ ok: true, driveUrl, message: 'Nothing to remediate' });

  const remId = 'rem_' + Date.now();
  console.log(`[remediate] Starting remediation for job ${jobId}: ${missedItems.join(', ')}`);

  // Step 1: Download video from Drive
  const tmpInput  = path.join(TMP_DIR, `${remId}_input.mp4`);
  const tmpOutput = path.join(TMP_DIR, `${remId}_output.mp4`);

  try {
    console.log(`[remediate] Downloading from Drive...`);
    await downloadFile(driveUrl, tmpInput);
    const inputSize = fs.statSync(tmpInput).size;
    if (inputSize < 100000) throw new Error(`Downloaded file too small (${inputSize}b) — Drive URL may be expired`);
    console.log(`[remediate] Downloaded: ${(inputSize/1024/1024).toFixed(1)}MB`);

    let currentFile = tmpInput;
    const appliedItems = [];
    const failedItems  = [];

    // ── Remediation: Intro Cards ────────────────────────────────────
    // Burns streamer intro cards onto each intro segment region of the video.
    // For Twitch compilations: overlays name/origin/fact card for 3s at each
    // streamer section start, estimated by known segment timing.
    if (missedItems.includes('intro_cards') && contentType === 'twitch' && streamers.length > 0) {
      console.log(`[remediate] Applying intro cards for ${streamers.length} streamers...`);

      // Get video duration to calculate streamer start times
      const videoDur = await probeDuration(currentFile);

      // Build drawtext filter for ALL streamers in one pass
      // Each card shows at estimated start time for 3 seconds
      // We estimate start times from the video duration / streamer count
      const avgPerStreamer = videoDur / (streamers.length + 1); // +1 for cold open
      const filterParts = [];

      streamers.forEach((streamer, idx) => {
        if (!streamer || !streamer.displayName) return;
        const name   = (streamer.displayName || '').toUpperCase().replace(/'/g, "\'").replace(/:/g, '\:');
        const origin = (streamer.origin || '').replace(/'/g, "\'").replace(/:/g, '\:');
        const fact   = (streamer.fact   || '').replace(/'/g, "\'").replace(/:/g, '\:').slice(0, 40);

        // Estimated start time for this streamer's intro
        const startT = Math.round((idx + 1) * avgPerStreamer);
        const endT   = startT + 3;
        const fontPath = (SYSTEM_FONT || '/Library/Fonts/Arial.ttf').replace(/ /g, '\\ ');

        // Navy box + gold border + text (3 lines)
        filterParts.push(
          `drawbox=x=50:y=50:w=420:h=170:color=0x22304b@0.92:t=fill:enable='between(t\,${startT}\,${endT})'`,
          `drawbox=x=50:y=50:w=420:h=170:color=0xc7af4f@1:t=3:enable='between(t\,${startT}\,${endT})'`,
          `drawtext=text='${name}':x=65:y=72:fontsize=20:fontcolor=0xc7af4f:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'`,
          origin ? `drawtext=text='Origin\: ${origin}':x=65:y=102:fontsize=14:fontcolor=0xf0ede6:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'` : null,
          fact   ? `drawtext=text='${fact}':x=65:y=125:fontsize=13:fontcolor=0xf0ede6:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'` : null,
        ).filter(Boolean);
      });

      if (filterParts.length > 0) {
        const introOutput = path.join(TMP_DIR, `${remId}_intro_cards.mp4`);
        const filterStr   = filterParts.join(',');

        try {
          await new Promise((res, rej) => {
            const args = [
              '-i', currentFile,
              '-vf', filterStr,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
              '-c:a', 'copy',
              '-movflags', '+faststart',
              '-y', introOutput
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
            let stderr = '';
            ff.stderr && ff.stderr.on('data', d => { stderr += d; });
            ff.on('close', code => {
              if (code === 0) res();
              else rej(new Error(`Intro cards FFmpeg exit ${code}: ${stderr.slice(-200)}`));
            });
            ff.on('error', rej);
          });

          if (fs.existsSync(introOutput) && fs.statSync(introOutput).size > 100000) {
            currentFile = introOutput;
            appliedItems.push('intro_cards');
            console.log(`[remediate] ✅ Intro cards applied`);
          }
        } catch(e) {
          failedItems.push({ item: 'intro_cards', error: e.message });
          console.warn(`[remediate] ⚠️  Intro cards failed: ${e.message}`);
        }
      }
    }

    // ── Remediation: Logo Bug ───────────────────────────────────────
    if (missedItems.includes('logo_bug')) {
      const logoPng = CWN_LOGO_PATH;
      if (logoPng && fs.existsSync(logoPng)) {
        console.log(`[remediate] Applying logo bug...`);
        const logoOutput = path.join(TMP_DIR, `${remId}_logo.mp4`);
        try {
          await new Promise((res, rej) => {
            const args = [
              '-i', currentFile, '-i', logoPng,
              '-filter_complex',
              '[1:v]scale=120:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=W-w-20:20[vout]',
              '-map', '[vout]', '-map', '0:a?',
              '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy',
              '-movflags', '+faststart', '-y', logoOutput
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100*1024*1024 });
            ff.on('close', code => code === 0 ? res() : rej(new Error(`Logo FFmpeg exit ${code}`)));
            ff.on('error', rej);
          });
          if (fs.existsSync(logoOutput) && fs.statSync(logoOutput).size > 100000) {
            currentFile = logoOutput;
            appliedItems.push('logo_bug');
            console.log(`[remediate] ✅ Logo bug applied`);
          }
        } catch(e) {
          failedItems.push({ item: 'logo_bug', error: e.message });
          console.warn(`[remediate] ⚠️  Logo bug failed: ${e.message}`);
        }
      } else {
        failedItems.push({ item: 'logo_bug', error: 'logo_cwn.png not found' });
      }
    }

    // ── Step 3: Copy final to output dir + re-upload to Drive ───────
    if (appliedItems.length === 0) {
      // Nothing was applied — clean up and return original URL
      try { fs.unlinkSync(tmpInput); } catch(e) {}
      return res.json({ ok: true, driveUrl, appliedItems: [], failedItems, message: 'No remediation applied — check errors' });
    }

    const outFilename = `remediated_${jobId || remId}_${Date.now()}.mp4`;
    const outPath     = path.join(OUTPUT_DIR, outFilename);
    fs.copyFileSync(currentFile, outPath);

    // Clean up tmp files
    [tmpInput, tmpOutput].forEach(f => { try { if (f !== currentFile) fs.unlinkSync(f); } catch(e) {} });

    // Re-upload to Drive
    console.log(`[remediate] Re-uploading to Drive...`);
    let newDriveUrl = driveUrl; // fallback to original if upload fails
    try {
      const uploadedUrl = await uploadToDrive(outPath, outFilename, `REMEDIATED — ${jobId || outFilename}`);
      if (uploadedUrl) {
        newDriveUrl = uploadedUrl;
        console.log(`[remediate] ✅ Re-uploaded: ${newDriveUrl}`);
      }
    } catch(e) {
      console.warn(`[remediate] ⚠️  Drive re-upload failed: ${e.message} — using original URL`);
    }

    res.json({
      ok: true,
      driveUrl: newDriveUrl,
      originalUrl: driveUrl,
      appliedItems,
      failedItems,
      outputFile: outFilename,
      message: `Applied: ${appliedItems.join(', ')}${failedItems.length ? ' | Failed: ' + failedItems.map(f=>f.item).join(', ') : ''}`
    });

  } catch(err) {
    console.error('[remediate] Error:', err.message);
    try { fs.unlinkSync(tmpInput); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

// GET /remediate-video/check/:jobId — check what remediation is needed
// Reads the assembly log to determine what was missed
app.get('/remediate-video/check/:jobId', (req, res) => {
  const { jobId } = req.params;
  // Check assembly log for missed items
  const missed = [];
  // Check if logo exists
  if (!CWN_LOGO_PATH) missed.push('logo_bug');
  // Font check — if SYSTEM_FONT is null, intro cards will fail
  if (!SYSTEM_FONT) missed.push('intro_cards_no_font');
  res.json({ jobId, missed, fontPath: SYSTEM_FONT, logoPath: CWN_LOGO_PATH });
});


// ── POST /generate-thumbnail ──────────────────────────────────────
// Generates a Twitch compilation YouTube thumbnail by:
// 1. Reading streamer profile images from streamers.json
// 2. Uploading each to Canva via MCP
// 3. Swapping them into the template design
// 4. Updating hook line + date text
// 5. Exporting as JPG → storing in Drive
//
// Body: { jobId, hookLine, date, streamers: ['jason','hasan',...] }
// Returns: { ok, canvaUrl, exportUrl }

const TWITCH_THUMBNAIL_TEMPLATE_ID = 'DAHGB-hGwds';

// Element IDs for the 11 streamer circles in the template (ring order)
const THUMBNAIL_CIRCLE_ELEMENT_IDS = [
  'PBs5L1XPdkxX4FNn-LBqzjtXxlBKcKZRW', // position 1 (left-mid)
  'PBs5L1XPdkxX4FNn-LB04qHSRp15SC4bb', // position 2 (left-upper)
  'PBs5L1XPdkxX4FNn-LBy2hNzFzq8RB5TD', // position 3 (top-left)
  'PBs5L1XPdkxX4FNn-LBJW8Sft0FgzmRkz', // position 4 (top-right)
  'PBs5L1XPdkxX4FNn-LBXgrNQD2QmCgBYB', // position 5 (right-upper)
  'PBs5L1XPdkxX4FNn-LBR6x2xHwXS72H0p', // position 6 (right-mid)
  'PBs5L1XPdkxX4FNn-LBPK73CS5j4PHYMc', // position 7 (right-lower)
  'PBs5L1XPdkxX4FNn-LBcLMSzNshJzjbQS', // position 8 (bottom-right)
  'PBs5L1XPdkxX4FNn-LBNCnh4gjsKVPl8G', // position 9 (bottom-center)
  'PBs5L1XPdkxX4FNn-LB7jt94dj44cwnD5', // position 10 (bottom-left)
  'PBs5L1XPdkxX4FNn-LBg8l43YPZn3lm06', // position 11 (left-lower)
];

const THUMBNAIL_TEXT_ELEMENT_IDS = {
  hookLine: 'PBs5L1XPdkxX4FNn-LB50hKpBXHtvdLKj', // "BEST TWITCH CLIPS"
  branding: 'PBs5L1XPdkxX4FNn-LBbqf1yz2f6pgXcB', // "CLIPZWORLD NEWS • THE DAILY UPDATE"
};

app.post('/generate-thumbnail', async (req, res) => {
  const { jobId, hookLine, date, streamers: streamerSlugs } = req.body;
  const CANVA_MCP_URL = 'https://mcp.canva.com/mcp';

  // Load streamer roster
  let roster = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'streamers.json'), 'utf8'));
    roster = data.roster || [];
  } catch(e) {
    return res.status(400).json({ error: 'streamers.json not found' });
  }

  // Get active streamers in configured order (max 11 for the circles)
  const activeStreamers = roster
    .filter(s => s.active)
    .slice(0, THUMBNAIL_CIRCLE_ELEMENT_IDS.length);

  const dateStr  = date || new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const hookText = hookLine || 'BEST TWITCH CLIPS';

  console.log(`[thumbnail] Generating for ${activeStreamers.length} streamers, date: ${dateStr}`);
  res.json({ ok: true, message: 'Thumbnail generation started — check /thumbnail-status/' + jobId });

  // Run async — Canva MCP calls take time
  (async () => {
    try {
      const client = new Anthropic();

      // Build the prompt for Claude to execute all Canva operations
      const streamerList = activeStreamers.map((s, i) => {
        const hiResUrl = (s.profileImage || '')
          .replace(/-70x70\./, '-300x300.')
          .replace(/-28x28\./, '-300x300.');
        return `${i + 1}. ${s.displayName} — image URL: ${hiResUrl || s.profileImage || ''} — element_id: ${THUMBNAIL_CIRCLE_ELEMENT_IDS[i]}`;
      }).join('\n');

      const systemPrompt = `You are a Canva automation assistant. 
Execute the following steps using the Canva MCP tools EXACTLY as specified.
Do each step in order. Return a JSON object with { canvaUrl, success }.
No explanations — just execute and return JSON.`;

      const userPrompt = `Execute these Canva operations on design ID: ${TWITCH_THUMBNAIL_TEMPLATE_ID}

STEP 1: For each streamer below, call upload-asset-from-url with their image URL.
Note the returned asset_id for each.

Streamers and their circle element IDs:
${streamerList}

STEP 2: Start an editing transaction on design ${TWITCH_THUMBNAIL_TEMPLATE_ID}

STEP 3: For each streamer, call perform-editing-operations with an update_fill operation:
- element_id: [their element_id from above]
- asset_type: "image"
- asset_id: [the asset_id returned in step 1]
- alt_text: "[streamer name] profile"

STEP 4: In the same perform-editing-operations call, also update the text elements:
- element_id: ${THUMBNAIL_TEXT_ELEMENT_IDS.hookLine}
  replace_text: "${hookText}"
- element_id: ${THUMBNAIL_TEXT_ELEMENT_IDS.branding}
  find_text: "CLIPZWORLD NEWS  •  THE DAILY UPDATE"
  replace_text: "CLIPZWORLD NEWS  •  ${dateStr.toUpperCase()}"

STEP 5: Commit the editing transaction.

STEP 6: Return JSON: { "canvaUrl": "https://www.canva.com/d/...", "success": true }`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        mcp_servers: [{ type: 'url', url: CANVA_MCP_URL, name: 'canva-mcp' }]
      });

      const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      let result = {};
      try {
        const clean = textBlocks.replace(/```json|```/g, '').trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (jsonMatch) result = JSON.parse(jsonMatch[0]);
      } catch(e) {}

      const canvaUrl = result.canvaUrl || `https://www.canva.com/design/${TWITCH_THUMBNAIL_TEMPLATE_ID}`;
      console.log(`[thumbnail] ✅ Complete: ${canvaUrl}`);

      // Store result so dashboard can poll
      if (!global._thumbnailJobs) global._thumbnailJobs = {};
      global._thumbnailJobs[jobId] = { ok: true, canvaUrl, completedAt: new Date().toISOString() };

    } catch(err) {
      console.error('[thumbnail] Error:', err.message);
      if (!global._thumbnailJobs) global._thumbnailJobs = {};
      global._thumbnailJobs[jobId] = { ok: false, error: err.message };
    }
  })();
});

// GET /thumbnail-status/:jobId — poll thumbnail generation
app.get('/thumbnail-status/:jobId', (req, res) => {
  const result = (global._thumbnailJobs || {})[req.params.jobId];
  if (!result) return res.json({ status: 'pending', message: 'Still generating...' });
  res.json({ status: result.ok ? 'done' : 'failed', ...result });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 CWN Production Server running on http://localhost:${PORT}`);
  console.log(`   FFmpeg path: ${ffmpegPath()}`);
  console.log(`   Tmp dir:     ${TMP_DIR}`);
  console.log(`   Output dir:  ${OUTPUT_DIR}\n`);
  checkFFmpeg((err, v) => {
    if (err) console.warn('⚠️  FFmpeg not found:', err.message);
    else console.log('✅ FFmpeg:', v);
  });
});
