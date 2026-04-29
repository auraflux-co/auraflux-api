'use strict';
// C0-ONLY — Gate management, video remediation, thumbnail generation, cleanup
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const puppeteer = require('puppeteer');
const { execFile } = require('child_process');
const { ffmpegPath: _ffmpegDockerPath } = require('../ffmpeg_utils');

const ROOT_DIR = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const TMP_DIR = path.join(ROOT_DIR, 'tmp');
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

function ffmpegPath() {
  return _ffmpegDockerPath();
}

function puppeteerExecutablePath() {
  try {
    const os = require('os');
    const cacheBase = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheBase)) {
      const vers = fs.readdirSync(cacheBase).sort().reverse();
      for (const ver of vers) {
        const candidates = [
          path.join(
            cacheBase,
            ver,
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
          ),
          path.join(
            cacheBase,
            ver,
            'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
          ),
          path.join(cacheBase, ver, 'chrome-linux64', 'chrome'),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch (_) {}
  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'linux') {
    for (const p of [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}
function withPuppeteerExecutable(opts) {
  const exe = puppeteerExecutablePath();
  return exe ? { ...opts, executablePath: exe } : opts;
}

router.post('/gate-fix-log', (req, res) => {
  const entry = req.body;
  if (!entry) return res.json({ ok: false, error: 'No body' });
  const logPath = path.join(ROOT_DIR, 'logs', 'gate_fixes.jsonl');
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /gate2-segment-qa — Gate 2: Gemini reviews completed HeyGen segments
// Called automatically by dashboard when all avatar segments finish polling.
// Downloads segment files, samples first/middle/last, scores lip sync + audio + freeze.
// PASS >= 85: auto-proceed to assemble button. MANUAL 65-84: flag for Rob. FAIL < 65: retry.
router.post('/gate2-segment-qa', async (req, res) => {
  const { jobId, segments, contentType = 'twitch' } = req.body;
  if (!segments || !segments.length) return res.status(400).json({ error: 'segments required' });
  if (!GEMINI_APIKEY)
    return res.json({
      score: 100,
      passed: true,
      outcome: 'pass',
      outcomeLabel: '✅ PASS (no key)',
      deductions: [],
      skipped: true,
    });

  // Download avatar segments to tmp for Gemini analysis
  const avatarSegs = segments.filter((s) => s.type !== 'source_clip' && s.url);
  if (!avatarSegs.length)
    return res.json({
      score: 100,
      passed: true,
      outcome: 'pass',
      outcomeLabel: '✅ PASS (no avatar segs)',
      deductions: [],
    });

  const tmpPaths = [];
  // Sample first, middle, last — max 3 downloads
  const toCheck = [
    avatarSegs[0],
    avatarSegs[Math.floor(avatarSegs.length / 2)],
    avatarSegs[avatarSegs.length - 1],
  ].filter((s, i, arr) => arr.indexOf(s) === i); // dedupe

  console.log(`[gate2] Downloading ${toCheck.length} segments for QA (job: ${jobId})...`);

  for (const seg of toCheck) {
    const tmpPath = path.join(
      TMP_DIR,
      `gate2_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`
    );
    try {
      await downloadFile(seg.url, tmpPath);
      const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
      if (size > 5000) {
        tmpPaths.push(tmpPath);
        console.log(`[gate2] Downloaded: ${seg.label} (${(size / 1024 / 1024).toFixed(1)}MB)`);
      } else {
        console.warn(`[gate2] Segment too small (${size}b) — skipping: ${seg.label}`);
        try {
          fs.unlinkSync(tmpPath);
        } catch (e) {}
      }
    } catch (e) {
      console.warn(`[gate2] Download failed for ${seg.label}: ${e.message}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch (e2) {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!tmpPaths.length) {
    return res.json({
      score: 75,
      passed: false,
      outcome: 'manual_review',
      outcomeLabel: '🟡 MANUAL REVIEW (download failed)',
      deductions: [{ points: 25, reason: 'Could not download segments for QA' }],
    });
  }

  try {
    const gate2Worker = require('../portals/portal2');
    const minJobSpec = {
      jobId: jobId || 'manual-qa',
      customerId: req.body.customerId || 'c0',
      templateId: contentType?.includes('short') ? 'short-form' : 'long-form',
      contentType: contentType || 'twitch',
      state: { gateResults: {}, savedOutputs: {} },
      designSpec: { chrome: {}, audio: {}, resolution: { width: 1920, height: 1080 }, ffmpeg: {} },
      commitments: {},
    };
    const g2Result = await gate2Worker.run(minJobSpec, tmpPaths, {});
    // Translate new gate worker output to legacy dashboard format
    const result = {
      score: g2Result.score,
      passed: g2Result.passed,
      outcome:
        g2Result.outcome === 'hard_fail'
          ? 'fail'
          : g2Result.outcome === 'review'
            ? 'manual_review'
            : 'pass',
      outcomeLabel: g2Result.passed
        ? '✅ PASS'
        : g2Result.outcome === 'review'
          ? '🟡 MANUAL REVIEW'
          : '❌ HARD FAIL',
      deductions: (g2Result.segmentResults || [])
        .filter((s) => !s.passed)
        .map((s) => ({
          points: 25,
          reason: `Segment failed: ${s.segmentPath ? require('path').basename(s.segmentPath) : 'unknown'}`,
        })),
    };
    res.json(result);
  } catch (e) {
    console.error('[gate2] QA error:', e.message);
    res.json({
      score: 75,
      passed: false,
      outcome: 'manual_review',
      outcomeLabel: '🟡 MANUAL REVIEW (QA error)',
      deductions: [{ points: 25, reason: e.message }],
    });
  } finally {
    tmpPaths.forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch (e) {}
    });
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
router.post('/remediate-video', async (req, res) => {
  const { driveUrl, jobId, contentType = 'twitch', missedItems = [], streamers = [] } = req.body;
  if (!driveUrl) return res.status(400).json({ error: 'driveUrl required' });
  if (!missedItems.length) return res.json({ ok: true, driveUrl, message: 'Nothing to remediate' });

  const remId = 'rem_' + Date.now();
  console.log(`[remediate] Starting remediation for job ${jobId}: ${missedItems.join(', ')}`);

  // Step 1: Download video from Drive
  const tmpInput = path.join(TMP_DIR, `${remId}_input.mp4`);
  const tmpOutput = path.join(TMP_DIR, `${remId}_output.mp4`);

  try {
    console.log(`[remediate] Downloading from Drive...`);
    await downloadFile(driveUrl, tmpInput);
    const inputSize = fs.statSync(tmpInput).size;
    if (inputSize < 100000)
      throw new Error(`Downloaded file too small (${inputSize}b) — Drive URL may be expired`);
    console.log(`[remediate] Downloaded: ${(inputSize / 1024 / 1024).toFixed(1)}MB`);

    let currentFile = tmpInput;
    const appliedItems = [];
    const failedItems = [];

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
        const name = (streamer.displayName || '')
          .toUpperCase()
          .replace(/'/g, "\'")
          .replace(/:/g, '\:');
        const origin = (streamer.origin || '').replace(/'/g, "\'").replace(/:/g, '\:');
        const fact = (streamer.fact || '').replace(/'/g, "\'").replace(/:/g, '\:').slice(0, 40);

        // Estimated start time for this streamer's intro
        const startT = Math.round((idx + 1) * avgPerStreamer);
        const endT = startT + 3;
        const fontPath = (SYSTEM_FONT || '/Library/Fonts/Arial.ttf').replace(/ /g, '\\ ');

        // Navy box + gold border + text (3 lines)
        filterParts
          .push(
            `drawbox=x=50:y=50:w=420:h=170:color=0x22304b@0.92:t=fill:enable='between(t\,${startT}\,${endT})'`,
            `drawbox=x=50:y=50:w=420:h=170:color=0xc7af4f@1:t=3:enable='between(t\,${startT}\,${endT})'`,
            `drawtext=text='${name}':x=65:y=72:fontsize=20:fontcolor=0xc7af4f:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'`,
            origin
              ? `drawtext=text='Origin\: ${origin}':x=65:y=102:fontsize=14:fontcolor=0xf0ede6:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'`
              : null,
            fact
              ? `drawtext=text='${fact}':x=65:y=125:fontsize=13:fontcolor=0xf0ede6:fontfile=${fontPath}:enable='between(t\,${startT}\,${endT})'`
              : null
          )
          .filter(Boolean);
      });

      if (filterParts.length > 0) {
        const introOutput = path.join(TMP_DIR, `${remId}_intro_cards.mp4`);
        const filterStr = filterParts.join(',');

        try {
          await new Promise((res, rej) => {
            const args = [
              '-i',
              currentFile,
              '-vf',
              filterStr,
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '22',
              '-c:a',
              'copy',
              '-movflags',
              '+faststart',
              '-y',
              introOutput,
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
            let stderr = '';
            ff.stderr &&
              ff.stderr.on('data', (d) => {
                stderr += d;
              });
            ff.on('close', (code) => {
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
        } catch (e) {
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
              '-i',
              currentFile,
              '-i',
              logoPng,
              '-filter_complex',
              `[1:v]scale=${(contentType === 'news' ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).size}:-1,format=rgba,colorchannelmixer=aa=${(contentType === 'news' ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).opacity || 0.85}[logo];[0:v][logo]overlay=${(contentType === 'news' ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).x}:${(contentType === 'news' ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).y}[vout]`,
              '-map',
              '[vout]',
              '-map',
              '0:a?',
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-c:a',
              'copy',
              '-movflags',
              '+faststart',
              '-y',
              logoOutput,
            ];
            const ff = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
            ff.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Logo FFmpeg exit ${code}`))
            );
            ff.on('error', rej);
          });
          if (fs.existsSync(logoOutput) && fs.statSync(logoOutput).size > 100000) {
            currentFile = logoOutput;
            appliedItems.push('logo_bug');
            console.log(`[remediate] ✅ Logo bug applied`);
          }
        } catch (e) {
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
      try {
        fs.unlinkSync(tmpInput);
      } catch (e) {}
      return res.json({
        ok: true,
        driveUrl,
        appliedItems: [],
        failedItems,
        message: 'No remediation applied — check errors',
      });
    }

    const outFilename = `remediated_${jobId || remId}_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outFilename);
    fs.copyFileSync(currentFile, outPath);

    // Clean up tmp files
    [tmpInput, tmpOutput].forEach((f) => {
      try {
        if (f !== currentFile) fs.unlinkSync(f);
      } catch (e) {}
    });

    // Re-upload to Drive
    console.log(`[remediate] Re-uploading to Drive...`);
    let newDriveUrl = driveUrl; // fallback to original if upload fails
    try {
      const uploadedUrl = await uploadToDrive(
        outPath,
        outFilename,
        `REMEDIATED — ${jobId || outFilename}`
      );
      if (uploadedUrl) {
        newDriveUrl = uploadedUrl;
        console.log(`[remediate] ✅ Re-uploaded: ${newDriveUrl}`);
      }
    } catch (e) {
      console.warn(`[remediate] ⚠️  Drive re-upload failed: ${e.message} — using original URL`);
    }

    res.json({
      ok: true,
      driveUrl: newDriveUrl,
      originalUrl: driveUrl,
      appliedItems,
      failedItems,
      outputFile: outFilename,
      message: `Applied: ${appliedItems.join(', ')}${failedItems.length ? ' | Failed: ' + failedItems.map((f) => f.item).join(', ') : ''}`,
    });
  } catch (err) {
    console.error('[remediate] Error:', err.message);
    try {
      fs.unlinkSync(tmpInput);
    } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// GET /remediate-video/check/:jobId — check what remediation is needed
// Reads the assembly log to determine what was missed
router.get('/remediate-video/check/:jobId', (req, res) => {
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

router.post('/generate-thumbnail', async (req, res) => {
  const { jobId, hookLine, date, streamers: streamerSlugs } = req.body;

  // Load streamer roster
  let roster = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/streamers.json'), 'utf8'));
    roster = data.roster || [];
  } catch (e) {
    return res.status(400).json({ error: 'streamers.json not found' });
  }

  // Get active streamers in configured order (max 12 for the circles)
  const activeStreamers = roster
    .filter((s) => s.active)
    .slice(0, THUMBNAIL_CIRCLE_ELEMENT_IDS.length);

  const dateStr =
    date ||
    new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const hookText = hookLine || 'BEST TWITCH CLIPS';

  console.log(`[thumbnail] Generating for ${activeStreamers.length} streamers, date: ${dateStr}`);
  res.json({
    ok: true,
    message: 'Thumbnail generation started — check /thumbnail-status/' + jobId,
  });

  // Run async — Canva API calls take time
  (async () => {
    try {
      const CANVA_ACCESS_TOKEN = process.env.CANVA_ACCESS_TOKEN;

      if (!CANVA_ACCESS_TOKEN) {
        throw new Error('CANVA_ACCESS_TOKEN not set in .env — see CANVA_SETUP.md for instructions');
      }

      // STEP 1: Upload streamer profile images as assets
      console.log(`[thumbnail] Uploading ${activeStreamers.length} profile images...`);
      const uploadedAssets = [];

      for (const [index, streamer] of activeStreamers.entries()) {
        const hiResUrl = (streamer.profileImage || '')
          .replace(/-70x70\./, '-300x300.')
          .replace(/-28x28\./, '-300x300.');

        if (!hiResUrl) {
          console.warn(`[thumbnail] No profile image for ${streamer.displayName}, skipping`);
          continue;
        }

        // Upload asset via Canva API
        const uploadResp = await axios.post(
          'https://api.canva.com/rest/v1/url-asset-uploads',
          {
            name: `${streamer.displayName} profile`,
            url: hiResUrl,
          },
          {
            headers: {
              Authorization: `Bearer ${CANVA_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        const uploadJob = uploadResp.data.job;
        console.log(
          `[thumbnail] Upload job ${uploadJob.id} for ${streamer.displayName}: ${uploadJob.status}`
        );

        // Poll for upload completion (max 30 seconds)
        let asset = null;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3000));

          const statusResp = await axios.get(
            `https://api.canva.com/rest/v1/url-asset-uploads/${uploadJob.id}`,
            {
              headers: { Authorization: `Bearer ${CANVA_ACCESS_TOKEN}` },
            }
          );

          const job = statusResp.data.job;
          if (job.status === 'success') {
            asset = job.asset;
            console.log(`[thumbnail] ✅ Asset uploaded: ${asset.id}`);
            break;
          } else if (job.status === 'failed') {
            console.error(`[thumbnail] ❌ Upload failed: ${job.error?.message}`);
            break;
          }
        }

        if (asset) {
          uploadedAssets.push({ streamer: streamer.displayName, assetId: asset.id, index });
        }
      }

      // STEP 2: Create autofill job with template
      console.log(`[thumbnail] Creating autofill design with ${uploadedAssets.length} images...`);

      // Build data mapping for autofill (this requires the template to have named data fields)
      const autofillData = {};

      // Add streamer images to data mapping
      uploadedAssets.forEach(({ assetId, index }) => {
        autofillData[`streamer${index + 1}`] = {
          type: 'image',
          asset_id: assetId,
        };
      });

      // Add text fields
      autofillData.hookLine = {
        type: 'text',
        text: hookText,
      };

      autofillData.dateLine = {
        type: 'text',
        text: `CLIPZWORLD NEWS  •  ${dateStr.toUpperCase()}`,
      };

      const autofillResp = await axios.post(
        'https://api.canva.com/rest/v1/autofills',
        {
          brand_template_id: TWITCH_THUMBNAIL_TEMPLATE_ID,
          data: autofillData,
          title: `Twitch Compilation - ${dateStr}`,
        },
        {
          headers: {
            Authorization: `Bearer ${CANVA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const autofillJob = autofillResp.data.job;
      console.log(`[thumbnail] Autofill job ${autofillJob.id}: ${autofillJob.status}`);

      // Poll for autofill completion (max 60 seconds)
      let design = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));

        const statusResp = await axios.get(
          `https://api.canva.com/rest/v1/autofills/${autofillJob.id}`,
          {
            headers: { Authorization: `Bearer ${CANVA_ACCESS_TOKEN}` },
          }
        );

        const job = statusResp.data.job;
        if (job.status === 'success') {
          design = job.result.design;
          console.log(`[thumbnail] ✅ Design created: ${design.id}`);
          break;
        } else if (job.status === 'failed') {
          throw new Error(`Autofill failed: ${job.error?.message || 'Unknown error'}`);
        }
      }

      if (!design) {
        throw new Error('Autofill job timed out');
      }

      const canvaUrl = design.urls.edit_url;
      console.log(`[thumbnail] ✅ Complete: ${canvaUrl}`);

      // Store result so dashboard can poll
      if (!global._thumbnailJobs) global._thumbnailJobs = {};
      global._thumbnailJobs[jobId] = {
        ok: true,
        canvaUrl,
        designId: design.id,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.error('[thumbnail] Error:', err.message);
      if (err.response) {
        console.error('[thumbnail] Canva API error:', err.response.data);
      }
      if (!global._thumbnailJobs) global._thumbnailJobs = {};
      global._thumbnailJobs[jobId] = { ok: false, error: err.message };
    }
  })();
});

// GET /thumbnail-status/:jobId — poll thumbnail generation
router.get('/thumbnail-status/:jobId', (req, res) => {
  const result = (global._thumbnailJobs || {})[req.params.jobId];
  if (!result) return res.json({ status: 'pending', message: 'Still generating...' });
  res.json({ status: result.ok ? 'done' : 'failed', ...result });
});

// POST /cleanup — remove old output files, keep only the N most recent
// Body: { keepCount: 2, cleanTmp: true, cleanQaLogs: false }
router.post('/cleanup', async (req, res) => {
  const { keepCount = 2, cleanTmp = true, cleanQaLogs = false } = req.body;
  const results = { deleted: [], kept: [], freed: 0 };

  // ── Output MP4s — keep N most recent ──────────────────────────
  try {
    const files = fs
      .readdirSync(OUTPUT_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({
        name: f,
        path: path.join(OUTPUT_DIR, f),
        mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(keepCount);
    const toKeep = files.slice(0, keepCount);

    toKeep.forEach((f) => results.kept.push(f.name));
    for (const f of toDelete) {
      const size = fs.statSync(f.path).size;
      fs.unlinkSync(f.path);
      results.deleted.push(f.name);
      results.freed += size;
      console.log(`[cleanup] Deleted: ${f.name} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    }

    // Also clean thumb jpg files for deleted videos
    fs.readdirSync(OUTPUT_DIR)
      .filter((f) => f.endsWith('_thumb.jpg'))
      .forEach((f) => {
        const baseName = f.replace('_thumb.jpg', '.mp4');
        if (results.deleted.includes(baseName)) {
          try {
            fs.unlinkSync(path.join(OUTPUT_DIR, f));
          } catch (e) {}
        }
      });
  } catch (e) {
    console.warn('[cleanup] Output cleanup error:', e.message);
  }

  // ── Tmp directory — clean all leftover segments ───────────────
  if (cleanTmp) {
    try {
      let tmpFreed = 0;
      fs.readdirSync(TMP_DIR).forEach((f) => {
        // Keep: cwn_font.ttf, ticker_*.mp4, profile_*.png (profile image cache)
        // Delete: asm_*, gate2_*, gate3_*, learn_*, early_clips/
        if (
          f.startsWith('asm_') ||
          f.startsWith('gate') ||
          f.startsWith('learn_') ||
          f.startsWith('gemini_')
        ) {
          const fp = path.join(TMP_DIR, f);
          try {
            const size = fs.statSync(fp).size;
            fs.unlinkSync(fp);
            tmpFreed += size;
          } catch (e) {}
        }
      });
      // Clean early_clips subfolder
      const earlyDir = path.join(TMP_DIR, 'early_clips');
      if (fs.existsSync(earlyDir)) {
        fs.readdirSync(earlyDir).forEach((f) => {
          try {
            const fp = path.join(earlyDir, f);
            const size = fs.statSync(fp).size;
            fs.unlinkSync(fp);
            tmpFreed += size;
          } catch (e) {}
        });
      }
      results.freed += tmpFreed;
      if (tmpFreed > 0)
        console.log(`[cleanup] Tmp freed: ${(tmpFreed / 1024 / 1024).toFixed(1)}MB`);
    } catch (e) {
      console.warn('[cleanup] Tmp cleanup error:', e.message);
    }
  }

  // ── QA logs — optional ────────────────────────────────────────
  if (cleanQaLogs) {
    const qaDir = path.join(OUTPUT_DIR, 'qa_failures');
    if (fs.existsSync(qaDir)) {
      fs.readdirSync(qaDir).forEach((f) => {
        try {
          fs.unlinkSync(path.join(qaDir, f));
        } catch (e) {}
      });
      console.log('[cleanup] QA logs cleared');
    }
  }

  const freedMB = (results.freed / 1024 / 1024).toFixed(1);
  console.log(
    `[cleanup] ✅ Done — freed ${freedMB}MB, deleted ${results.deleted.length} videos, kept ${results.kept.length}`
  );
  res.json({
    ok: true,
    deleted: results.deleted,
    kept: results.kept,
    freedMB: parseFloat(freedMB),
  });
});

// GET /disk-usage, GET /errors — now in lib/routes/admin.js

// ── POST /nba/generate-intro-card ──────────────────────────────────────────

// ── POST /nba/generate-intro-card ────────────────────────────────────
// Generates a 640×360 NBA intro card PNG using nba_intro_card.html + Puppeteer
// The HTML auto-fetches ESPN API data via ?gameId= URL param
//
// Body: { gameId, outputPath? }
//   gameId     - ESPN game ID (e.g. "401584893")
//   outputPath - optional custom output path (default: output/nba_intro_card_{gameId}.png)
//   toVideo    - optional boolean: also convert PNG → 10s MP4 via FFmpeg
//
// Returns: { ok, cardPath, videoPath?, gameId, dimensions }
router.post('/nba/generate-intro-card', async (req, res) => {
  const { gameId, outputPath, toVideo = false } = req.body || {};

  if (!gameId) {
    return res.status(400).json({ ok: false, error: 'Missing required field: gameId' });
  }

  const cardPath = outputPath
    ? path.resolve(outputPath)
    : path.join(OUTPUT_DIR, `nba_intro_card_${gameId}.png`);

  // Ensure output directory exists
  const cardDir = path.dirname(cardPath);
  if (!fs.existsSync(cardDir)) fs.mkdirSync(cardDir, { recursive: true });

  const templatePath = path.join(ROOT_DIR, 'templates', 'nba_intro_card.html');
  if (!fs.existsSync(templatePath)) {
    return res
      .status(500)
      .json({ ok: false, error: 'Template not found: templates/nba_intro_card.html' });
  }

  let browser;
  try {
    console.log(`[nba-intro-card] Generating card for game ${gameId}...`);

    browser = await puppeteer.launch(
      withPuppeteerExecutable({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
      })
    );

    const page = await browser.newPage();

    // Set viewport to exactly 640×360 (TV aspect ratio)
    await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 2 });

    // Load the template with gameId param — HTML auto-fetches ESPN API
    const fileUrl = `file://${templatePath}?gameId=${gameId}`;
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 20000 });

    // Wait for ESPN API data to render (title changes to 'READY' when done)
    try {
      await page.waitForFunction(() => document.title === 'READY', { timeout: 12000 });
    } catch (e) {
      console.warn(`[nba-intro-card] Timeout waiting for READY — taking screenshot anyway`);
    }

    // Extra buffer for images (logos) to fully load
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Hide the status bar before screenshot
    await page.evaluate(() => {
      const sb = document.getElementById('status-bar');
      if (sb) sb.style.display = 'none';
    });

    // Screenshot the #thumb element at exactly 640×360
    const thumbEl = await page.$('#thumb');
    if (!thumbEl) throw new Error('#thumb element not found in template');

    await thumbEl.screenshot({ path: cardPath, type: 'png' });
    console.log(`[nba-intro-card] ✅ PNG saved: ${cardPath}`);

    await browser.close();
    browser = null;

    const result = {
      ok: true,
      cardPath,
      gameId,
      dimensions: '640x360',
    };

    // ── Optional: Convert PNG → 10s MP4 via FFmpeg ──────────────────
    if (toVideo) {
      const videoPath = cardPath.replace(/\.png$/, '.mp4');
      const ffmpegCmd = `ffmpeg -y -loop 1 -i "${cardPath}" -vf "scale=640:360,format=yuv420p" -t 10 -c:v libx264 -r 30 "${videoPath}" 2>&1`;
      try {
        const { execSync } = require('child_process');
        execSync(ffmpegCmd, { timeout: 30000 });
        result.videoPath = videoPath;
        console.log(`[nba-intro-card] ✅ MP4 saved: ${videoPath}`);
      } catch (ffErr) {
        console.warn(`[nba-intro-card] FFmpeg failed (PNG still saved): ${ffErr.message}`);
        result.videoError = 'FFmpeg conversion failed — PNG is available';
      }
    }

    res.json(result);
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    console.error(`[nba-intro-card] Error:`, err.message);
    res.status(500).json({ ok: false, error: err.message, gameId });
  }
});

module.exports = router;
