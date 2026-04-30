'use strict';
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const { createCanvas, loadImage } = require('canvas');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { CONFIG } = require('./config');
const { logError } = require('./error_logger');
const logger = require('./logger');
const { ffmpegPath, ffprobePath, ffmpegEncodeArgs } = require('./ffmpeg_utils');
const { StageTimer, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./metrics');
const { uploadToDrive } = require('./publish');
// chrome_overlay.js Puppeteer path is retained for legacy overlay mode + directive compatibility.
const { burnSceneChromeFromDirective, generateNewscastOverlay } = require('./chrome_overlay');
const {
  resolveChromeCfg,
  buildAndBurnChrome,
  fingerprintResolvedChromeCfg,
} = require('./chrome_overlay_ffmpeg');
const { loadDirectiveForJob, hasDirectiveForJob } = require('./directives');
const {
  getAssemblyConfig,
  getQAThresholds,
  isShortForm: isShortFormType,
} = require('./configLoader');
const { scrapeArticleVideo } = require('./script_gen');

// Feature flag — directive chrome is legacy/deprecated and must be opt-in only.
// Default OFF so all segments (including source clips) use universal FFmpeg chrome.
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME === 'true';
// Legacy HTML/Puppeteer chrome overlay flag. Applies to ALL customers when true.
// Set LEGACY_OVERLAY_ONLY=false (or C0_LEGACY_OVERLAY_ONLY=false) to use FFmpeg drawtext path.
const C0_LEGACY_OVERLAY_ONLY =
  process.env.LEGACY_OVERLAY_ONLY !== 'false' && process.env.C0_LEGACY_OVERLAY_ONLY !== 'false';

// Local log helper — routes to Pino logger with asmId context
// Matches the log(asmId, msg) call signature used throughout this file
function log(asmId, msg) {
  logger.info({ asmId }, typeof msg === 'string' ? msg.replace(/\n/g, ' ').trim() : msg);
  process.stdout.write(`[assembly:${asmId}] ${msg}\n`);
}

/** Hooks for lib/gate_policy_runner.js — same telemetry as legacy inline runner. */
function assemblyUnifiedPolicyHooks(asmId) {
  return {
    onRetryAttempt: async ({ jobId, gate, phase, attempt, maxAttempts }) => {
      try {
        pipelineBus.emit('pipeline:retry_attempt', {
          jobId,
          gate,
          stage: `${gate}_${phase}`,
          attempt,
          maxAttempts,
        });
      } catch (_e) {
        /* non-fatal */
      }
    },
    onHardStop: async ({ gateKey, policy }) => {
      log(
        asmId,
        `⛔ ${gateKey} unified policy hard stop after worker=${policy.workerAttempts}, sendbacks=${policy.sendbackAttempts}, interventions=${policy.interventionAttempts}`
      );
    },
  };
}
const { downloadFile } = require('./downloader');
const pipelineBus = require('./pipeline_events');
const { QA_TIER_REVIEW, QA_TIER_OPS } = require('./qa_cycle');
const { nrPipelineEvent } = require('./nr_pipeline');
const { readAutoPublishPlatformsEnv } = require('./auto_publish_env');
const { auditAndRecordGateResult, preflightGateExecution } = require('./job_spec_contracts');
const { runUnifiedGatePolicy } = require('./gate_policy_runner');

function publishPlatformsList(contentType) {
  // 1. env override always wins (allows ops to override per-deploy or per-test run)
  const envPlatforms = readAutoPublishPlatformsEnv();
  if (envPlatforms !== null) return envPlatforms;

  // 2. content type config — short-form goes to all social platforms, long-form defaults to youtube
  if (contentType) {
    try {
      const cfg = require('../config/contentTypes.json');
      const typeCfg = cfg.contentTypes?.[contentType];
      if (typeCfg?.publish?.platforms?.length) return typeCfg.publish.platforms;
    } catch (_e) {
      /* non-fatal — fall through */
    }
  }

  // 3. hardcoded fallback
  return ['youtube'];
}

function nrAssembly(eventType, attrs) {
  try {
    nrPipelineEvent(eventType, {
      pipelineStage: 'assembly',
      containerized: fs.existsSync('/.dockerenv'),
      ...attrs,
    });
  } catch (_e) {
    /* non-fatal */
  }
}
const TwitchClient = require('./clients/twitch_client');

// Emit gate result to pipelineBus so monitoring + New Relic receive it
// Sendback: Tier 1 (QA review/report) → gate:sendback + qa_cycle. Tier 2 (ops/worker) → gate:ops_sendback only.
function emitGateResult(jobSpec, result, contentType) {
  try {
    const normalizedGate =
      typeof result?.portal === 'number' ? `portal${result.portal}` : String(result?.portal || '');
    const isSendback = !result.passed && result.outcome === 'sendback';
    const tier =
      result.qaTier === QA_TIER_OPS ? QA_TIER_OPS : isSendback ? QA_TIER_REVIEW : undefined;
    const event = result.passed
      ? 'gate:pass'
      : isSendback
        ? tier === QA_TIER_OPS
          ? 'gate:ops_sendback'
          : 'gate:sendback'
        : 'gate:hard_fail';
    pipelineBus.emit(event, {
      jobId: jobSpec?.jobId || 'unknown',
      customerId: jobSpec?.customerId || 'c0',
      contentType: contentType || jobSpec?.contentType || 'unknown',
      portal: normalizedGate || result.portal,
      qaTier: tier,
      score: result.score ?? null,
      outcome: result.outcome || (result.passed ? 'pass' : 'hard_fail'),
      attempt: result.attempt ?? result.sendbackAttempt ?? undefined,
      concerns: result.concerns || [],
      deductions: result.deductions || [],
      reason:
        result.failReason ||
        (Array.isArray(result.concerns) && result.concerns.length
          ? result.concerns.join('; ')
          : '') ||
        (Array.isArray(result.notes) && result.notes.length ? result.notes.join('; ') : '') ||
        (result.report ? String(result.report).slice(0, 500) : '') ||
        `Hard fail at portal ${result.portal ?? '?'}`,
      fixDirective: result.fixDirective || undefined,
    });
    try {
      if (jobSpec?.jobId && normalizedGate) {
        auditAndRecordGateResult({
          jobId: jobSpec.jobId,
          gate: normalizedGate,
          result: {
            ...result,
            gate: normalizedGate,
          },
          fallbackJobSpec: jobSpec,
        });
      }
    } catch (specAuditErr) {
      console.warn(
        `[gate-contracts] ${normalizedGate || 'unknown'} audit failed (non-fatal): ${specAuditErr.message}`
      );
    }
    // Terminal automation signal: gates 0–5 complete (creative review is still product sign-off)
    if (result.passed && (result.portal === 5 || result.portal === '5' || result.portal === 'portal5')) {
      try {
        pipelineBus.emit('pipeline:complete', {
          jobId: jobSpec?.jobId || 'unknown',
          customerId: jobSpec?.customerId || 'c0',
          completedAt: new Date().toISOString(),
          bar: 'gates_through_5',
        });
        const { updateJobSpec } = require('./job_spec');
        updateJobSpec(jobSpec.jobId, {
          state: {
            automation: {
              ...((jobSpec.state && jobSpec.state.automation) || {}),
              pipelineCompleteGates: true,
              pipelineCompleteAt: new Date().toISOString(),
            },
          },
        });
      } catch (_e) {
        /* non-fatal */
      }
    }
  } catch (e) {}
}

async function persistGateHandoffReview({
  asmId,
  jobSpec,
  fromGate,
  nextGate,
  gateResult,
  fallbackJobSpec,
}) {
  const review = {
    gate: fromGate,
    nextGate,
    reviewedAt: new Date().toISOString(),
    passed: false,
    fromGatePassed: gateResult?.passed === true,
    fromGateOutcome: gateResult?.outcome || null,
    issues: [],
    softHeals: [],
  };
  try {
    const preflight = preflightGateExecution({
      jobId: jobSpec?.jobId,
      gate: nextGate,
      fallbackJobSpec: fallbackJobSpec || jobSpec || null,
    });
    review.passed = !!preflight.ready;
    review.issues = preflight.reasons || [];
    review.softHeals = preflight.softHeals || [];
    if (review.softHeals.length > 0) {
      log(asmId, `🩹 ${fromGate}→${nextGate} handoff soft-heal: ${review.softHeals.join('; ')}`);
    }
    if (!review.passed) {
      log(asmId, `⛔ ${fromGate}→${nextGate} handoff blocked: ${(review.issues || []).join('; ')}`);
    }
  } catch (e) {
    review.passed = false;
    review.issues = [`handoff preflight error: ${e.message}`];
    log(asmId, `⚠️  ${fromGate}→${nextGate} handoff review error: ${e.message}`);
  }
  try {
    const { saveOutput } = require('./job_spec');
    if (jobSpec?.jobId) {
      await saveOutput(jobSpec.jobId, `${fromGate}_handoff_review`, review);
    }
  } catch (e) {
    log(asmId, `⚠️  Failed to persist ${fromGate} handoff review: ${e.message}`);
  }
  return review;
}

const twitchClient = new TwitchClient(); // reads TWITCH_CLIENT_ID + TWITCH_TOKEN from process.env

async function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
}

function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

async function burnLegacyHtmlOverlay({
  inputPath,
  asmId,
  sceneLabel,
  contentType,
  storyData,
  activeIdx = 0,
  episodeNumber = 'Episode 1',
  activeCategory = 'WORLD NEWS',
  suffix = 'legacy',
}) {
  const overlayPng = path.join(TMP_DIR, `${asmId}_${suffix}_${Date.now()}.png`);
  const burnedPath = inputPath.replace('.mp4', `_${suffix}.mp4`);
  const htmlContentType =
    contentType === 'clips' ? 'twitch' : contentType === 'sports' ? 'nba' : contentType;
  await generateNewscastOverlay(storyData, overlayPng, activeIdx, {
    showLowerThird: true,
    hideSidebar: false,
    episodeNumber,
    activeCategory,
    contentType: htmlContentType,
    baselinePreset: '0415',
  });

  await new Promise((res, rej) => {
    const args = [
      '-i',
      inputPath,
      '-i',
      overlayPng,
      '-filter_complex',
      '[0:v][1:v]overlay=0:0[out]',
      '-map',
      '[out]',
      '-map',
      '0:a',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-y',
      burnedPath,
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
    proc.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`Legacy overlay burn failed: ${code}`))
    );
    proc.on('error', rej);
  });
  try {
    if (fs.existsSync(overlayPng)) fs.unlinkSync(overlayPng);
  } catch (_e) {}
  if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
    log(asmId, `  🎨 Legacy overlay burned scene=${sceneLabel} contentType=${htmlContentType}`);
    return burnedPath;
  }
  return inputPath;
}

const TMP_DIR = path.join(__dirname, '..', 'tmp');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const CWN_LOGO_PATH = path.join(__dirname, '..', 'assets', 'cwn_logo.png');

// Segment size floors after download — different contracts for remote CDN vs trusted synth prebuild.
// Remote: keep high to reject HTML error pages and token-expired stubs (~tens of KB).
// Synth prebuild (Gate 3a): lavfi patterns can be <100KB while still valid MP4; ftyp/mdat probe below is authoritative.
const MIN_SEGMENT_BYTES_REMOTE = 100000;
const MIN_SEGMENT_BYTES_SYNTH_PREBUILD = 8192;

const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// In-memory assembly job state — exported so server.js /assembly-status endpoint can read it
const assemblyJobs = {};

// Assembly job persistence file
const ASSEMBLY_JOBS_FILE = path.join(__dirname, '..', 'data', 'assembly_jobs.json');

// Save assembly job to disk
// CRITICAL MUTATIONS ONLY: Status changes, gate scores, output paths, errors
// Intermediate pct updates (75+ mutation points) are skipped — if FFmpeg dies mid-run
// we can't resume anyway, we just need to know it was interrupted and what stage it reached.
//
// Mutation points NOT persisted (documented for future reference):
// - pct updates (5 locations): 40%, 45%, 50%, 92%, 100%
// - tickerPct updates (1 location): ticker overlay progress
// - gate2FailedSegments, topazEnhancedSegments, heygenReRenderAvailable (3 locations)
// - sceneTextMap, fullScript (2 locations): stored at job creation, not mutated
// - thumbFrame, thumbFilename, segmentDurations (3 locations): nice-to-have metadata
// - publishCopy (1 location): Gate 6 metadata
//
// Total skipped: ~15 mutation points (non-critical, can be regenerated or are progress-only)
function saveAssemblyJob(asmId) {
  if (!assemblyJobs[asmId]) return;

  try {
    // Read existing file
    let allJobs = {};
    if (fs.existsSync(ASSEMBLY_JOBS_FILE)) {
      const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
      allJobs = JSON.parse(raw);
    }

    // Update this job (exclude large log field — write only on completion)
    const jobToSave = { ...assemblyJobs[asmId] };
    if (jobToSave.status !== 'done' && jobToSave.status !== 'failed') {
      delete jobToSave.log; // Don't persist 50KB log on every update
    }

    allJobs[asmId] = jobToSave;

    // Prune jobs older than 24h
    const now = Date.now();
    Object.keys(allJobs).forEach((id) => {
      const job = allJobs[id];
      const age = now - (job.startedAt || 0);
      if (age > 24 * 60 * 60 * 1000) {
        delete allJobs[id];
      }
    });

    // Write atomically
    fs.writeFileSync(ASSEMBLY_JOBS_FILE, JSON.stringify(allJobs, null, 2), 'utf8');
  } catch (err) {
    logger.error({ asmId, error: err.message }, '[saveAssemblyJob] Failed to persist assembly job');
  }
}

// Load assembly jobs from disk on startup
function loadAssemblyJobs() {
  if (!fs.existsSync(ASSEMBLY_JOBS_FILE)) return;

  try {
    const raw = fs.readFileSync(ASSEMBLY_JOBS_FILE, 'utf8');
    const loaded = JSON.parse(raw);

    Object.keys(loaded).forEach((asmId) => {
      const job = loaded[asmId];

      // Mark interrupted jobs
      if (job.status === 'running' || job.status === 'assembling') {
        job.status = 'interrupted';
        job.interruptedAt = Date.now();
        logger.warn({ asmId }, '[assembly] Job was interrupted — marked as interrupted');
      }

      assemblyJobs[asmId] = job;
    });

    logger.info({ count: Object.keys(loaded).length }, '[assembly] Loaded assembly jobs from disk');
  } catch (err) {
    logger.error({ error: err.message }, '[assembly] Failed to load assembly jobs');
  }
}

// Call on module load
loadAssemblyJobs();

// Topaz enhancement — real implementation in lib/services/topaz.js
const { enhanceVideoWithTopaz } = require('./services/topaz');

// ─── FUNCTIONS EXTRACTED FROM server.js ───────────────────────────────────
// generateIntroCardPNG      (was ~706)
// generateGameStoryCardPNG  (was ~880)
// detectTrailingSilence     (was ~1026)
// computeNewsClipTrimDuration (was ~1089)
// generateNewsStoryCardPNG  (was ~1128)
// checkDiskSpace            (was ~1278)
// buildConcatCommand        (was ~1304)
// probeDuration             (was ~1381)
// handleAssemble            (handler body from app.post /assemble, was ~1988)
// captureTicker             (was ~4416)

async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions (2× resolution for sharpness — final output 640×360 after FFmpeg scale) ──
  const W = 1280,
    H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Sanitize text strings by replacing escaped apostrophes and quotes
  const name = (streamerData.displayName || streamerData.name || '')
    .toUpperCase()
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
  const origin = (streamerData.origin || '').replace(/\\'/g, "'").replace(/\\"/g, '"');
  const fact = (streamerData.fact || '').replace(/\\'/g, "'").replace(/\\"/g, '"');

  // ── Profile image loading: local file first, fallback to remote URL ──
  const twitchUsername = streamerData.twitchUsername || streamerData.name || '';
  const displayName = streamerData.displayName || '';
  const onAirName = streamerData.onAirName || '';
  let imgUrl = streamerData.profileImageUrl || streamerData.profile_image_url || null;

  // Try multiple filename patterns in order
  const filenamePatterns = [
    { name: twitchUsername, label: 'twitchUsername' },
    { name: displayName ? `profile_${displayName}` : '', label: 'profile_displayName' },
    { name: onAirName ? `profile_${onAirName}` : '', label: 'profile_onAirName' },
    { name: displayName, label: 'displayName' },
    { name: onAirName, label: 'onAirName' },
    {
      name: displayName ? `profile_${displayName.replace(/ /g, '_')}` : '',
      label: 'profile_displayName_underscore',
    },
    {
      name: onAirName ? `profile_${onAirName.replace(/ /g, '_')}` : '',
      label: 'profile_onAirName_underscore',
    },
  ].filter((p) => p.name);

  const extensions = ['.png', '.jpeg', '.jpg', ''];

  console.log(
    `[intro-card] Looking for profile image for: ${name} (twitchUsername: ${twitchUsername}, displayName: ${displayName}, onAirName: ${onAirName})`
  );

  let localImagePath = null;
  for (const pattern of filenamePatterns) {
    for (const ext of extensions) {
      const testPath = require('path').join(
        __dirname,
        '..',
        'assets',
        'streamers',
        `${pattern.name}${ext}`
      );
      const filename = `${pattern.name}${ext}`;
      console.log(
        `[intro-card]   Trying: ${filename} (${pattern.label}${ext}) ... ${require('fs').existsSync(testPath) ? 'FOUND ✓' : 'not found'}`
      );
      if (require('fs').existsSync(testPath)) {
        localImagePath = testPath;
        imgUrl = localImagePath;
        console.log(`[intro-card] ✓ Using local profile image: ${filename}`);
        break;
      }
    }
    if (localImagePath) break;
  }

  if (!localImagePath) {
    console.log(`[intro-card] ✗ No local file found - using remote URL`);
  }

  // ── Dark slate background (CWN brand) ────────────────────────────
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);

  // ── Layout: Image left (600×600), Text right ──────────────────────
  const imgSize = 600;
  const imgX = 60;
  const imgY = (H - imgSize) / 2; // vertically centered

  // ── Profile image (rounded square clip) ──────────────────────────
  if (imgUrl) {
    try {
      const img = await loadImage(imgUrl);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Clip to rounded rectangle
      const r = 20;
      ctx.beginPath();
      ctx.moveTo(imgX + r, imgY);
      ctx.arcTo(imgX + imgSize, imgY, imgX + imgSize, imgY + imgSize, r);
      ctx.arcTo(imgX + imgSize, imgY + imgSize, imgX, imgY + imgSize, r);
      ctx.arcTo(imgX, imgY + imgSize, imgX, imgY, r);
      ctx.arcTo(imgX, imgY, imgX + imgSize, imgY, r);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, imgX, imgY, imgSize, imgSize);
      ctx.restore();
    } catch (e) {
      // Profile image failed — draw dark placeholder square
      ctx.save();
      ctx.fillStyle = '#1a2540';
      ctx.fillRect(imgX, imgY, imgSize, imgSize);
      ctx.restore();
      console.warn(`[intro-card] Profile image failed for ${name}: ${e.message}`);
    }
  } else {
    // No image URL — draw dark placeholder
    ctx.fillStyle = '#1a2540';
    ctx.fillRect(imgX, imgY, imgSize, imgSize);
  }

  // ── Text column: right of image ───────────────────────────────────
  const textX = imgX + imgSize + 80; // 80px gap between image and text
  const maxTextWidth = W - textX - 60; // right margin 60px

  // Drop shadow for all text
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.textAlign = 'left';

  // ── Name (gold, bold, 136pt) ──────────────────────────────────────
  ctx.fillStyle = '#c7af4f';
  ctx.font = 'bold 136px Arial';
  // Shrink name font if it overflows
  let nameFontSize = 136;
  while (nameFontSize >= 60 && ctx.measureText(name).width > maxTextWidth) {
    nameFontSize -= 4;
    ctx.font = `bold ${nameFontSize}px Arial`;
  }
  ctx.fillText(name, textX, 260);

  // ── Origin (white, 88pt) ──────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.font = '88px Arial';
  ctx.fillText(origin, textX, 380);

  // ── Fact (grey italic, word-wrapped) ─────────────────────────────
  ctx.fillStyle = '#aaaaaa';

  // Dynamic font sizing: start at 64pt, reduce until fact fits in 2 lines
  let factFontSize = 64;
  let factLines = [];
  const factMaxLines = 2;

  while (factFontSize >= 36) {
    ctx.font = `italic ${factFontSize}px Arial`;
    factLines = [];
    const words = fact.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxTextWidth) {
        if (line) factLines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) factLines.push(line);
    if (factLines.length <= factMaxLines) break;
    factFontSize -= 4;
  }

  let factY = 490;
  for (const line of factLines) {
    ctx.fillText(line, textX, factY);
    factY += factFontSize + 10;
  }

  ctx.shadowColor = 'transparent';

  // ── Gold border (10px at 2× = 5px final) ─────────────────────────
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // ── Save PNG ──────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[intro-card] ✅ TV card written: ${require('path').basename(outputPath)} (${name})`);
}

async function generateGameStoryCardPNG(cardData, outputPath, contentType) {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions: 1040×586 = exact 2× pixel-doubled OVERLAY_ZONE (520×293, 16:9 landscape) ──
  // Matches News card dimensions. FFmpeg downscales cleanly to 520×293 with no distortion.
  // Previously 720×840 (portrait 6:7) which caused horizontal stretch + vertical squish.
  const W = 1040,
    H = 586;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Color schemes ────────────────────────────────────────────────────
  const schemes = {
    nba: {
      border: '#17408B', // NBA Blue
      accent: '#C9082A', // NBA Red
      bg: '#1a2540', // Dark background
      text1: '#ffffff', // Title text
      text2: '#c7af4f', // CWN Gold for secondary
    },
    news: {
      border: '#22304b', // CWN Navy
      accent: '#c7af4f', // CWN Gold
      bg: '#1a2540', // Dark background
      text1: '#ffffff', // Title text
      text2: '#c7af4f', // CWN Gold for secondary
    },
  };

  const scheme = schemes[contentType] || schemes.news;

  // ── Extract data ─────────────────────────────────────────────────────
  const title = cardData.title || cardData.gameTitle || 'GAME';
  const subtitle = cardData.subtitle || cardData.score || '';
  const imageUrl = cardData.imageUrl || cardData.thumbnailUrl || null;

  // ── Proportional layout constants (all relative to W/H) ─────────────
  const pad = Math.round(W * 0.024); // ~25px — outer padding
  const IMG_W = Math.round(W * 0.42); // ~437px — image width (left half)
  const IMG_H = Math.round(H * 0.78); // ~457px — image height
  const IMG_X = Math.round(W * 0.03); // ~31px — image left margin
  const IMG_Y = Math.round((H - IMG_H) / 2); // vertically centered
  const TEXT_X = IMG_X + IMG_W + Math.round(W * 0.04); // text column start
  const TEXT_W = W - TEXT_X - Math.round(W * 0.03); // text column width

  // ── Clear canvas ─────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Background ───────────────────────────────────────────────────────
  ctx.fillStyle = scheme.bg;
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, Math.round(W * 0.025));
  ctx.fill();

  // ── Gold border ──────────────────────────────────────────────────────
  ctx.strokeStyle = scheme.accent;
  ctx.lineWidth = Math.round(W * 0.005);
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, Math.round(W * 0.025));
  ctx.stroke();

  // ── Left-half image ──────────────────────────────────────────────────
  if (imageUrl) {
    try {
      const img = await loadImage(imageUrl);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, IMG_X, IMG_Y, IMG_W, IMG_H);
      // Accent border around image
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = Math.round(W * 0.006);
      ctx.strokeRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      ctx.restore();
    } catch (e) {
      // Image failed — draw placeholder
      ctx.fillStyle = '#2a3550';
      ctx.fillRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = Math.round(W * 0.006);
      ctx.strokeRect(IMG_X, IMG_Y, IMG_W, IMG_H);
      console.warn(`[game-story-card] Image failed for ${title}: ${e.message}`);
    }
  }

  // ── Drop shadow behind text ─────────────────────────────────────────
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;

  // ── Title text (right column, word-wrapped) ─────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = scheme.text1;
  const titleFontSize = Math.round(H * 0.1); // ~59px
  ctx.font = `bold ${titleFontSize}px Arial`;

  // Word wrap title
  let titleLines = [];
  const titleWords = title.split(' ');
  let currentLine = '';
  for (const word of titleWords) {
    const test = currentLine ? currentLine + ' ' + word : word;
    if (ctx.measureText(test).width > TEXT_W && currentLine) {
      titleLines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) titleLines.push(currentLine);

  // Draw title lines (max 3 lines)
  const lineH = Math.round(titleFontSize * 1.2);
  let textY = Math.round(H * 0.28);
  for (const line of titleLines.slice(0, 3)) {
    ctx.fillText(line, TEXT_X, textY);
    textY += lineH;
  }

  // ── Subtitle text (score/details) ───────────────────────────────────
  if (subtitle) {
    ctx.fillStyle = scheme.text2;
    const subtitleFontSize = Math.round(H * 0.075); // ~44px
    ctx.font = `normal ${subtitleFontSize}px Arial`;
    textY += Math.round(H * 0.04);
    ctx.fillText(subtitle, TEXT_X, textY);
  }

  ctx.shadowColor = 'transparent';

  // ── Save PNG ────────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(
    `[game-story-card] ✅ ${contentType.toUpperCase()} card written: ${require('path').basename(outputPath)} (${title})`
  );
}

async function detectTrailingSilence(clipPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i',
      clipPath,
      '-af',
      'silencedetect=noise=-30dB:duration=1.0',
      '-f',
      'null',
      '-',
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
    let stderr = '';
    proc.stderr &&
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        // ffmpeg returns 1 on null muxer, that's fine
        return reject(new Error(`silencedetect exit ${code}`));
      }
      // Parse silencedetect output. Format:
      //   [silencedetect @ 0x...] silence_start: 23.456
      //   [silencedetect @ 0x...] silence_end: 28.123 | silence_duration: 4.667
      const silenceStarts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) =>
        parseFloat(m[1])
      );
      const silenceEnds = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) =>
        parseFloat(m[1])
      );
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      let totalDuration = 0;
      if (durationMatch) {
        totalDuration =
          parseInt(durationMatch[1]) * 3600 +
          parseInt(durationMatch[2]) * 60 +
          parseFloat(durationMatch[3]);
      }
      // A "trailing silence" is a silence_start with NO corresponding silence_end
      // (or a silence_end that extends to the clip's total duration).
      // If the last silence_start > last silence_end, that's trailing silence.
      let trailingSilenceStart = null;
      if (silenceStarts.length > 0) {
        const lastStart = silenceStarts[silenceStarts.length - 1];
        const lastEnd = silenceEnds.length > 0 ? silenceEnds[silenceEnds.length - 1] : -1;
        if (lastStart > lastEnd) {
          trailingSilenceStart = lastStart;
        }
      }
      resolve({ totalDuration, silenceStart: trailingSilenceStart });
    });
    proc.on('error', reject);
  });
}

async function computeNewsClipTrimDuration(clipPath) {
  const { totalDuration, silenceStart } = await detectTrailingSilence(clipPath);

  if (!totalDuration || totalDuration <= 0) {
    throw new Error(`Invalid clip duration: ${totalDuration}`);
  }

  let trimTo;
  if (silenceStart !== null && silenceStart > 0 && silenceStart < totalDuration) {
    // Detected trailing silence — trim to silence start
    trimTo = silenceStart;
    console.log(
      `[news-clip-trim] ${path.basename(clipPath)}: silence detected at ${silenceStart.toFixed(2)}s of ${totalDuration.toFixed(2)}s → trim`
    );
  } else {
    // No trailing silence — fallback: trim last 5 seconds
    trimTo = Math.max(totalDuration - 5.0, 5.0);
    console.log(
      `[news-clip-trim] ${path.basename(clipPath)}: no silence detected → fallback trim last 5s (${totalDuration.toFixed(2)}s → ${trimTo.toFixed(2)}s)`
    );
  }

  // Sanity: never trim more than 30% of total duration
  const minKeep = totalDuration * 0.7;
  if (trimTo < minKeep) {
    console.warn(
      `[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 70% floor ${minKeep.toFixed(2)}s — using 70% floor`
    );
    trimTo = minKeep;
  }

  // Sanity: floor at 5s
  if (trimTo < 5.0) {
    console.warn(
      `[news-clip-trim] ${path.basename(clipPath)}: computed trim ${trimTo.toFixed(2)}s < 5s floor — keeping full clip`
    );
    trimTo = totalDuration;
  }

  return trimTo;
}

async function generateNewsStoryCardPNG(storyData, outputPath) {
  const { createCanvas, loadImage } = require('canvas');
  const W = 1040,
    H = 586;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const title = (storyData.title || 'Breaking News').replace(/\s+/g, ' ').trim();
  const source = (storyData.source || 'AL JAZEERA').toUpperCase();
  const heroUrl = storyData.heroImageUrl || '';
  // Navy fallback background
  ctx.fillStyle = '#0d1424';
  ctx.fillRect(0, 0, W, H);
  // Load and draw hero image (scale-to-cover)
  if (heroUrl) {
    try {
      const heroImg = await loadImage(heroUrl);
      const iw = heroImg.width,
        ih = heroImg.height;
      const scale = Math.max(W / iw, H / ih);
      const sw = iw * scale,
        sh = ih * scale;
      const sx = (W - sw) / 2,
        sy = (H - sh) / 2;
      ctx.drawImage(heroImg, sx, sy, sw, sh);
    } catch (e) {
      console.warn(`[news-card] ⚠️  Failed to load hero image: ${e.message}`);
    }
  }
  // Semi-transparent gradient at bottom
  const gradY = H * 0.45;
  const grad = ctx.createLinearGradient(0, gradY, 0, H);
  grad.addColorStop(0, 'rgba(13, 20, 36, 0)');
  grad.addColorStop(0.3, 'rgba(13, 20, 36, 0.7)');
  grad.addColorStop(1, 'rgba(13, 20, 36, 0.95)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, gradY, W, H - gradY);
  // Source tag (top-left, gold)
  ctx.fillStyle = '#c7af4f';
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.fillText(source, 40, 60);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  // Headline text (word-wrapped)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px Arial';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  // Inline word-wrap
  const maxW = W - 80;
  const words = title.split(' ');
  let line = '',
    lineY = gradY + 80;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, 40, lineY);
      line = w;
      lineY += 68;
      if (lineY > H - 20) break;
    } else {
      line = test;
    }
  }
  if (line && lineY <= H - 20) ctx.fillText(line, 40, lineY);
  ctx.shadowColor = 'transparent';
  // Gold border
  ctx.strokeStyle = '#c7af4f';
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  // Save PNG
  const buf = canvas.toBuffer('image/png');
  await require('util').promisify(require('fs').writeFile)(outputPath, buf);
  console.log(
    `[news-card] ✅ TV card written: ${require('path').basename(outputPath)} (${title.slice(0, 40)})`
  );
}

async function checkDiskSpace(requiredMB) {
  return new Promise((resolve, reject) => {
    // Use df command to check free space on output directory
    exec(`df -k "${OUTPUT_DIR}" | awk 'NR==2 {print $4}'`, (err, stdout) => {
      if (err) {
        console.warn(`[disk-check] Could not check disk space: ${err.message}`);
        return resolve(); // Non-fatal, continue anyway
      }
      const freeKB = parseInt(stdout.trim());
      const freeMB = Math.floor(freeKB / 1024);
      const freeGB = (freeMB / 1024).toFixed(1);

      console.log(`[disk-check] Available: ${freeGB}GB, Required: ${requiredMB}MB`);

      if (freeMB < requiredMB) {
        return reject(
          new Error(
            `Insufficient disk space: ${freeGB}GB available, need ${(requiredMB / 1024).toFixed(1)}GB. ` +
              `Run cleanup to free space.`
          )
        );
      }
      resolve();
    });
  });
}

function buildConcatCommand(inputFiles, outputPath, transition, format) {
  const n = inputFiles.length;

  // For large jobs (>30 files) OR cut transition: use concat demuxer
  // The xfade filter_complex approach opens all files simultaneously and hits
  // macOS's default file descriptor limit (256) on jobs with 50+ segments
  if (transition === 'cut' || n === 1 || n > 30) {
    const listPath = outputPath.replace(/\.[^.]+$/, '_list.txt');
    const listContent = inputFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    // For cut/large: use copy (no re-encode, fastest)
    // For crossfade on large jobs: concat then we lose transitions, but it's reliable
    if (transition !== 'cut' && n > 30) {
      console.log(
        `[ffmpeg] ${n} segments — using concat demuxer (xfade needs too many file handles for macOS)`
      );
    }

    return {
      args: [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        // Must re-encode (not copy) because HeyGen avatar files and source clips
        // have different codecs/framerates — copy produces corrupt 4MB output
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        outputPath,
      ],
      cleanup: [listPath],
    };
  }

  // Crossfade / fade / dissolve using xfade filter
  const transitionName =
    transition === 'crossfade' ? 'fade' : transition === 'dissolve' ? 'dissolve' : 'fade';
  const transitionDur = transition === 'dissolve' ? 0.7 : transition === 'crossfade' ? 0.3 : 0.5;

  // Build input args
  const inputArgs = [];
  inputFiles.forEach((f) => inputArgs.push('-i', f));

  // We need to know the duration of each clip to calculate offsets
  // For simplicity: use a filtergraph that assumes clips are renderable
  // Build xfade chain: [0][1]xfade=...[x01]; [x01][2]xfade=...[x012]; etc.
  let filterParts = [];
  let prevLabel = '[0:v]';
  let prevALabel = '[0:a]';

  // Estimate offset per segment (we'll use a conservative 60s — server will use real probe data)
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? '[vout]' : `[v${i}]`;
    const outALabel = i === n - 1 ? '[aout]' : `[a${i}]`;
    // Video xfade
    filterParts.push(
      `${prevLabel}[${i}:v]xfade=transition=${transitionName}:duration=${transitionDur}:offset=OFFSET_${i}${outLabel}`
    );
    // Audio crossfade
    filterParts.push(`${prevALabel}[${i}:a]acrossfade=d=${transitionDur}${outALabel}`);
    prevLabel = outLabel;
    prevALabel = outALabel;
  }

  return {
    args: inputArgs.concat([
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-c:v',
      format === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-y',
      outputPath,
    ]),
    needsProbe: true,
    cleanup: [],
  };
}

function probeDuration(filePath) {
  return new Promise((res) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      (err, stdout) => {
        res(err ? 60 : parseFloat(stdout.trim()) || 60);
      }
    );
  });
}

// ── Segment Grouping ──────────────────────────────────────────────────────────
// Splits a flat segmentData[] array into logical groups that each assemble
// independently before a lightweight final stitch.
//
// Strategy A — universal prefix detection (ANY repeated WORD# pattern):
//   INTRO, GAME1_INTRO, GAME1_CLIP, GAME2_INTRO, GAME2_CLIP, OUTRO
//   INTRO, STORY1_SETUP, STORY1_CLIP, STORY2_SETUP, STORY2_CLIP, OUTRO
//   INTRO, STREAM1_SETUP, STREAM1_CLIP, STREAM2_SETUP, OUTRO
//   INTRO, ITEM1_SETUP, ITEM1_CLIP, ITEM2_SETUP, ITEM2_CLIP, OUTRO  ← C1+
//   → [[INTRO], [ITEM1_*], [ITEM2_*], [OUTRO]]
//   Detects the dominant WORD# prefix from labels dynamically — not content-type-specific.
//
// Strategy B — time-interval fallback (no recognised label structure):
//   Group by segment count; defaults to segments_per_group = 4.
//   Used for C1+ "use my content" / "link content" flows with no scaffold.
//
// Returns: Array<{ groupId:string, indices:number[], itemIdx:number }>
//   itemIdx = which item this group belongs to (0-indexed, for chrome activeIdx)
function groupSegmentsByLabel(segsToProcess) {
  const labels = segsToProcess.map((s) =>
    String(s.label || '')
      .trim()
      .toUpperCase()
  );

  // Standalone labels that always form their own single-segment group.
  const STANDALONE = /^(INTRO|COLD[\s_]OPEN|OUTRO|NBA[\s_]OUTRO)$/i;

  // Universal prefix detector: any label starting with LETTERS followed by a digit.
  // e.g. GAME1, STORY2, STREAM3, ITEM4 — content-type agnostic.
  const ANY_PREFIX_RE = /^([A-Z][A-Z0-9_]*?)(\d+)(?:_|$)/;

  // Collect all distinct WORD# tokens found in non-standalone labels.
  const prefixTokens = new Set();
  for (const l of labels) {
    if (STANDALONE.test(l)) continue;
    const m = l.match(ANY_PREFIX_RE);
    if (m) prefixTokens.add(m[1] + m[2]); // e.g. "GAME1", "STORY2", "ITEM3"
  }

  if (prefixTokens.size === 0) {
    // Strategy B: no structured prefix found — chunk by count (4 per group)
    const groups = [];
    const CHUNK = 4;
    for (let i = 0; i < segsToProcess.length; i += CHUNK) {
      const chunk = segsToProcess.slice(i, i + CHUNK);
      groups.push({
        groupId: `chunk_${Math.floor(i / CHUNK)}`,
        indices: chunk.map((_, k) => i + k),
        itemIdx: Math.floor(i / CHUNK),
      });
    }
    return groups;
  }

  // Strategy A: group by detected prefix
  const groups = [];
  let current = null;
  let itemCounter = 0;

  const flush = () => {
    if (current && current.indices.length > 0) {
      groups.push(current);
      current = null;
    }
  };

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];

    // INTRO / OUTRO / COLD_OPEN → always a standalone group
    if (STANDALONE.test(label)) {
      flush();
      groups.push({
        groupId: label.toLowerCase().replace(/[\s_]+/g, '_'),
        indices: [i],
        itemIdx: -1,
      });
      continue;
    }

    const prefixMatch = label.match(ANY_PREFIX_RE);
    if (!prefixMatch) {
      // No prefix — attach to current group or open a new overflow group
      if (!current) current = { groupId: `seg_${i}`, indices: [], itemIdx: itemCounter };
      current.indices.push(i);
      continue;
    }

    const thisPrefix = prefixMatch[1] + prefixMatch[2]; // e.g. "GAME1", "ITEM3"
    const thisNum = parseInt(prefixMatch[2], 10);

    if (!current || current.groupId !== thisPrefix) {
      flush();
      itemCounter = thisNum - 1; // 0-indexed
      current = { groupId: thisPrefix, indices: [], itemIdx: itemCounter };
    }
    current.indices.push(i);
  }
  flush();

  return groups;
}

function buildAtempoChain(tempo) {
  let t = Number(tempo);
  if (!Number.isFinite(t) || t <= 0) t = 1;
  const atoms = [];
  while (t < 0.5) {
    atoms.push('atempo=0.5');
    t /= 0.5;
  }
  while (t > 2.0) {
    atoms.push('atempo=2.0');
    t /= 2.0;
  }
  atoms.push(`atempo=${t.toFixed(5)}`);
  return atoms.join(',');
}

function normalizeClipTimingTargets(targets, clipDurationSec) {
  const rows = Array.isArray(targets) ? targets : [];
  if (!rows.length || !Number.isFinite(clipDurationSec) || clipDurationSec <= 0) return [];
  const out = [];
  let prevEnd = 0;
  for (const row of rows) {
    const rawStart = Number(row?.startSec);
    const rawEnd = row?.endSec == null ? clipDurationSec : Number(row.endSec);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const startSec = Math.max(0, Math.min(clipDurationSec, Math.max(prevEnd, rawStart)));
    const endSec = Math.max(startSec + 0.05, Math.min(clipDurationSec, rawEnd));
    if (endSec <= startSec) continue;
    out.push({
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      targetDurationSec: Number((endSec - startSec).toFixed(3)),
    });
    prevEnd = endSec;
  }
  return out;
}

async function buildTimedNarrationTrack({ asmId, avatarTs, timingTargets, clipDuration, outPath }) {
  const normalized = normalizeClipTimingTargets(timingTargets, clipDuration);
  if (normalized.length < 2) return null; // One range gives no pacing advantage.

  const avatarDuration = await probeDuration(avatarTs);
  if (!Number.isFinite(avatarDuration) || avatarDuration <= 0.2) return null;

  const chunkDuration = avatarDuration / normalized.length;
  // Gemini (or legacy) windows can imply extreme atempo → audible "slow motion" / chipmunk VO.
  // Prefer untreated avatar audio when any implied stretch is outside a narrow band.
  const TEMPO_LO = 0.85;
  const TEMPO_HI = 1.2;
  for (let i = 0; i < normalized.length; i++) {
    const row = normalized[i];
    const srcStart = i * chunkDuration;
    const srcEnd = Math.min(avatarDuration, (i + 1) * chunkDuration);
    const srcDur = Math.max(0.05, srcEnd - srcStart);
    const targetDur = Math.max(0.05, row.targetDurationSec);
    const tempo = srcDur / targetDur;
    if (!Number.isFinite(tempo) || tempo < TEMPO_LO || tempo > TEMPO_HI) {
      log(
        asmId,
        `  ⏱️  Timed narration skipped — window ${i} implied tempo ${Number(tempo).toFixed(3)} (safe ${TEMPO_LO}–${TEMPO_HI})`
      );
      return null;
    }
  }

  const parts = [];
  const labels = [];

  for (let i = 0; i < normalized.length; i++) {
    const row = normalized[i];
    const srcStart = i * chunkDuration;
    const srcEnd = Math.min(avatarDuration, (i + 1) * chunkDuration);
    const srcDur = Math.max(0.05, srcEnd - srcStart);
    const targetDur = Math.max(0.05, row.targetDurationSec);
    const tempo = srcDur / targetDur;
    const delayMs = Math.max(0, Math.round(row.startSec * 1000));
    const lbl = `n${i}`;
    const chain = buildAtempoChain(tempo);

    parts.push(
      `[0:a]atrim=start=${srcStart.toFixed(3)}:end=${srcEnd.toFixed(3)},` +
        `asetpts=PTS-STARTPTS,${chain},atrim=duration=${targetDur.toFixed(3)},` +
        `adelay=${delayMs}|${delayMs}[${lbl}]`
    );
    labels.push(`[${lbl}]`);
  }

  parts.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0[mix]`
  );
  parts.push(`[mix]atrim=duration=${clipDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`);
  const filterComplex = parts.join(';');

  await new Promise((resolve, reject) => {
    const args = [
      '-i',
      avatarTs,
      '-filter_complex',
      filterComplex,
      '-map',
      '[aout]',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-y',
      outPath,
    ];
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`timed narration render failed: ${code}`))
    );
    proc.on('error', reject);
  });

  log(asmId, `  ⏱️  Timed narration enforced (${normalized.length} windows)`);
  return outPath;
}

async function captureTicker(contentType) {
  // Check cache with TTL
  if (TICKER_CACHE[contentType]) {
    const cached = TICKER_CACHE[contentType];
    const age = Date.now() - cached.cachedAt;
    if (age < TICKER_CACHE_TTL && fs.existsSync(cached.path)) {
      console.log(
        `[ticker] Using cached ${contentType} ticker (age: ${Math.round(age / 1000 / 60)}m)`
      );
      return cached.path;
    } else {
      console.log(
        `[ticker] Cache expired for ${contentType} (age: ${Math.round(age / 1000 / 60)}m), regenerating...`
      );
      delete TICKER_CACHE[contentType];
    }
  }
  const tickerFile = TICKER_MAP[contentType];
  if (!tickerFile) return null;

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch (e) {
    console.warn('[ticker] puppeteer not installed — run: npm install puppeteer');
    console.warn('[ticker] Skipping ticker baking for this assembly.');
    return null;
  }

  const tickerUrl = `http://localhost:${TICKER_DASH_PORT}/${tickerFile}`;
  const outPath = path.join(TMP_DIR, `ticker_${contentType}.mp4`);
  const DURATION = 60; // capture 60 seconds of ticker animation
  const WIDTH = 1920;
  const HEIGHT = CONFIG.TICKER.HEIGHT; // sync with config (72) — was hardcoded 64

  console.log(`[ticker] Capturing ${contentType} ticker (${DURATION}s) from ${tickerUrl}...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [`--window-size=${WIDTH},${HEIGHT}`, '--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(tickerUrl, { waitUntil: 'networkidle0', timeout: 15000 });
    // Wait for ESPN data fetch to complete — ticker fetches scores async after page load
    // networkidle0 catches the page load but not the subsequent XHR scoreboard fetch
    await new Promise((r) => setTimeout(r, 3000));

    // Capture at 15fps for smooth scrolling animation
    // 60 seconds × 15fps = 900 frames — longer loop = less visible seam
    const FPS = 15;
    const CAP_SECS = 60;
    const frameDir = path.join(TMP_DIR, `ticker_frames_${contentType}`);
    if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

    const totalFrames = FPS * CAP_SECS;
    const frameMs = Math.round(1000 / FPS); // ~67ms between frames
    console.log(`[ticker] Capturing ${totalFrames} frames at ${FPS}fps (${CAP_SECS}s)...`);

    for (let i = 0; i < totalFrames; i++) {
      await page.screenshot({
        path: path.join(frameDir, `frame_${String(i).padStart(5, '0')}.png`),
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      await new Promise((r) => setTimeout(r, frameMs));
      if (i % 30 === 0) console.log(`[ticker]   ${i}/${totalFrames} frames captured`);
    }
    await browser.close();
    browser = null;

    // Stitch frames into looping MP4 at native fps
    await new Promise((res, rej) => {
      const args = [
        '-framerate',
        String(FPS),
        '-i',
        path.join(frameDir, 'frame_%05d.png'),
        '-c:v',
        'libx264',
        '-r',
        String(FPS),
        '-pix_fmt',
        'yuv420p',
        '-vf',
        `scale=${WIDTH}:${HEIGHT}`,
        '-y',
        outPath,
      ];
      const ff = require('child_process').execFile(ffmpegPath(), args, {
        maxBuffer: 50 * 1024 * 1024,
      });
      ff.on('close', (code) =>
        code === 0 ? res() : rej(new Error(`FFmpeg ticker encode failed: ${code}`))
      );
      ff.on('error', rej);
    });

    // Clean up frames
    fs.readdirSync(frameDir).forEach((f) => {
      try {
        fs.unlinkSync(path.join(frameDir, f));
      } catch (e) {}
    });
    try {
      fs.rmdirSync(frameDir);
    } catch (e) {}

    TICKER_CACHE[contentType] = { path: outPath, cachedAt: Date.now() };
    console.log(
      `[ticker] ✓ ${contentType} ticker cached: ${outPath} (valid for ${TICKER_CACHE_TTL / 1000 / 60}m)`
    );
    return outPath;
  } catch (err) {
    if (browser)
      try {
        await browser.close();
      } catch (e) {}
    console.warn(`[ticker] Capture failed: ${err.message} — assembling without ticker`);
    return null;
  }
}

const STREAMER_DISPLAY_NAMES = {
  jasontheween: 'Jason',
  hasanabi: 'Hasan',
  adapt: 'Adapt',
  stableronaldo: 'Ron',
  lacy: 'Lacy',
  marlon: 'Marlon',
  cinna: 'Cinna',
  yonnajay: 'Yonna',
  jaycinco: 'Jay Cinco',
  maya: 'Maya',
  extraemily: 'ExtraEmily',
  yourragegaming: 'Rage',
};

/**
 * Get pinned comment for a content type from customerConfig.
 * Reads delivery.pinnedComments[baseType] — falls back to null for unknown customers.
 * C0 values are stored in c0.json delivery.pinnedComments.
 */
function getPinnedComment(contentType, customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const baseType = (contentType || 'news')
      .replace(/-short$/, '')
      .replace(/^nba$/, 'sports')
      .replace(/^twitch$/, 'clips');
    const cfg = loadCustomerConfig(customerId);
    const comment =
      cfg?.delivery?.pinnedComments?.[baseType] || cfg?.delivery?.pinnedComments?.[contentType];
    if (comment) return comment;
  } catch (e) {
    /* non-fatal */
  }
  return null;
}

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

/**
 * Get ticker file map for a customer from customerConfig.
 * Returns an object keyed by base content type (sports/news/clips) → file path.
 * Falls back to empty object for unknown customers.
 * C0 values stored in c0.json delivery.tickerFiles.
 */
function getTickerMap(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const cfg = loadCustomerConfig(customerId);
    if (cfg?.delivery?.tickerFiles) return cfg.delivery.tickerFiles;
  } catch (e) {
    /* non-fatal */
  }
  return {};
}

// Legacy constant kept for backward-compat export (server.js imports TICKER_MAP).
// Runtime code should prefer getTickerMap(customerId) for multi-tenant correctness.
const TICKER_MAP = {
  nba: 'tools/sports_ticker.html',
  sports: 'tools/sports_ticker.html',
  news: 'tools/cwn_combined_ticker.html',
  twitch: 'tools/cwn_twitch_ticker.html',
  clips: 'tools/cwn_twitch_ticker.html',
};
const TICKER_CACHE = {}; // { nba: { path: '...', cachedAt: timestamp }, ... }
const TICKER_CACHE_TTL = 3600000; // 1 hour cache validity
const TICKER_DASH_PORT = process.env.DASHBOARD_PORT || '8765';

// handleAssemble — accepts saveJobCard callback from server.js (job persistence)
async function handleAssemble(req, res, saveJobCard) {
  const {
    segments,
    segmentData,
    labels,
    transition = 'crossfade',
    format = 'mp4',
    outputDir,
    jobTitle,
    assemblyId,
    contentType,
    jobId: assemblyJobId,
    jobSpecId: reqJobSpecId,
    sceneTextMap,
    fullScript,
    expectedClips: contractExpectedClips = 0,
    designSpec: reqDesignSpec = null,
    nbaItems: reqNbaItems = [],
    isSynthPrebuild = false,
    expectedSynth: bodyExpectedSynth = false,
    customerId: reqCustomerId = 'c0',
  } = req.body;
  /** Lab/synthetic assemblies: skip broadcast-style Gemini QA in Gate 3a/3b/4; withhold auto-publish (Gate 4 uploadSignal). */
  const expectedSynthFlag = !!(isSynthPrebuild || bodyExpectedSynth);

  /** When DB job spec is missing, mirror gate5.js: deliverySpec.order.publish.categoryId */
  const categoryIdFromDesign =
    reqDesignSpec?.deliverySpec?.categoryId || reqDesignSpec?.order?.publish?.categoryId || '24';

  // Support both old format (segments=[urls]) and new format (segmentData=[{url,label,type}])
  let segsToProcess =
    segmentData && segmentData.length
      ? segmentData
      : (segments || []).map((url, i) => ({
          url,
          label: labels && labels[i] ? labels[i] : `seg_${i}`,
          type: 'avatar',
        }));

  // Dashboard /assemble uses HeyGen URLs from the card; still honor tmp/manual_segments/<jobId>/
  // drops (same as heygen:all_complete) so edited MP4s are picked up without re-emitting the bus event.
  if (assemblyJobId) {
    try {
      const { applyManualOverrides } = require('./manual_segment_workflow');
      const applied = applyManualOverrides(assemblyJobId, segsToProcess);
      if (applied.overrideCount > 0) {
        segsToProcess.splice(0, segsToProcess.length, ...applied.segmentData);
        console.log(
          `[assemble] manual_segments: ${applied.overrideCount} local file(s) from ${applied.dir}`
        );
      }
    } catch (e) {
      console.warn(`[assemble] manual_segments override skipped: ${e.message}`);
    }
  }

  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  // ── Assembly dedup lock ────────────────────────────────────────────────────
  // Prevents auto-advance race condition: if 3 /assemble calls fire for the
  // same jobId within seconds (confirmed smoke test 11, 2026-04-14), each
  // gets a unique asm_timestamp asmId — no existing guard caught duplicates.
  // Fix: check assemblyJobId (stable script job ID) against active assemblies.
  if (assemblyJobId) {
    const alreadyRunning = Object.values(assemblyJobs).some(
      (job) => job.sourceJobId === assemblyJobId && job.status === 'running'
    );
    if (alreadyRunning) {
      console.warn(
        `[assemble] Duplicate /assemble rejected for jobId=${assemblyJobId} — assembly already running`
      );
      return res
        .status(409)
        .json({ error: 'Assembly already in progress for this job', jobId: assemblyJobId });
    }
  }

  const asmId = assemblyId || 'asm_' + Date.now();
  assemblyJobs[asmId] = {
    pct: 0,
    log: '',
    status: 'running',
    outputPath: null,
    isSynthPrebuild: !!isSynthPrebuild,
    expectedSynth: expectedSynthFlag,
    // Store script metadata for Gate 2 HeyGen re-rendering
    sceneTextMap: sceneTextMap || null,
    fullScript: fullScript || null,
  };

  try {
    const { persistExpectedSynthFlag } = require('./job_spec');
    persistExpectedSynthFlag(assemblyJobId || reqJobSpecId, expectedSynthFlag);
  } catch (_e) {
    /* non-fatal */
  }

  // Persist new assembly job to DB (non-fatal)
  try {
    const { saveAssemblyJob: saveAsmJobDb } = require('./db');
    saveAsmJobDb(asmId, assemblyJobId || asmId, {
      contentType,
      format,
      status: 'assembling',
      startedAt: Date.now(),
    });
  } catch (e) {}

  // Run async — respond immediately
  res.json({ ok: true, assemblyId: asmId, message: 'Assembly started' });

  const run = async () => {
    try {
      // Initialize metrics tracking for this job
      initJobMetrics(asmId);

      const avatarCount = segsToProcess.filter((s) => s.type !== 'source_clip').length;
      const clipCount = segsToProcess.filter((s) => s.type === 'source_clip').length;
      log(
        asmId,
        `Starting assembly: ${avatarCount} avatar + ${clipCount} source clips = ${segsToProcess.length} total`
      );
      log(asmId, `Transition: ${transition} | Format: ${format}`);

      // Check disk space before assembly (estimate ~20MB per segment + 500MB overhead)
      const estimatedSizeMB = segsToProcess.length * 20 + 500;
      try {
        await checkDiskSpace(estimatedSizeMB);
      } catch (diskErr) {
        log(asmId, `❌ ${diskErr.message}`);
        logError('ASSEMBLY_DISK_FAIL', diskErr.message, { asmId, jobId: assemblyJobId });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = diskErr.message;
        saveAssemblyJob(asmId);
        nrAssembly('AssemblyFailed', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          reason: 'disk_precheck',
          error: (diskErr.message || '').slice(0, 500),
        });
        return;
      }

      nrAssembly('AssemblyRunStart', {
        assemblyId: asmId,
        sourceJobId: assemblyJobId || null,
        jobSpecId: reqJobSpecId || null,
        contentType: contentType || null,
        format: format || null,
        segmentCount: segsToProcess.length,
        avatarCount: segsToProcess.filter((s) => s.type !== 'source_clip').length,
        clipCount: segsToProcess.filter((s) => s.type === 'source_clip').length,
      });

      // Carry in-process Gate 2 result forward so Gate 3 preflight does not race
      // DB persistence and incorrectly think gate2 is missing.
      let gate2ResultForGate3 = null;
      let gate2To3aReady = true;
      let gate3To4Ready = false;

      // ── Gate 2: Render quality check (gate worker system) ────────────────────────
      // Runs at assembly start on avatar segments only (source_clips skipped).
      // Uses ffprobe as ground truth — no AI, no retry loop.
      //
      // BYPASS for c0 manual checkpoint workflow: the operator has already reviewed
      // every HeyGen avatar before placing it in tmp/manual_segments/. Running
      // ffprobe-based render QA on segments the operator just reviewed adds no signal
      // and blocks Gate 3a when avatarSegsForQA is empty (local file paths, not URLs).
      // Future customers (Upload My Content, Link Content) will use Gate 2 fully —
      // their renders arrive without prior human review.
      {
        const gate2Timer = new StageTimer(asmId, 'Gate 2 QA');
        try {
          const { shouldUseManualCheckpoint } = require('./manual_segment_workflow');
          const _liveCard = assemblyJobId
            ? global.persistedJobsRef && global.persistedJobsRef[assemblyJobId]
            : null;
          const _isC0Manual = shouldUseManualCheckpoint(_liveCard || { jobSpecId: assemblyJobId });
          if (_isC0Manual) {
            log(
              asmId,
              `⏭  Gate 2 skipped — c0 manual workflow (operator reviewed segments before assembly)`
            );
            gate2To3aReady = true;
            // Write a synthetic gate2 pass to the job spec so gate3a preflight
            // doesn't block on the "prerequisite gate2 missing" check.
            try {
              const { saveGateResult: _saveG2 } = require('./job_spec');
              const _syntheticG2 = {
                portal: 2,
                jobId: assemblyJobId || asmId,
                passed: true,
                score: 100,
                outcome: 'pass',
                note: 'Skipped — c0 manual checkpoint: operator reviewed segments before assembly',
                segmentResults: [],
                upstreamContext: {
                  confirmedClean: ['render_quality'],
                  escalatedConcerns: [],
                  downstreamHeadsUp: null,
                },
                completedAt: new Date().toISOString(),
              };
              await _saveG2(assemblyJobId || asmId, 'gate2', _syntheticG2);
              gate2ResultForGate3 = _syntheticG2;
            } catch (_g2SaveErr) {
              /* non-fatal */
            }
          } else {
            try {
              const gate2Worker = require('./portals/portal2');
              const { saveGateResult, getJobSpec } = require('./job_spec');

              // Collect avatar segment URLs only (source clips are not HeyGen renders)
              const avatarSegsForQA = segsToProcess.filter(
                (s) => s.type !== 'source_clip' && s.url
              );

              if (avatarSegsForQA.length > 0) {
                // Download ALL avatar segments for Gate 2 — silent detection requires full check
                // (sampling misses silent SETUP scenes which could be at any position)
                const g2TmpPaths = [];
                const g2SegLabels = []; // parallel array — label for each downloaded path

                for (let idx = 0; idx < avatarSegsForQA.length; idx++) {
                  const seg = avatarSegsForQA[idx];
                  const g2Path = path.join(TMP_DIR, `gate2_${asmId}_${idx}_${Date.now()}.mp4`);
                  try {
                    await downloadFile(seg.url, g2Path);
                    const sz = fs.existsSync(g2Path) ? fs.statSync(g2Path).size : 0;
                    if (sz > 5000) {
                      g2TmpPaths.push(g2Path);
                      g2SegLabels.push(seg.label || seg.sceneName || '');
                      log(asmId, `  ✓ Gate 2 segment: ${seg.label} (${(sz / 1024).toFixed(0)}KB)`);
                    } else {
                      try {
                        fs.unlinkSync(g2Path);
                      } catch (e) {}
                    }
                  } catch (e) {
                    log(
                      asmId,
                      `  ⚠️  Gate 2 segment download failed for ${seg.label}: ${e.message}`
                    );
                  }
                  await new Promise((r) => setTimeout(r, 500));
                }

                // Load job spec — try semantic jobSpecId first, then scriptJobId cross-reference
                let g2JobSpec = null;
                const _g2LookupId = reqJobSpecId || assemblyJobId;
                if (_g2LookupId) {
                  try {
                    g2JobSpec = await getJobSpec(_g2LookupId);
                  } catch (e) {}
                }
                // Fallback: try assemblyJobId directly if reqJobSpecId lookup failed
                if (!g2JobSpec && assemblyJobId && assemblyJobId !== _g2LookupId) {
                  try {
                    g2JobSpec = await getJobSpec(assemblyJobId);
                  } catch (e) {}
                }
                if (!g2JobSpec) {
                  const _g2IsShort = contentType?.includes('short') || format === 'portrait';
                  g2JobSpec = {
                    jobId: asmId,
                    customerId: reqCustomerId,
                    templateId: _g2IsShort ? 'short-form' : 'long-form',
                    contentType: contentType || 'news',
                    order: { output: { format: format === 'portrait' ? '9:16' : '16:9' } },
                    state: { gateResults: {} },
                    designSpec: reqDesignSpec || {
                      chrome: {},
                      audio: {},
                      resolution: {},
                      ffmpeg: {},
                    },
                    commitments: {
                      assembly: {
                        status: 'approved',
                        summary: `Assemble ${contentType || 'news'} ${_g2IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
                        issuedAt: new Date().toISOString(),
                      },
                    },
                    deliverySpec: {
                      platforms: publishPlatformsList(contentType),
                      driveFolderId: process.env.DRIVE_FOLDER_ID || null,
                      uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
                      categoryId: categoryIdFromDesign,
                      scheduledAt: null,
                    },
                  };
                }

                if (g2TmpPaths.length > 0) {
                  const { saveOutput: saveG2Policy } = require('./job_spec');
                  const runGate2Attempt = async () => {
                    const g2Preflight = preflightGateExecution({
                      jobId: g2JobSpec.jobId,
                      portal: 'portal2',
                      fallbackJobSpec: g2JobSpec,
                    });
                    if (g2Preflight.softHeals.length > 0) {
                      log(
                        asmId,
                        `🩹 Gate 2 preflight soft-heal: ${g2Preflight.softHeals.join('; ')}`
                      );
                    }
                    if (!g2Preflight.ready) {
                      log(
                        asmId,
                        `⚠️  Gate 2 prerequisites warning: ${g2Preflight.reasons.join('; ')}`
                      );
                    }
                    const g2RunSpec = g2Preflight.jobSpec || g2JobSpec;
                    const priorReports = g2RunSpec?.state?.gateResults || {};
                    const g2ResultAttempt = await gate2Worker.run(
                      g2RunSpec,
                      g2TmpPaths,
                      priorReports.gate0 || null,
                      priorReports.gate1 || null,
                      g2SegLabels
                    );
                    await saveGateResult(g2JobSpec.jobId, 'gate2', g2ResultAttempt);
                    emitGateResult(g2JobSpec, g2ResultAttempt, contentType);
                    return g2ResultAttempt;
                  };
                  const runGate2Intervention = async ({ interventionAttempt, lastResult }) => {
                    if (
                      lastResult?.outcome === 'rerender_needed' &&
                      (lastResult.silentSegments?.length > 0 ||
                        lastResult.shortSegments?.length > 0)
                    ) {
                      const badSegments = [
                        ...(lastResult.silentSegments || []),
                        ...(lastResult.shortSegments || []),
                      ];
                      log(
                        asmId,
                        `🛠 Gate 2 intervention ${interventionAttempt}: re-render ${badSegments.length} segment(s)`
                      );
                      return `rerender ${badSegments.length} segment(s)`;
                    }
                    return 'no gate2-specific intervention available';
                  };
                  const g2PolicyRun = await runUnifiedGatePolicy({
                    ...assemblyUnifiedPolicyHooks(asmId),
                    gateKey: 'gate2',
                    jobId: g2JobSpec.jobId,
                    runWorkerAttempt: runGate2Attempt,
                    runInterventionAttempt: runGate2Intervention,
                    isPass: (r) => !!r?.passed,
                    persistStatus: async (policy) =>
                      saveG2Policy(g2JobSpec.jobId, 'gate2_policy', policy),
                  });
                  const g2Result = g2PolicyRun.result;
                  gate2ResultForGate3 = g2Result;
                  const g2PostSpec = {
                    ...g2JobSpec,
                    state: {
                      ...(g2JobSpec?.state || {}),
                      gateResults: {
                        ...(g2JobSpec?.state?.gateResults || {}),
                        gate2: g2Result,
                      },
                    },
                  };
                  const g2Handoff = await persistGateHandoffReview({
                    asmId,
                    jobSpec: g2JobSpec,
                    fromGate: 'gate2',
                    nextGate: 'gate3a',
                    gateResult: g2Result,
                    fallbackJobSpec: g2PostSpec,
                  });
                  gate2To3aReady = !!g2Handoff.passed;

                  assemblyJobs[asmId].gate2Score = g2Result.score;
                  assemblyJobs[asmId].gate2Outcome = g2Result.outcome;
                  gate2Timer.addData('score', g2Result.score).addData('outcome', g2Result.outcome);

                  // Persist gate2 score to DB (non-fatal)
                  try {
                    const { saveAssemblyJob: saveAsmJobDb } = require('./db');
                    saveAsmJobDb(asmId, assemblyJobId || asmId, { gate2Score: g2Result.score });
                  } catch (e) {}

                  log(
                    asmId,
                    `📋 Gate 2: ${g2Result.outcome} (${g2Result.score}/100) — ${g2Result.segmentResults?.length || 0} segments checked`
                  );

                  if (!g2Result.passed && g2Result.outcome === 'hard_fail') {
                    log(
                      asmId,
                      `❌ Gate 2 hard fail — ${g2Result.batchStopped ? `batch stopped at ${path.basename(g2Result.batchStoppedAt || '')}` : 'segments failed QA'} — continuing assembly`
                    );
                    // Non-fatal — monitoring escalates if needed
                  }

                  // Re-render silent/short segments via HeyGen before continuing assembly
                  if (
                    g2Result.outcome === 'rerender_needed' &&
                    (g2Result.silentSegments?.length > 0 || g2Result.shortSegments?.length > 0)
                  ) {
                    const badSegments = [
                      ...(g2Result.silentSegments || []),
                      ...(g2Result.shortSegments || []),
                    ];
                    log(
                      asmId,
                      `🔄 Gate 2: ${badSegments.length} segment(s) need re-render — ${badSegments.map((s) => s.label).join(', ')}`
                    );

                    const sceneTextMap = req.body.sceneTextMap || {};
                    const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

                    for (const badSeg of badSegments) {
                      const sceneText = sceneTextMap[badSeg.label]?.text;
                      if (!sceneText || !HEYGEN_API_KEY) {
                        log(
                          asmId,
                          `  ⚠️  Cannot re-render ${badSeg.label} — no script text or HeyGen key`
                        );
                        continue;
                      }

                      log(asmId, `  🎬 Re-rendering ${badSeg.label} (was silent/short)...`);
                      try {
                        const axios = require('axios');
                        const isPortrait = format === 'portrait';
                        const reRenderBody = {
                          title: `rerender_${asmId}_${badSeg.label}`,
                          video_inputs: [
                            {
                              character: {
                                type: 'avatar',
                                avatar_id: process.env.HEYGEN_AVATAR_ID,
                                avatar_style: 'normal',
                              },
                              voice: {
                                type: 'text',
                                input_type: 'ssml',
                                input_text: sceneText,
                                voice_id: process.env.HEYGEN_VOICE_ID,
                                speed: parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85'),
                              },
                            },
                          ],
                          dimension: {
                            width: isPortrait ? 720 : 1280,
                            height: isPortrait ? 1280 : 720,
                          },
                          dynamic_duration: true,
                          test: false,
                        };

                        const submitResp = await axios.post(
                          'https://api.heygen.com/v2/video/generate',
                          reRenderBody,
                          {
                            headers: {
                              'X-Api-Key': HEYGEN_API_KEY,
                              'Content-Type': 'application/json',
                            },
                            timeout: 30000,
                          }
                        );

                        const newVideoId = submitResp.data?.data?.video_id;
                        if (!newVideoId)
                          throw new Error('No video_id returned from HeyGen re-render');

                        log(asmId, `  ⏳ Re-render submitted: ${newVideoId} — polling...`);

                        // Poll until complete (max 3 min)
                        let newVideoUrl = null;
                        for (let attempt = 0; attempt < 18; attempt++) {
                          await new Promise((r) => setTimeout(r, 10000));
                          const statusResp = await axios.get(
                            `https://api.heygen.com/v1/video_status.get?video_id=${newVideoId}`,
                            { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
                          );
                          const status = statusResp.data?.data?.status;
                          if (status === 'completed') {
                            newVideoUrl = statusResp.data.data.video_url;
                            break;
                          }
                          if (status === 'failed')
                            throw new Error(`HeyGen re-render failed for ${badSeg.label}`);
                        }

                        if (!newVideoUrl)
                          throw new Error(`Re-render timed out for ${badSeg.label}`);

                        // Replace URL in segsToProcess
                        const segIdx = segsToProcess.findIndex((s) => s.label === badSeg.label);
                        if (segIdx >= 0) {
                          segsToProcess[segIdx].url = newVideoUrl;
                          log(asmId, `  ✅ Re-render complete for ${badSeg.label} — URL updated`);
                        }
                      } catch (reRenderErr) {
                        log(
                          asmId,
                          `  ❌ Re-render failed for ${badSeg.label}: ${reRenderErr.message} — continuing with original`
                        );
                      }
                    }
                  }

                  // Clean up tmp files after Gate 2 completes (and after re-render logic)
                  g2TmpPaths.forEach((p) => {
                    try {
                      fs.unlinkSync(p);
                    } catch (e) {}
                  });
                } else {
                  log(asmId, `⚠️  Gate 2: No segments downloaded successfully — skipping`);
                  gate2To3aReady = false;
                }
              } else {
                log(asmId, `⚠️  Gate 2: No avatar segments to check — skipping`);
                gate2To3aReady = false;
              }
            } catch (g2Err) {
              log(asmId, `⚠️  Gate 2 error: ${g2Err.message} — continuing assembly`);
              gate2To3aReady = false;
            }
          } // end non-c0-manual else
        } catch (_outerErr) {
          log(asmId, `⚠️  Gate 2 outer error: ${_outerErr.message}`);
        }
        addStageMetrics(asmId, gate2Timer.end());
      }

      // Step 1: Download all segments in order
      // For Twitch source_clips, re-resolve fresh GQL tokens — stored tokens expire within hours
      const downloadTimer = new StageTimer(asmId, 'Download Segments');
      // localFiles/localFileTypes/localFileMeta are indexed by segsToProcess position (index assignment,
      // not push) so that group assembly can safely access localFiles[segsToProcess_index].
      // Skipped segments leave holes (undefined) that filter(Boolean) handles downstream.
      const localFiles = [];
      const localFileTypes = []; // Parallel to localFiles — indexed by segsToProcess[i]
      const localFileMeta = []; // Original segment metadata — indexed by segsToProcess[i]
      let downloadedBytes = 0;
      let cachedCount = 0;
      const minSegmentBytes = isSynthPrebuild
        ? MIN_SEGMENT_BYTES_SYNTH_PREBUILD
        : MIN_SEGMENT_BYTES_REMOTE;
      for (let i = 0; i < segsToProcess.length; i++) {
        const seg = segsToProcess[i];
        let url = seg.url;
        const label = seg.label || `seg_${i}`;
        const segType = seg.type || 'avatar';
        const filename = `${asmId}_${i}_${label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .slice(0, 40)}.mp4`;
        const destPath = path.join(TMP_DIR, filename);

        if (!url) {
          log(asmId, `⏭  Skipping ${label} — no URL`);
          continue;
        }

        // Manual checkpoint override path: allow local replacement for avatar or clip.
        if (seg.localCache && fs.existsSync(seg.localCache)) {
          const cacheSize = fs.statSync(seg.localCache).size;
          if (cacheSize > 10000) {
            log(
              asmId,
              `📦 Using local override for ${label} (${(cacheSize / 1024 / 1024).toFixed(1)}MB)`
            );
            try {
              fs.copyFileSync(seg.localCache, destPath);
              localFiles[i] = destPath;
              localFileTypes[i] = segType;
              localFileMeta[i] = seg;
              downloadedBytes += cacheSize;
              cachedCount++;
              log(asmId, `✅ ${filename} (manual/local)`);
              continue;
            } catch (e) {
              log(
                asmId,
                `⚠️  Local override copy failed for ${label}: ${e.message} — falling back to URL`
              );
            }
          }
        }

        // For Twitch source clips: always resolve a fresh GQL token at assembly time
        // Stored CDN tokens expire after ~1 hour and HeyGen rendering often takes longer
        if (segType === 'source_clip') {
          // ── News clips: re-scrape Brightcove HLS URL at assembly time ──
          // Brightcove fastly_token expires in ~1 hour (same as Twitch CDN tokens).
          // HeyGen render takes 30-60 min — always re-scrape rather than use stored URL.
          // seg.pageUrl for News source_clips = the Al Jazeera article URL.
          // Fix 6a: re-scrape AJ HLS for both news and news-short — Brightcove tokens expire ~1 hour
          if (
            (contentType === 'news' || contentType === 'news-short') &&
            seg.pageUrl &&
            seg.pageUrl.includes('aljazeera')
          ) {
            try {
              if (/\/features\//i.test(String(seg.pageUrl))) {
                log(asmId, `⏭  Rejecting feature-page clip for ${label}: ${seg.pageUrl}`);
                continue;
              }
              const freshHls = await scrapeArticleVideo(seg.pageUrl);
              if (freshHls) {
                url = freshHls;
                log(asmId, `🔄 Fresh Brightcove HLS for ${label} (re-scraped from article)`);
              } else {
                log(asmId, `⚠️  Re-scrape returned null for ${label} — skipping stale stored URL`);
                continue;
              }
            } catch (e) {
              log(
                asmId,
                `⚠️  Re-scrape failed for ${label}: ${e.message} — skipping stale stored URL`
              );
              continue;
            }
          }

          let clipSlug = seg.pageUrl ? extractTwitchSlug(seg.pageUrl) : '';

          // Fallback: extract slug from CDN URL token parameter (for old jobs without pageUrl)
          if (!clipSlug && url && url.includes('token=')) {
            try {
              const tokenParam = url.match(/[?&]token=([^&]+)/);
              if (tokenParam) {
                const decoded = JSON.parse(decodeURIComponent(tokenParam[1]));
                const clipUri =
                  decoded.clip_uri ||
                  (decoded.authorization && decoded.authorization.clip_uri) ||
                  '';
                clipSlug = extractTwitchSlug(clipUri) || clipSlug;
              }
            } catch (e) {} // silent — just skip if token can't be parsed
          }

          if (clipSlug) {
            try {
              const fresh = await resolveTwitchClipMp4(clipSlug, 'high');
              url = fresh.mp4Url;
              log(asmId, `🔄 Fresh GQL token for ${label} (${fresh.quality})`);
            } catch (e) {
              log(
                asmId,
                `⚠️  GQL refresh failed for ${label}: ${e.message} — validating stored URL`
              );

              // Validate that stored URL is still accessible before using it
              try {
                const headResp = await axios.head(url, { timeout: 5000 });
                if (headResp.status !== 200) {
                  log(
                    asmId,
                    `❌ Stored URL returned status ${headResp.status} — cannot use this segment`
                  );
                  continue; // Skip this segment
                }
                log(asmId, `✓ Stored URL still valid for ${label}`);
              } catch (headErr) {
                log(
                  asmId,
                  `❌ Stored URL validation failed: ${headErr.message} — segment expired, skipping`
                );
                continue; // Skip this segment
              }
            }
          }
        }

        log(asmId, `⬇  [${segType.toUpperCase()}] ${i + 1}/${segsToProcess.length}: ${label}`);
        assemblyJobs[asmId].pct = Math.round((i / segsToProcess.length) * 40);

        try {
          await downloadFile(url, destPath);
          // Validate the file is actual video data, not an HTML error page from expired CDN token
          const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          const MAX_SEGMENT_SIZE = 2 * 1024 * 1024 * 1024; // 2GB max

          if (fileSize < minSegmentBytes) {
            log(
              asmId,
              `❌ Segment ${i + 1} too small (${fileSize} bytes, minimum ${minSegmentBytes}${isSynthPrebuild ? ', synth prebuild' : ', remote'}) — likely error page or corrupt`
            );
            try {
              fs.unlinkSync(destPath);
            } catch (e) {}
            continue;
          }
          if (fileSize > MAX_SEGMENT_SIZE) {
            log(
              asmId,
              `❌ Segment ${i + 1} too large (${(fileSize / 1024 / 1024).toFixed(1)}MB, maximum 2GB)`
            );
            try {
              fs.unlinkSync(destPath);
            } catch (e) {}
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
            log(
              asmId,
              `❌ Segment ${i + 1} is not a valid MP4 (header: "${boxType}") — likely expired token, skipping`
            );
            try {
              fs.unlinkSync(destPath);
            } catch (e) {}
            continue;
          }
          localFiles[i] = destPath;
          localFileTypes[i] = segType; // indexed by segsToProcess[i], not download position
          localFileMeta[i] = seg;
          downloadedBytes += fileSize;
          log(asmId, `✅ ${filename}`);
        } catch (e) {
          log(asmId, `❌ Failed segment ${i + 1} (${segType}): ${e.message}`);
          // Continue — skip this segment
        }
      }

      if (!localFiles.filter(Boolean).length) {
        log(asmId, '❌ No segments could be downloaded. Aborting.');
        logError('ASSEMBLY_NO_SEGMENTS', 'No segments could be downloaded', {
          asmId,
          jobId: assemblyJobId,
          contentType,
        });
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = 'No segments could be downloaded';
        saveAssemblyJob(asmId);
        nrAssembly('AssemblyFailed', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          reason: 'no_segments_downloaded',
        });
        return;
      }

      // Complete download metrics
      downloadTimer
        .addData('segmentCount', localFiles.length)
        .addData('totalMB', (downloadedBytes / 1024 / 1024).toFixed(2))
        .addData('cachedCount', cachedCount)
        .addData('downloadedCount', localFiles.length - cachedCount);
      addStageMetrics(asmId, downloadTimer.end());

      log(asmId, `\n📁 ${localFiles.length} segments ready. Probing durations...`);
      assemblyJobs[asmId].pct = 45;

      // Step 2: Probe durations for xfade offset calculation
      const durations = [];
      for (const f of localFiles) {
        const dur = await probeDuration(f);
        durations.push(dur);
        log(asmId, `  ${path.basename(f)}: ${dur.toFixed(2)}s`);
      }

      // ── SHORT-FORM SPLIT-SCREEN ASSEMBLY (9:16 Portrait) ────────────────────────
      // For short-form videos (-short suffix), use split-screen layout instead of transitions.
      // Detection: content type suffix OR configLoader formFactor flag — format field is NOT
      // required because it may be absent from older jobSpecs and should not silently drop
      // a short-form job into the long-form assembly path.
      const isShortForm =
        contentType && (isShortFormType(contentType) || contentType.includes('-short'));

      // Declare outPath/outFile/totalDur/tickerType in outer scope so Gate 3 QA + Drive upload can access them
      // regardless of whether short-form or long-form branch ran.
      let outPath = '';
      let outFile = '';
      let totalDur = '0';
      let downloadedClipCount = 0; // set inside download block, read by Gate 3 — must be outer scope
      const isShortContent =
        contentType && (isShortFormType(contentType) || contentType.includes('-short'));
      // tickerType: null for short-form (no ticker), or the base type key used in TICKER_MAP
      const tickerType =
        !isShortContent && contentType
          ? (() => {
              try {
                return getAssemblyConfig(contentType).ticker || null;
              } catch (e) {
                return contentType.replace(/-short$/, '');
              }
            })()
          : null;

      if (isShortForm) {
        log(asmId, `\n📱 SHORT-FORM DETECTED — Using split-screen assembly (9:16 portrait)`);
        const assemblyTimer = new StageTimer(asmId, 'Short-Form Split-Screen Assembly');

        // Build output path
        const outDir = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        outFile = `${(jobTitle || 'cwn_short')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .slice(0, 50)}_${assemblyJobId || asmId}.mp4`;
        outPath = path.join(outDir, outFile);

        // Separate segments by type using localFileTypes[] parallel array (Fix 6b)
        // localFileTypes[] was populated in the download loop with each file's segType,
        // so index i here always matches localFiles[i] — no filename pattern matching needed.
        const avatarFiles = [];
        const clipFiles = [];
        const clipFilesMeta = []; // parallel to clipFiles — carries clipTimingTargets

        for (let i = 0; i < localFiles.length; i++) {
          const segType = localFileTypes[i] || 'avatar';

          if (segType === 'source_clip') {
            clipFiles.push(localFiles[i]);
            clipFilesMeta.push(localFileMeta[i] || null);
          } else {
            avatarFiles.push(localFiles[i]);
          }
        }

        log(
          asmId,
          `  📊 Segments: ${avatarFiles.length} avatar + ${clipFiles.length} source clips`
        );

        // Warn loudly when short-form expects HOOK+REACTION but only HOOK arrived.
        // The 3-phase timeline requires 2 avatar files; missing REACTION means it falls
        // back to single-pass (no reaction segment), which silently produces a wrong video.
        const shortAvatarScenes = (segsToProcess || []).filter(
          (s) => s.type !== 'source_clip'
        ).length;
        if (shortAvatarScenes >= 2 && avatarFiles.length < 2) {
          const missingCount = shortAvatarScenes - avatarFiles.length;
          log(
            asmId,
            `⚠️  SHORT-FORM AVATAR INCOMPLETE: script requires ${shortAvatarScenes} avatar segments but only ${avatarFiles.length} arrived.`
          );
          log(
            asmId,
            `⚠️  Missing ${missingCount} avatar file(s) — check tmp/manual_segments/${assemblyJobId}/ for:`
          );
          for (let i = 0; i < segsToProcess.length; i++) {
            const seg = segsToProcess[i];
            if (seg.type === 'source_clip') continue;
            const hasFile = !!localFiles[i];
            const { expectedFilename: ef } = require('./manual_segment_workflow');
            log(
              asmId,
              `  [${i}] ${seg.label || 'seg'} → ${ef(i, seg)} ${hasFile ? '✅ present' : '❌ MISSING'}`
            );
          }
          log(
            asmId,
            `⚠️  Falling back to single-pass (HOOK only) — REACTION will be absent from output.`
          );
        }

        // Assign outer-scope counter so Gate 3 QA has the real downloaded clip count
        downloadedClipCount = clipFiles.length;

        // Use first source clip — clips are script-ordered, index 0 matches the script
        let selectedClip = null;
        if (clipFiles.length > 0) {
          selectedClip = clipFiles[0];
          log(asmId, `  🎯 Using script-matched clip: ${path.basename(selectedClip)}`);
        }

        if (avatarFiles.length === 0) {
          throw new Error('No avatar segments found for short-form video');
        }

        // Step 1-3: Build TOP/BOTTOM timeline tracks for short-form
        const shortTempPaths = [];
        const concatMp4Files = async (files, outPath, withAudio = true, label = 'concat') => {
          const listPath = path.join(
            TMP_DIR,
            `${asmId}_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_list.txt`
          );
          shortTempPaths.push(listPath);
          const listBody = files
            .map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`)
            .join('\n');
          fs.writeFileSync(listPath, listBody);
          await new Promise((res, rej) => {
            const args = [
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              listPath,
              ...ffmpegEncodeArgs(true),
              '-r',
              '25',
              '-vf',
              'fps=fps=25,setpts=PTS-STARTPTS',
              ...(withAudio ? ['-c:a', 'aac', '-ar', '44100', '-ac', '2'] : ['-an']),
              '-y',
              outPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`${label} failed: ${code}`))
            );
            proc.on('error', rej);
          });
        };

        const avatarConcatPath = path.join(TMP_DIR, `${asmId}_avatar_concat.mp4`);
        shortTempPaths.push(avatarConcatPath);
        if (avatarFiles.length === 1) {
          fs.copyFileSync(avatarFiles[0], avatarConcatPath);
        } else {
          await concatMp4Files(avatarFiles, avatarConcatPath, true, 'avatar_concat');
        }

        let avatarTimelinePath = path.join(TMP_DIR, `${asmId}_avatar_timeline.mp4`);
        let clipTimelinePath = path.join(TMP_DIR, `${asmId}_clip_timeline.mp4`);
        shortTempPaths.push(avatarTimelinePath, clipTimelinePath);

        // All short-form content types now use the same 3-phase timeline:
        // HOOK (top+bottom plays) → CLIP window (top held/silent, bottom active) → REACTION (top speaks, bottom paused)
        const useHookClipReactionMode = !!selectedClip && avatarFiles.length >= 2;
        if (useHookClipReactionMode) {
          log(
            asmId,
            '  🎯 Short timeline mode: HOOK (top) → CLIP window (bottom active, top held) → REACTION (top)'
          );
          const hookAvatarPath = avatarFiles[0];
          const reactionConcatPath = path.join(TMP_DIR, `${asmId}_reaction_concat.mp4`);
          shortTempPaths.push(reactionConcatPath);
          if (avatarFiles.length === 2) {
            fs.copyFileSync(avatarFiles[1], reactionConcatPath);
          } else {
            await concatMp4Files(avatarFiles.slice(1), reactionConcatPath, true, 'reaction_concat');
          }

          const hookDur = await probeDuration(hookAvatarPath);
          const reactionDur = await probeDuration(reactionConcatPath);
          const rawClipDur = await probeDuration(selectedClip);
          const maxClipDur = Number(process.env.SHORT_CLIP_WINDOW_MAX_SEC || '25');

          // Seek to the first key moment identified by Gemini during clip analysis.
          // clipTimingTargets entries look like { start: 38.2, label: 'Murray drive' }.
          // Using the first entry keeps the most relevant play front and center.
          const clipMeta0 = clipFilesMeta[0];
          const timingTargets = Array.isArray(clipMeta0?.clipTimingTargets)
            ? clipMeta0.clipTimingTargets
            : [];
          const firstTarget = timingTargets.find(
            (t) => typeof t.start === 'number' && t.start >= 0
          );
          const seekOffset = firstTarget ? Math.max(0, firstTarget.start - 1) : 0; // 1s pre-roll before the play
          const seekableClipDur = Math.max(0, rawClipDur - seekOffset);
          const clipDur = Math.max(1.5, Math.min(seekableClipDur || 0, maxClipDur));

          if (seekOffset > 0) {
            log(
              asmId,
              `  ⏩ Clip seek: ${seekOffset.toFixed(1)}s (Gemini key moment: "${firstTarget?.label || 'play'}" at ${firstTarget?.start}s) → showing ${clipDur.toFixed(1)}s window`
            );
          }

          const hookHeldTopPath = path.join(TMP_DIR, `${asmId}_hook_held_top.mp4`);
          const reactionTopPath = path.join(TMP_DIR, `${asmId}_reaction_top.mp4`);
          shortTempPaths.push(hookHeldTopPath, reactionTopPath);

          await new Promise((res, rej) => {
            const args = [
              '-i',
              hookAvatarPath,
              '-vf',
              `scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,tpad=stop_mode=clone:stop_duration=${clipDur.toFixed(3)}`,
              '-af',
              `apad=pad_dur=${clipDur.toFixed(3)}`,
              '-t',
              (hookDur + clipDur).toFixed(3),
              ...ffmpegEncodeArgs(true),
              '-c:a',
              'aac',
              '-ar',
              '44100',
              '-ac',
              '2',
              '-y',
              hookHeldTopPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Hook hold prep failed: ${code}`))
            );
            proc.on('error', rej);
          });

          await new Promise((res, rej) => {
            const args = [
              '-i',
              reactionConcatPath,
              '-vf',
              'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
              ...ffmpegEncodeArgs(true),
              '-c:a',
              'aac',
              '-ar',
              '44100',
              '-ac',
              '2',
              '-y',
              reactionTopPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Reaction top prep failed: ${code}`))
            );
            proc.on('error', rej);
          });

          await concatMp4Files(
            [hookHeldTopPath, reactionTopPath],
            avatarTimelinePath,
            true,
            'top_timeline'
          );

          const clipCenterPath = path.join(TMP_DIR, `${asmId}_clip_center.mp4`);
          const blackHookPath = path.join(TMP_DIR, `${asmId}_clip_black_hook.mp4`);
          const blackReactionPath = path.join(TMP_DIR, `${asmId}_clip_black_reaction.mp4`);
          shortTempPaths.push(clipCenterPath, blackHookPath, blackReactionPath);

          await new Promise((res, rej) => {
            const args = [
              ...(seekOffset > 0 ? ['-ss', seekOffset.toFixed(3)] : []),
              '-i',
              selectedClip,
              '-t',
              clipDur.toFixed(3),
              '-vf',
              'fps=fps=25,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setpts=PTS-STARTPTS',
              ...ffmpegEncodeArgs(true),
              '-an',
              '-y',
              clipCenterPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Clip center prep failed: ${code}`))
            );
            proc.on('error', rej);
          });

          const makeBlackHalf = async (outPath, dur) => {
            await new Promise((res, rej) => {
              const args = [
                '-f',
                'lavfi',
                '-i',
                `color=c=black:s=1080x960:d=${Math.max(0.1, dur).toFixed(3)}`,
                ...ffmpegEncodeArgs(true),
                '-an',
                '-pix_fmt',
                'yuv420p',
                '-y',
                outPath,
              ];
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', (code) =>
                code === 0 ? res() : rej(new Error(`Black half gen failed: ${code}`))
              );
              proc.on('error', rej);
            });
          };

          await makeBlackHalf(blackHookPath, hookDur);
          await makeBlackHalf(blackReactionPath, reactionDur);
          await concatMp4Files(
            [blackHookPath, clipCenterPath, blackReactionPath],
            clipTimelinePath,
            false,
            'bottom_timeline'
          );
        } else {
          // Fallback for legacy runs with a single avatar segment and/or no source clip.
          log(asmId, '  ℹ️  Using fallback short timeline (single-pass avatar+clip)');
          const avatarDuration = await probeDuration(avatarConcatPath);
          const avatarHalfPath = path.join(TMP_DIR, `${asmId}_avatar_half.mp4`);
          const clipHalfPath = path.join(TMP_DIR, `${asmId}_clip_half.mp4`);
          shortTempPaths.push(avatarHalfPath, clipHalfPath);

          await new Promise((res, rej) => {
            const args = [
              '-i',
              avatarConcatPath,
              '-vf',
              'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
              ...ffmpegEncodeArgs(true),
              '-c:a',
              'aac',
              '-ar',
              '44100',
              '-ac',
              '2',
              '-y',
              avatarHalfPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Avatar half prep failed: ${code}`))
            );
            proc.on('error', rej);
          });

          if (selectedClip) {
            const rawFallbackClipDur = await probeDuration(selectedClip);
            const maxFallbackClipDur = Number(process.env.SHORT_CLIP_WINDOW_MAX_SEC || '25');
            const fallbackClipDur = Math.min(
              rawFallbackClipDur || avatarDuration,
              maxFallbackClipDur
            );
            await new Promise((res, rej) => {
              const args = [
                '-i',
                selectedClip,
                '-t',
                fallbackClipDur.toFixed(3),
                '-vf',
                'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
                ...ffmpegEncodeArgs(true),
                '-an',
                '-y',
                clipHalfPath,
              ];
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', (code) =>
                code === 0 ? res() : rej(new Error(`Clip half prep failed: ${code}`))
              );
              proc.on('error', rej);
            });
          } else {
            await new Promise((res, rej) => {
              const args = [
                '-f',
                'lavfi',
                '-i',
                `color=c=black:s=1080x960:d=${avatarDuration.toFixed(3)}`,
                ...ffmpegEncodeArgs(true),
                '-an',
                '-pix_fmt',
                'yuv420p',
                '-y',
                clipHalfPath,
              ];
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', (code) =>
                code === 0 ? res() : rej(new Error(`Black clip half gen failed: ${code}`))
              );
              proc.on('error', rej);
            });
          }

          fs.copyFileSync(avatarHalfPath, avatarTimelinePath);
          fs.copyFileSync(clipHalfPath, clipTimelinePath);
        }

        // Step 4: Vertical stack — avatar on TOP, clip on BOTTOM (1080×1920)
        log(asmId, `  📐 Stacking: avatar (top) + clip (bottom) = 1080×1920...`);
        const stackedPath = path.join(TMP_DIR, `${asmId}_stacked.mp4`);
        shortTempPaths.push(stackedPath);

        await new Promise((res, rej) => {
          const args = [
            '-i',
            avatarTimelinePath, // input 0 = avatar (TOP)
            '-i',
            clipTimelinePath, // input 1 = source clip (BOTTOM)
            '-filter_complex',
            '[0:v][1:v]vstack=inputs=2[vstacked]',
            '-map',
            '[vstacked]',
            '-map',
            '0:a?',
            ...ffmpegEncodeArgs(true),
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            '-y',
            stackedPath,
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
          proc.on('close', (code) =>
            code === 0 ? res() : rej(new Error(`Vstack failed: ${code}`))
          );
          proc.on('error', rej);
        });
        log(asmId, `  ✅ Split-screen stacked (1080×1920)`);

        // Step 4.5: Burn caption text overlay (per-show style from creative bible / jobSpec)
        // captionText + captionStyle come from the assembly payload (parsed from script at script gen time).
        // If captionStyle is missing or incomplete, read from jobSpec.designSpec.chrome.caption.
        const captionText = req.body.captionText || null;
        let captionStyle = req.body.captionStyle || null;
        let captionedPath = stackedPath; // default: pass through unchanged

        // Merge/override caption style with jobSpec.designSpec.chrome.caption values.
        // jobSpec is the single source of truth (c0.json → script_gen → jobSpec → assembly).
        // Priority: jobSpec overrides stale script_gen captionStyle for color and position.
        const jobSpecCaption = req.body.jobSpec?.designSpec?.chrome?.caption || null;
        if (jobSpecCaption && captionText) {
          const baseTypeForCaptionRaw = (contentType || 'news').replace(/-short$/, '');
          const captionTypeAlias = { twitch: 'clips', nba: 'sports' };
          const baseTypeForCaption =
            captionTypeAlias[baseTypeForCaptionRaw] || baseTypeForCaptionRaw;
          const jobSpecColor = jobSpecCaption.colors?.[baseTypeForCaption] || null;
          const jobSpecBoxOpacity = jobSpecCaption.boxOpacity ?? 0.75;
          if (!captionStyle) {
            // Build a full style from jobSpec
            captionStyle = {
              font:
                jobSpecCaption.font || '/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf',
              fontsize: jobSpecCaption.fontsize || 68,
              fontcolor: jobSpecColor || '#FFFFFF',
              boxcolor: `${jobSpecColor || '#000000'}@${jobSpecBoxOpacity}`,
              boxborderw: jobSpecCaption.boxBorderW || 18,
              position: jobSpecCaption.position || 'y=920',
              useBox: jobSpecCaption.useBox !== false,
              borderw: jobSpecCaption.strokeWidth || 0,
              bordercolor: jobSpecCaption.strokeColor || '#000000',
              shadowx: Number.isFinite(Number(jobSpecCaption.shadowX))
                ? Number(jobSpecCaption.shadowX)
                : 0,
              shadowy: Number.isFinite(Number(jobSpecCaption.shadowY))
                ? Number(jobSpecCaption.shadowY)
                : 0,
              shadowcolor: jobSpecCaption.shadowColor || '#000000@0.6',
              yOffset: Number.isFinite(Number(jobSpecCaption.yOffset))
                ? Number(jobSpecCaption.yOffset)
                : 0,
              maxLines: Number.isFinite(Number(jobSpecCaption.maxLines))
                ? Number(jobSpecCaption.maxLines)
                : 2,
            };
          } else {
            // Always let jobSpec drive placement/highlight for short-form.
            captionStyle = {
              ...captionStyle,
              font: jobSpecCaption.font || captionStyle.font,
              fontsize: jobSpecCaption.fontsize || captionStyle.fontsize,
              boxborderw: jobSpecCaption.boxBorderW || captionStyle.boxborderw,
              position: jobSpecCaption.position || captionStyle.position || 'y=920',
              useBox: jobSpecCaption.useBox !== false,
              borderw: jobSpecCaption.strokeWidth || captionStyle.borderw || 0,
              bordercolor: jobSpecCaption.strokeColor || captionStyle.bordercolor || '#000000',
              shadowx: Number.isFinite(Number(jobSpecCaption.shadowX))
                ? Number(jobSpecCaption.shadowX)
                : captionStyle.shadowx || 0,
              shadowy: Number.isFinite(Number(jobSpecCaption.shadowY))
                ? Number(jobSpecCaption.shadowY)
                : captionStyle.shadowy || 0,
              shadowcolor: jobSpecCaption.shadowColor || captionStyle.shadowcolor || '#000000@0.6',
              yOffset: Number.isFinite(Number(jobSpecCaption.yOffset))
                ? Number(jobSpecCaption.yOffset)
                : captionStyle.yOffset || 0,
              maxLines: Number.isFinite(Number(jobSpecCaption.maxLines))
                ? Number(jobSpecCaption.maxLines)
                : captionStyle.maxLines || 2,
            };
            // Override color/highlight from jobSpec (captionStyle may have stale per-type defaults).
            if (jobSpecColor) {
              captionStyle = {
                ...captionStyle,
                fontcolor: jobSpecColor,
                boxcolor: `${jobSpecColor}@${jobSpecBoxOpacity}`,
              };
            }
          }
          captionStyle = {
            ...captionStyle,
            fontcolor: jobSpecCaption.textColor || captionStyle.fontcolor || '#FFFFFF',
          };
        }

        if (captionText && captionStyle) {
          log(asmId, `  💬 Burning caption: "${captionText}" (${contentType} style)`);
          const captionOutPath = path.join(TMP_DIR, `${asmId}_captioned.mp4`);
          shortTempPaths.push(captionOutPath);

          const formatCaptionLines = (rawText, maxLines = 2, softLineChars = 26) => {
            const clean = String(rawText || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!clean) return clean;
            if (maxLines <= 1) return clean;
            if (clean.includes('\n')) return clean;
            const words = clean.split(' ');
            if (words.length <= 3) return clean;
            let bestBreak = -1;
            let bestDelta = Number.POSITIVE_INFINITY;
            let leftLen = 0;
            for (let i = 0; i < words.length - 1; i++) {
              leftLen += words[i].length + (i > 0 ? 1 : 0);
              const rightLen = clean.length - leftLen - 1;
              const delta = Math.abs(leftLen - rightLen) + Math.abs(softLineChars - leftLen);
              if (delta < bestDelta) {
                bestDelta = delta;
                bestBreak = i;
              }
            }
            if (bestBreak < 1) return clean;
            const line1 = words.slice(0, bestBreak + 1).join(' ');
            const line2 = words.slice(bestBreak + 1).join(' ');
            return `${line1}\n${line2}`;
          };
          const renderedCaptionText = formatCaptionLines(
            captionText,
            Number.isFinite(Number(captionStyle.maxLines)) ? Number(captionStyle.maxLines) : 2
          );

          // Escape text for FFmpeg drawtext — colons, apostrophes, backslashes
          const escapedText = renderedCaptionText
            .replace(/\\/g, '\\\\')
            .replace(/'/g, '\u2019') // smart apostrophe avoids FFmpeg quoting issues
            .replace(/:/g, '\\:')
            .replace(/\n/g, '\\n');

          // Build position expression.
          // Per CREATIVE_CONFIG_SPEC.md: caption at y=920, centered (x=(w-text_w)/2).
          // Canvas is 1080×1920. Bobby G is TOP half (y:0-960). Caption at y=920 sits just
          // above the split line — visible on Bobby G's half, not on the source clip half.
          let dtX, dtY;
          const yOffset = Number.isFinite(Number(captionStyle.yOffset))
            ? Number(captionStyle.yOffset)
            : 0;
          if (
            captionStyle.position === 'y=920' ||
            captionStyle.position === 'above-split' ||
            captionStyle.position === 'panel-bottom-center'
          ) {
            // CREATIVE_CONFIG_SPEC.md canonical position: y=920 centered
            dtX = '(W-text_w)/2';
            // Keep caption in Bobby's top panel lower-third, above split line (y=960).
            dtY = `(960-text_h-36+${Math.round(yOffset)})`;
          } else if (captionStyle.position === 'top-center') {
            dtX = '(W-text_w)/2';
            dtY = `${60 + Math.round(yOffset)}`;
          } else if (captionStyle.position === 'center-right') {
            dtX = 'W*0.52';
            dtY = '(H-text_h)/2';
          } else if (captionStyle.position === 'center-frame') {
            dtX = '(W-text_w)/2';
            dtY = '(H-text_h)/2';
          } else {
            // bottom-bar (news legacy)
            dtX = '0';
            dtY = 'H-th-40';
          }

          const drawArgs = [
            `fontfile=${captionStyle.font}`,
            `text=${escapedText}`,
            `fontsize=${captionStyle.fontsize}`,
            `fontcolor=${captionStyle.fontcolor}`,
            `box=${captionStyle.useBox === false ? 0 : 1}`,
            `boxcolor=${captionStyle.boxcolor || '0x000000@0.75'}`,
            `boxborderw=${captionStyle.boxborderw || 18}`,
            `borderw=${captionStyle.borderw || 0}`,
            `bordercolor=${captionStyle.bordercolor || '#000000'}`,
            `shadowx=${captionStyle.shadowx || 0}`,
            `shadowy=${captionStyle.shadowy || 0}`,
            `shadowcolor=${captionStyle.shadowcolor || '#000000@0.6'}`,
            `x=${dtX}`,
            `y=${dtY}`,
          ].join(':');

          await new Promise((res, rej) => {
            const args = [
              '-i',
              stackedPath,
              '-vf',
              `drawtext=${drawArgs}`,
              ...ffmpegEncodeArgs(true),
              '-c:a',
              'copy',
              '-y',
              captionOutPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) => {
              if (code === 0) {
                captionedPath = captionOutPath;
                log(asmId, `  ✅ Caption burned`);
                res();
              } else {
                // Non-fatal: log and continue without caption
                log(asmId, `  ⚠️  Caption burn failed (code ${code}) — continuing without caption`);
                res();
              }
            });
            proc.on('error', (e) => {
              log(asmId, `  ⚠️  Caption burn error: ${e.message} — continuing without caption`);
              res(); // non-fatal
            });
          });
        } else if (captionText) {
          log(asmId, `  ⚠️  Caption text present but no style object — skipping burn`);
        }

        // Step 5: Apply logo overlay — bottom-right on Bobby G's coffee mug
        const shortLogoPos = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.LOGO_POS;
        log(asmId, `  🏷  Applying CWN logo (${shortLogoPos.size}px, bottom-right mug)...`);
        const logoPath = path.join(__dirname, '..', 'assets', 'cwn_logo.png');
        const hasLogo = fs.existsSync(logoPath);

        if (hasLogo) {
          await new Promise((res, rej) => {
            const args = [
              '-i',
              captionedPath,
              '-i',
              logoPath,
              '-filter_complex',
              `[1:v]scale=${shortLogoPos.size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=x=${shortLogoPos.x}:y=${shortLogoPos.y}:format=auto,format=yuv420p[vout]`,
              '-map',
              '[vout]',
              '-map',
              '0:a?',
              '-c:v',
              'libx264',
              '-preset',
              'fast',
              '-crf',
              '23',
              '-c:a',
              'copy',
              '-movflags',
              '+faststart',
              '-y',
              outPath,
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) => {
              if (code === 0) res();
              else {
                log(asmId, `  ⚠️  Logo overlay failed (code ${code}) — continuing without logo`);
                try {
                  fs.copyFileSync(captionedPath, outPath);
                } catch (e) {}
                res(); // non-fatal
              }
            });
            proc.on('error', (e) => {
              log(asmId, `  ⚠️  Logo overlay error: ${e.message}`);
              res();
            });
          });
          log(asmId, `  ✅ Logo applied`);
        } else {
          log(asmId, `  ⚠️  Logo not found at ${logoPath} — skipping logo overlay`);
          fs.renameSync(captionedPath, outPath);
        }

        // Clean up temp files
        for (const tmpPath of shortTempPaths) {
          try {
            if (!tmpPath || tmpPath === outPath) continue;
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          } catch (e) {}
        }

        log(asmId, `\n✅ Short-form assembly complete: ${outPath}`);
        assemblyJobs[asmId].pct = 100;
        assemblyJobs[asmId].status = 'done';
        assemblyJobs[asmId].outputPath = outPath;
        saveAssemblyJob(asmId);

        try {
          const st = fs.statSync(outPath);
          nrAssembly('AssemblyFfmpegComplete', {
            assemblyId: asmId,
            sourceJobId: assemblyJobId || null,
            contentType: contentType || null,
            assemblyBranch: 'short_form',
            outputFile: path.basename(outPath),
            sizeMB: Number((st.size / 1024 / 1024).toFixed(2)),
            jobStatusAfterEncode: 'done',
          });
        } catch (_st) {
          nrAssembly('AssemblyFfmpegComplete', {
            assemblyId: asmId,
            sourceJobId: assemblyJobId || null,
            contentType: contentType || null,
            assemblyBranch: 'short_form',
            outputFile: path.basename(outPath),
            jobStatusAfterEncode: 'done',
          });
        }

        // Add metrics
        assemblyTimer.addData('format', '9:16 portrait split-screen');
        addStageMetrics(asmId, assemblyTimer.end());

        // Skip to end of assembly endpoint (Gate 3 QA, Drive upload, etc.)
        // The endpoint will continue from here with the assembled outPath video
      } else {
        // ── LONG-FORM ASSEMBLY — Transition-based editing ──────────────────────────
        log(asmId, `\n🎬 LONG-FORM DETECTED — Using transition-based assembly`);

        // Start assembly timer (normalization + FFmpeg encode + ticker/logo)
        const assemblyTimer = new StageTimer(asmId, 'FFmpeg Assembly');

        // Step 3: Build output path
        const outDir = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        // Fix 28: Use actual clip count from segsToProcess (not the count embedded in jobTitle string)
        // jobTitle may say "22 avatar + 5 clips" but actual downloaded clips may differ
        const actualClipCount = segsToProcess.filter((s) => s.type === 'source_clip').length;
        const baseTitle = (jobTitle || 'cwn')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .slice(0, 40);
        outFile = `${baseTitle}_${actualClipCount}clips_${assemblyJobId || asmId}.${format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4'}`;
        outPath = path.join(outDir, outFile);

        // segTypes is indexed by segsToProcess position (same as localFiles after the index-assignment fix).
        // localFileTypes is always populated at localFileTypes[i] alongside localFiles[i], so they
        // always share the same max index and the fallback else-branch is dead code — kept for safety.
        let segTypes = [];
        if (localFileTypes.length === localFiles.length && localFiles.length > 0) {
          segTypes = localFileTypes.slice();
        } else {
          let localIdx = 0;
          for (let i = 0; i < segsToProcess.length; i++) {
            const seg = segsToProcess[i];
            const segType = seg.type || 'avatar';
            if (
              localIdx < localFiles.length &&
              localFiles[localIdx] &&
              localFiles[localIdx].includes(`${asmId}_${i}_`)
            ) {
              segTypes.push(segType);
              localIdx++;
            }
          }
          while (segTypes.length < localFiles.length) segTypes.push('avatar');
        }

        // ── Gate 3 Pre-Flight: deterministic structural check, no Gemini tokens ─────────
        // Fix 5: catches critical assembly failures BEFORE Gemini upload.
        // Runs after download loop + segTypes build, before TS normalization.
        function assemblyPreFlightCheck(localFiles, segTypes, segsToProcess, contentType) {
          const issues = [];
          const requestedClips = segsToProcess.filter((s) => s.type === 'source_clip').length;
          const downloadedClips = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;

          if (requestedClips > 0 && downloadedClips === 0) {
            issues.push({
              severity: 'CRITICAL',
              check: 'SOURCE_CLIPS_ALL_MISSING',
              detail: `${requestedClips} source clips requested, 0 downloaded — episode has no source footage`,
            });
          } else if (downloadedClips < requestedClips) {
            issues.push({
              severity: 'WARNING',
              check: 'SOURCE_CLIPS_PARTIAL',
              detail: `${downloadedClips}/${requestedClips} source clips downloaded — partial footage loss`,
            });
          }

          return { issues };
        }

        // Fix 5: Deterministic pre-flight check — runs before Gemini, no token cost
        const preFlightResult = assemblyPreFlightCheck(
          localFiles,
          segTypes,
          segsToProcess,
          contentType
        );
        const preFlightCriticals = preFlightResult.issues.filter((i) => i.severity === 'CRITICAL');
        if (preFlightCriticals.length > 0) {
          for (const issue of preFlightCriticals) {
            log(asmId, `🚨 PRE-FLIGHT CRITICAL: [${issue.check}] ${issue.detail}`);
          }
          const preFlightMsg = preFlightCriticals.map((i) => `[${i.check}] ${i.detail}`).join('; ');
          log(
            asmId,
            `❌ Gate 3 pre-flight failed — ${preFlightCriticals.length} critical issue(s). Aborting before Gemini upload.`
          );
          logError('ASSEMBLY_PREFLIGHT_FAIL', preFlightMsg, {
            asmId,
            jobId: assemblyJobId,
            contentType,
            issues: preFlightCriticals,
          });
          assemblyJobs[asmId].status = 'failed';
          assemblyJobs[asmId].error = preFlightMsg;
          assemblyJobs[asmId].qaOutcome = 'pre_flight_fail';
          assemblyJobs[asmId].qaReport = preFlightCriticals
            .map((i) => `CRITICAL: ${i.check} — ${i.detail}`)
            .join('\n');
          saveAssemblyJob(asmId);
          return;
        }
        for (const issue of preFlightResult.issues.filter((i) => i.severity === 'WARNING')) {
          log(asmId, `⚠️  PRE-FLIGHT WARNING: [${issue.check}] ${issue.detail}`);
        }

        // Assign to outer-scope let so Gate 3 QA can read it (was const — out of scope bug)
        downloadedClipCount = localFiles.filter((_, i) => segTypes[i] === 'source_clip').length;

        // ── Step 4: Group-level assembly ──────────────────────────────────────────
        // Split segments into logical groups (GAME#/STORY#/streamer or count-based),
        // assemble each group to a temp MP4, then stitch all groups into the final output.
        // Benefits: smaller FFmpeg jobs, clean voiceover scoping, single-group retry on failure.
        log(asmId, `  ℹ️  Normalizing ${localFiles.length} segments to TS...`);
        const tsFiles = [];
        const tsSegTypes = [];
        const tsSegMeta = [];
        // segTypes already built above before pre-flight check

        // ── Load job spec for universal chrome burn ───────────────────────────────
        // g3JobSpec is loaded later (Gate 3 QA), so we pre-load here for chrome burns.
        // Uses the same lookup pattern as Gate 2 and Gate 3.
        let chromeBurnJobSpec = req.body?.jobSpec || null;
        {
          if (!chromeBurnJobSpec) {
            const _chromeLookupId = reqJobSpecId || assemblyJobId;
            if (_chromeLookupId) {
              try {
                const { getJobSpec: _getJobSpecChrome } = require('./job_spec');
                chromeBurnJobSpec = await _getJobSpecChrome(_chromeLookupId);
              } catch (e) {}
            }
          }
        }

        // Build segment groups for grouped assembly
        const segGroups = groupSegmentsByLabel(segsToProcess);
        const useGroupedAssembly = segGroups.length > 1;
        log(
          asmId,
          `  🗂  Segment groups: ${segGroups.length} (${segGroups.map((g) => `${g.groupId}[${g.indices.length}]`).join(', ')})`
        );

        // Pick music track once — consistent across all groups
        const _voAsmCtKeyOuter =
          contentType === 'twitch'
            ? 'clips'
            : contentType === 'nba'
              ? 'sports'
              : (contentType || 'news').replace(/-short$/, '');
        const _voAsmCfgOuter = chromeBurnJobSpec?.designSpec?.assembly?.[_voAsmCtKeyOuter] || {};
        let _sharedMusicTrack = null;
        try {
          const audioDir = path.join(__dirname, '..', 'assets', 'audio');
          const tracks = fs.readdirSync(audioDir).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
          if (tracks.length > 0) {
            _sharedMusicTrack = path.join(
              audioDir,
              tracks[Math.floor(Math.random() * tracks.length)]
            );
            log(asmId, `  🎵 Music bed: ${path.basename(_sharedMusicTrack)}`);
          }
        } catch (e) {
          /* no music dir */
        }

        // Helper: run chrome burn + TS normalize for a single file
        // Returns the .ts output path, or throws on hard failure (non-255 exit).
        const processSegmentToTs = async (inputFilePath, segIdx, localSegIdx) => {
          let inputForTS = inputFilePath;
          // segIdx is the segsToProcess index — use it directly for the label.
          const label = segsToProcess[segIdx]?.label || '';

          const _customerIdForChrome = chromeBurnJobSpec?.customerId || reqCustomerId || 'c0';
          const useLegacyChrome = C0_LEGACY_OVERLAY_ONLY;

          // ── Universal chrome burn ─────────────────────────────────────────────
          let _directiveHandled = false;
          if (
            !useLegacyChrome &&
            USE_DIRECTIVE_CHROME &&
            assemblyJobId &&
            hasDirectiveForJob(assemblyJobId) &&
            (segTypes[segIdx] || 'avatar') === 'avatar'
          ) {
            try {
              const _directive = loadDirectiveForJob(assemblyJobId);
              const scene = _directive.scenes.find((s) => s.id === label || s.id === label.trim());
              if (scene) {
                try {
                  const _forceSidebarForC0 =
                    process.env.FORCE_SIDEBAR_VISIBLE !== 'false' &&
                    process.env.C0_FORCE_SIDEBAR_VISIBLE !== 'false';
                  const sceneForBurn = JSON.parse(JSON.stringify(scene));
                  if (_forceSidebarForC0) {
                    sceneForBurn.sidebar = sceneForBurn.sidebar || {};
                    sceneForBurn.sidebar.visible = true;
                  }
                  inputForTS = await burnSceneChromeFromDirective(
                    sceneForBurn,
                    inputForTS,
                    asmId,
                    assemblyJobId
                  );
                  log(
                    asmId,
                    `  🎨 Chrome directive burn ok scene=${label} sidebarVisible=${sceneForBurn?.sidebar?.visible !== false}`
                  );
                  _directiveHandled = true;
                } catch (e) {
                  log(
                    asmId,
                    `  ⚠️  Directive chrome burn failed (falling back to universal): ${e.message}`
                  );
                }
              } else {
                log(
                  asmId,
                  `  ℹ️  No directive found for scene "${label}" — using universal chrome`
                );
              }
            } catch (e) {
              log(
                asmId,
                `  ⚠️  Directive sidecar load failed (falling back to universal): ${e.message}`
              );
            }
          }

          if (!_directiveHandled) {
            try {
              const chromeSkin =
                chromeBurnJobSpec?.designSpec?.chrome?.skin || contentType || 'news';
              const currentSegType = segTypes[segIdx] || 'avatar';
              const sceneItems = chromeBurnJobSpec?.designSpec?.sceneStructure?.items || [];
              const inputItems = chromeBurnJobSpec?.order?.inputs?.items || [];
              const prettyLabel = (raw) =>
                String(raw || '')
                  .replace(/[_-]+/g, ' ')
                  .replace(/\s+/g, ' ')
                  .replace(
                    /\b(INTRO|REACT|REACTION|CLIP|OUTRO|COLD OPEN|SETUP|SUMMARY|NARRATION)\b/gi,
                    ''
                  )
                  .trim();
              const isPlaceholder = (raw) =>
                /^(story|item|game)\s*\d*$/i.test(String(raw || '').trim());
              const _ctKeyForDefault =
                chromeSkin === 'twitch'
                  ? 'clips'
                  : chromeSkin === 'nba'
                    ? 'sports'
                    : chromeSkin || 'news';
              let defaultCategory;
              try {
                const { loadCustomerConfig: _lcDef } = require('./job_spec');
                const _ccDef = _lcDef(chromeBurnJobSpec?.customerId || reqCustomerId || 'c0');
                defaultCategory = _ccDef?.designDefaults?.voice?.categoryLabel?.[_ctKeyForDefault];
              } catch (_e) {}
              if (!defaultCategory)
                defaultCategory =
                  chromeSkin === 'twitch'
                    ? 'ON STREAM'
                    : chromeSkin === 'nba'
                      ? 'NBA GAME'
                      : 'WORLD NEWS';
              const normalizeCategory = (raw) => {
                const cleaned = String(raw || '')
                  .trim()
                  .toUpperCase();
                if (!cleaned || /^(CONTENT|STORY|ITEM|GAME)\s*\d*$/i.test(cleaned))
                  return defaultCategory;
                return cleaned;
              };

              // Parse matchup from NBA scene labels
              const titleFromSceneLabel = (raw) => {
                if (!raw) return null;
                const s = String(raw).toUpperCase();
                const vsIdx = s.indexOf('_VS_');
                if (vsIdx === -1) return null;
                const leftRaw = s.slice(0, vsIdx).replace(/^GAME\d+_/, '');
                const rightRaw = s
                  .slice(vsIdx + 4)
                  .replace(
                    /_(?:INTRO|CLIP|OUTRO|NARRATION|REACTION|REACT|SETUP|SUMMARY|COLD_OPEN).*$/i,
                    ''
                  );
                if (!leftRaw || !rightRaw) return null;
                const toTitle = (str) =>
                  String(str)
                    .replace(/_/g, ' ')
                    .toLowerCase()
                    .replace(/\b(nba|nfl|mlb|nhl)\b/gi, (x) => x.toUpperCase())
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                return `${toTitle(leftRaw)} vs ${toTitle(rightRaw)}`;
              };

              // Pre-scan segsToProcess for per-game matchups
              const nbaMatchupByIdx = {};
              if (chromeSkin === 'nba' && Array.isArray(segsToProcess)) {
                for (const seg of segsToProcess) {
                  const lab = String(seg?.label || '');
                  const gm = lab.match(/GAME(\d+)/i);
                  if (!gm) continue;
                  const ix = parseInt(gm[1], 10) - 1;
                  if (ix < 0 || nbaMatchupByIdx[ix]) continue;
                  const parsed = titleFromSceneLabel(lab);
                  if (parsed) nbaMatchupByIdx[ix] = parsed;
                }
              }

              const useInputFallbackItems = sceneItems.length === 0 && chromeSkin !== 'twitch';
              const specItems =
                sceneItems.length > 0
                  ? sceneItems
                  : useInputFallbackItems
                    ? inputItems.map((item, idx) => {
                        const labelForType =
                          chromeSkin === 'twitch'
                            ? item.displayName ||
                              item.streamer ||
                              item.username ||
                              `Streamer ${idx + 1}`
                            : chromeSkin === 'nba'
                              ? item.matchup || `${item.away || 'Away'} vs ${item.home || 'Home'}`
                              : item.title || item.headline || `Story ${idx + 1}`;
                        return {
                          label: labelForType,
                          category: defaultCategory,
                          sceneId: `item_${idx}`,
                          data: item,
                        };
                      })
                    : [];

              const epCountersPath = require('path').join(
                __dirname,
                '..',
                'data',
                'episode_counters.json'
              );
              let epNumRaw = 1;
              try {
                const epC = JSON.parse(fs.readFileSync(epCountersPath, 'utf8'));
                epNumRaw = epC[chromeSkin] || epC[contentType] || 1;
              } catch (e) {}
              const episodeNumber = assemblyJobs[asmId]?.episodeNumber || `Episode ${epNumRaw}`;

              let activeIdx = 0;
              if (specItems.length > 0) {
                const itemMatch =
                  label.match(/ITEM(\d+)/i) ||
                  label.match(/STORY(\d+)/i) ||
                  label.match(/GAME(\d+)/i);
                if (itemMatch) {
                  activeIdx = parseInt(itemMatch[1], 10) - 1;
                } else {
                  const labTrim = String(label || '').trim();
                  const bareOutro =
                    /^(NBA_)?OUTRO$/i.test(labTrim) ||
                    (/OUTRO$/i.test(labTrim) && !/GAME\d+/i.test(labTrim));
                  if (bareOutro) {
                    activeIdx = specItems.length - 1;
                  } else {
                    const namePart = label
                      .replace(
                        /[_ ](INTRO|REACT|REACTION|CLIP|OUTRO|COLD_OPEN|SETUP|SUMMARY|NARRATION).*$/i,
                        ''
                      )
                      .trim()
                      .toLowerCase()
                      .replace(/_/g, ' ');
                    const found = specItems.findIndex(
                      (item) =>
                        (item.label || '').toLowerCase() === namePart ||
                        (item.data?.displayName || '').toLowerCase() === namePart ||
                        (item.data?.twitchUsername || '').toLowerCase() === namePart
                    );
                    if (found >= 0) activeIdx = found;
                  }
                }
                activeIdx = Math.max(0, Math.min(activeIdx, specItems.length - 1));
              }

              let allStories;
              let overlayTitle;
              let activeCategory;

              if (specItems.length > 0) {
                allStories = specItems.map((item, idx) => ({
                  title:
                    (isPlaceholder(item.label) ? null : item.label) ||
                    item.data?.displayName ||
                    inputItems[idx]?.title ||
                    inputItems[idx]?.displayName ||
                    inputItems[idx]?.matchup ||
                    nbaMatchupByIdx[idx] ||
                    titleFromSceneLabel(item.label) ||
                    `Item ${idx + 1}`,
                  category: normalizeCategory(item.category),
                  storyId: item.sceneId || `item_${idx}`,
                  fact: item.data?.fact || item.data?.matchup || '',
                }));
                const activeItem = specItems[activeIdx] || {};
                overlayTitle =
                  (isPlaceholder(activeItem.label) ? null : activeItem.label) ||
                  activeItem.data?.displayName ||
                  inputItems[activeIdx]?.title ||
                  inputItems[activeIdx]?.displayName ||
                  inputItems[activeIdx]?.matchup ||
                  nbaMatchupByIdx[activeIdx] ||
                  titleFromSceneLabel(activeItem.label) ||
                  titleFromSceneLabel(label) ||
                  prettyLabel(label) ||
                  'CONTENT';
                activeCategory = normalizeCategory(activeItem.category);
              } else {
                if (chromeSkin !== 'twitch') {
                  console.error(
                    `[chrome-burn] specItems empty — rebuilding sidebar from inputItems. contentType=${contentType}`
                  );
                }
                allStories = (inputItems || []).slice(0, 8).map((item, idx) => ({
                  title: item?.title || item?.displayName || item?.matchup || `Item ${idx + 1}`,
                  category: normalizeCategory(item?.category),
                  storyId: `input_${idx}`,
                  fact: item?.fact || item?.matchup || '',
                }));
                overlayTitle = allStories[activeIdx]?.title || prettyLabel(label) || 'CONTENT';
                activeCategory = allStories[activeIdx]?.category || defaultCategory;
              }

              const _ctForChrome =
                chromeSkin === 'twitch' ? 'clips' : chromeSkin === 'nba' ? 'sports' : chromeSkin;
              const _frozenChromeCfg = chromeBurnJobSpec?.designSpec?.chrome?.resolvedCfg;
              let _chromeCfg;
              let _chromeCfgSource = 'live';
              if (_frozenChromeCfg && typeof _frozenChromeCfg === 'object') {
                _chromeCfg = JSON.parse(JSON.stringify(_frozenChromeCfg));
                _chromeCfgSource = 'frozen';
              } else {
                const { loadCustomerConfig: _loadCC } = require('./job_spec');
                const _customerId = chromeBurnJobSpec?.customerId || 'c0';
                const _custConfig = _loadCC(_customerId);
                _chromeCfg = resolveChromeCfg(_custConfig, _ctForChrome);
              }
              try {
                const _cfgHash =
                  chromeBurnJobSpec?.designSpec?.chrome?.resolvedHash ||
                  fingerprintResolvedChromeCfg(_chromeCfg);
                log(asmId, `  🧾 Chrome cfg source=${_chromeCfgSource} hash=${_cfgHash}`);
              } catch (_e) {}

              const _categoryLabel = normalizeCategory(
                _chromeCfg.flag.categoryLabel[_ctForChrome] || activeCategory || defaultCategory
              );

              let _sidebarItems = allStories.slice(0, _chromeCfg.sidebar.maxItems).map((s) => ({
                title: s.title || '',
                category: s.category || _categoryLabel,
              }));
              const _sbCap = _chromeCfg.sidebar.maxItems || 5;
              if (
                chromeSkin === 'news' &&
                _sidebarItems.length > 0 &&
                _sidebarItems.length < _sbCap
              ) {
                while (_sidebarItems.length < _sbCap) {
                  _sidebarItems.push({ title: '\u2014', category: 'UP NEXT' });
                }
              }

              const _dateStr = new Date()
                .toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
                .toUpperCase();
              const _showName = _chromeCfg.name || 'CLIPZWORLD NEWS';

              const chromeParams = {
                showFlag: true,
                showSidebar: true,
                episodeNumber,
                showName: _showName,
                dateStr: _dateStr,
                flagCategory: _categoryLabel,
                flagTitle:
                  (() => {
                    const sceneTitle = prettyLabel(label);
                    if (
                      chromeSkin === 'twitch' &&
                      currentSegType !== 'source_clip' &&
                      /_CLIP\d*_(SETUP|REACTION)/i.test(String(label || ''))
                    ) {
                      return overlayTitle;
                    }
                    if (sceneTitle && !isPlaceholder(sceneTitle)) return sceneTitle;
                    return overlayTitle;
                  })() ||
                  allStories[activeIdx]?.title ||
                  'CONTENT',
                sidebarItems: _sidebarItems,
                activeIdx,
                contentType: _ctForChrome,
              };
              log(
                asmId,
                `  🎨 Chrome universal burn scene=${label} sidebarVisible=${chromeParams.showSidebar} sidebarItems=${_sidebarItems.length}`
              );

              let burnedPath = inputForTS.replace('.mp4', '_chrome.mp4');
              if (useLegacyChrome) {
                const storyData = {
                  title:
                    chromeParams.flagTitle ||
                    overlayTitle ||
                    allStories[activeIdx]?.title ||
                    'CONTENT',
                  category: _categoryLabel,
                  allStories: _sidebarItems.map((s) => ({
                    title: s.title || '',
                    category: s.category || _categoryLabel,
                  })),
                };
                burnedPath = await burnLegacyHtmlOverlay({
                  inputPath: inputForTS,
                  asmId,
                  sceneLabel: label,
                  contentType: _ctForChrome,
                  storyData,
                  activeIdx,
                  episodeNumber,
                  activeCategory: _categoryLabel,
                  suffix: 'legacy_chrome',
                });
              } else {
                await buildAndBurnChrome(inputForTS, chromeParams, _chromeCfg, burnedPath);
              }

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(
                  asmId,
                  `  🎨 Chrome burned [${activeIdx + 1}/${allStories.length}] skin=${chromeSkin}: ${overlayTitle || allStories[activeIdx]?.title || 'CONTENT'}`
                );
              }
            } catch (e) {
              log(asmId, `  ⚠️  Chrome burn failed (non-fatal): ${e.message} — using original`);
            }
          }

          // OUTRO freeze-hold (+0.75s clone)
          if (!isShortForm && label && label.toUpperCase().includes('OUTRO')) {
            try {
              const heldPath = path.join(TMP_DIR, `${asmId}_outro_held_${segIdx}.mp4`);
              await new Promise((res, rej) => {
                const args = [
                  '-i',
                  inputForTS,
                  '-vf',
                  'tpad=stop_mode=clone:stop_duration=0.75',
                  ...ffmpegEncodeArgs(true),
                  '-c:a',
                  'aac',
                  '-ar',
                  '44100',
                  '-ac',
                  '2',
                  '-y',
                  heldPath,
                ];
                const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
                proc.on('close', (code) =>
                  code === 0 ? res() : rej(new Error(`tpad freeze-hold failed: ${code}`))
                );
                proc.on('error', rej);
              });
              if (fs.existsSync(heldPath) && fs.statSync(heldPath).size > 10000) {
                inputForTS = heldPath;
                log(asmId, `  [OUTRO] freeze-hold applied (+0.75s): ${label}`);
              }
            } catch (e) {
              log(
                asmId,
                `  [WARN] OUTRO freeze-hold failed (non-fatal): ${e.message} -- using original`
              );
            }
          }

          const tsPath = inputForTS.replace(/\.[^.]+$/, '.ts');
          // Pre-validate size
          const inputSize = fs.existsSync(inputForTS) ? fs.statSync(inputForTS).size : 0;
          if (inputSize < CONFIG.VIDEO.MIN_SEGMENT_SIZE) {
            const errEntry = {
              ts: new Date().toISOString(),
              asmId,
              segment: segIdx + 1,
              file: path.basename(inputForTS),
              size: inputSize,
              error: 'Pre-TS size check failed',
            };
            try {
              fs.appendFileSync(
                path.join(__dirname, '..', 'logs', 'errors.jsonl'),
                JSON.stringify(errEntry) + '\n'
              );
            } catch (_) {}
            throw Object.assign(new Error(`Segment ${segIdx + 1} too small (${inputSize} bytes)`), {
              isSkippable: true,
            });
          }

          const _segCtKey =
            contentType === 'twitch'
              ? 'clips'
              : contentType === 'nba'
                ? 'sports'
                : (contentType || 'news').replace(/-short$/, '');
          const _asmCfg = chromeBurnJobSpec?.designSpec?.assembly?.[_segCtKey] || null;
          const sourceCropFilter = _asmCfg?.sourceCropFilter || 'crop=1920:1080,';
          const _watermarkBox = _asmCfg?.watermarkBox || null;
          const _watermarkEnabled = !!(_watermarkBox && _watermarkBox.enabled !== false);
          const watermarkFilter =
            _watermarkBox && _watermarkEnabled
              ? `,drawbox=x=${_watermarkBox.x}:y=${_watermarkBox.y}:w=${_watermarkBox.w}:h=${_watermarkBox.h}:color=${_watermarkBox.color}:t=fill`
              : '';

          const isAvatarSeg = (segTypes[segIdx] || 'avatar') !== 'source_clip';
          const _currentSeg = !isAvatarSeg
            ? segsToProcess.find((s, si) => inputForTS.includes(`${asmId}_${si}_`)) || null
            : null;
          const _needsPillarbox =
            !isAvatarSeg &&
            (_currentSeg?.pillarboxFilter || _currentSeg?.sourceOrientation === 'portrait');
          const _pillarboxVf = _needsPillarbox
            ? _currentSeg?.pillarboxFilter && typeof _currentSeg.pillarboxFilter === 'string'
              ? _currentSeg.pillarboxFilter
              : 'scale=iw*min(1920/iw\\,1080/ih):ih*min(1920/iw\\,1080/ih),pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black'
            : null;

          const chromeBurnedSegment = /_chrome\.mp4$/i.test(path.basename(inputForTS));
          const preserveBurnedOverlay = !isAvatarSeg && chromeBurnedSegment;
          const vfFilter = isAvatarSeg
            ? 'scale=1920:1080:flags=lanczos+accurate_rnd+full_chroma_int,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
            : preserveBurnedOverlay
              ? `scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30${watermarkFilter}`
              : _needsPillarbox
                ? `${_pillarboxVf},fps=fps=30${watermarkFilter}`
                : `scale=1920:1080:force_original_aspect_ratio=increase,${sourceCropFilter}scale=1920:1080,fps=fps=30${watermarkFilter}`;

          const clipIntroSkipSecs = _asmCfg?.clipIntroSkipSecs ?? 0;
          const clipMaxSecs = _asmCfg?.clipMaxSecs ?? null;
          const NEWS_CLIP_MAX_SECONDS = clipMaxSecs || 25;

          const baseArgs = [
            '-vf',
            vfFilter,
            '-pix_fmt',
            'yuv420p',
            ...ffmpegEncodeArgs(false),
            '-g',
            '30',
            '-keyint_min',
            '30',
            '-sc_threshold',
            '0',
            '-c:a',
            'aac',
            '-ar',
            '44100',
            '-ac',
            '2',
            '-af',
            'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
            '-bsf:v',
            'h264_mp4toannexb',
            '-f',
            'mpegts',
            '-y',
            tsPath,
          ];

          const buildTsArgs = async () => {
            if (clipIntroSkipSecs > 0 && !isAvatarSeg) {
              try {
                const silenceTrimDur = await computeNewsClipTrimDuration(inputForTS);
                const finalTrim =
                  silenceTrimDur && silenceTrimDur > 0 && silenceTrimDur < NEWS_CLIP_MAX_SECONDS
                    ? silenceTrimDur
                    : NEWS_CLIP_MAX_SECONDS;
                return [
                  '-ss',
                  String(clipIntroSkipSecs),
                  '-i',
                  inputForTS,
                  '-t',
                  finalTrim.toFixed(3),
                  ...baseArgs,
                ];
              } catch (trimErr) {
                return [
                  '-ss',
                  String(clipIntroSkipSecs),
                  '-i',
                  inputForTS,
                  '-t',
                  String(NEWS_CLIP_MAX_SECONDS),
                  ...baseArgs,
                ];
              }
            }
            return ['-i', inputForTS, ...baseArgs];
          };

          const tsArgs = await buildTsArgs();
          await new Promise((res, rej) => {
            const proc = execFile(ffmpegPath(), tsArgs, { maxBuffer: 20 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`TS convert failed: ${code}`))
            );
            proc.on('error', rej);
          });

          return tsPath;
        }; // end processSegmentToTs

        // Helper: voiceover V3 for a group's tsFiles
        const applyVoiceoverToGroup = async (groupTsFiles, groupSegTypes, groupSegMeta) => {
          const _asmCtKey =
            contentType === 'twitch'
              ? 'clips'
              : contentType === 'nba'
                ? 'sports'
                : (contentType || 'news').replace(/-short$/, '');
          const _voAsmCfg = chromeBurnJobSpec?.designSpec?.assembly?.[_asmCtKey] || {};
          if (_voAsmCfg.mixMode !== 'voiceover')
            return { files: groupTsFiles, types: groupSegTypes, meta: groupSegMeta };

          const voiceoverFiles = [...groupTsFiles];
          for (let i = 0; i < groupTsFiles.length - 1; i++) {
            const currType = groupSegTypes[i] || 'avatar';
            const nextType = groupSegTypes[i + 1] || 'avatar';
            if (currType !== 'avatar' || nextType !== 'source_clip') continue;

            const avatarTs = groupTsFiles[i];
            const clipTs = groupTsFiles[i + 1];
            const mixedTs = clipTs.replace('.ts', '_voiced.ts');
            const mutedAvatarTs = avatarTs.replace('.ts', '_muted.ts');

            // Probe clip duration with generous analyzeduration for mpegts
            let clipDuration = 0;
            try {
              clipDuration = await new Promise((res) => {
                execFile(
                  ffprobePath(),
                  [
                    '-fflags',
                    '+genpts',
                    '-analyzeduration',
                    '10000000',
                    '-probesize',
                    '10000000',
                    '-v',
                    'quiet',
                    '-show_entries',
                    'format=duration',
                    '-of',
                    'default=noprint_wrappers=1:nokey=1',
                    clipTs,
                  ],
                  { timeout: 15000 },
                  (err, stdout) => res(parseFloat(stdout) || 0)
                );
              });
            } catch (e) {
              /* 0 = ffmpeg decides */
            }

            // Step A: mute avatar (Bobby G visible, silent) — his voice plays as VO below
            try {
              await new Promise((res, rej) => {
                const proc = execFile(
                  ffmpegPath(),
                  [
                    '-i',
                    avatarTs,
                    '-c:v',
                    'copy',
                    '-af',
                    'volume=0',
                    '-c:a',
                    'aac',
                    '-ar',
                    '44100',
                    '-ac',
                    '2',
                    '-bsf:v',
                    'h264_mp4toannexb',
                    '-f',
                    'mpegts',
                    '-y',
                    mutedAvatarTs,
                  ],
                  { maxBuffer: 20 * 1024 * 1024 }
                );
                proc.on('close', (code) =>
                  code === 0 ? res() : rej(new Error(`Muted avatar failed: ${code}`))
                );
                proc.on('error', rej);
              });
              if (fs.existsSync(mutedAvatarTs) && fs.statSync(mutedAvatarTs).size > 5000) {
                voiceoverFiles[i] = mutedAvatarTs;
                log(asmId, `  🔇 Avatar muted — Bobby G visible, VO plays over clip`);
              }
            } catch (muteErr) {
              log(asmId, `  ⚠️  Avatar mute failed (keeping audio): ${muteErr.message}`);
            }

            // Step B: clip VO — Bobby G narration + music bed
            let narrationInput = avatarTs;
            const clipMeta = groupSegMeta[i + 1] || {};
            const clipTimingTargets = Array.isArray(clipMeta.clipTimingTargets)
              ? clipMeta.clipTimingTargets
              : [];
            if (clipDuration > 0 && clipTimingTargets.length > 0) {
              try {
                const timedNarrationPath = clipTs.replace('.ts', '_timed_narration.m4a');
                const timedNarration = await buildTimedNarrationTrack({
                  asmId,
                  avatarTs,
                  timingTargets: clipTimingTargets,
                  clipDuration,
                  outPath: timedNarrationPath,
                });
                if (timedNarration && fs.existsSync(timedNarration))
                  narrationInput = timedNarration;
              } catch (timingErr) {
                log(asmId, `  ⚠️  Timed narration fallback: ${timingErr.message}`);
              }
            }

            try {
              await new Promise((res, rej) => {
                const inputs = ['-i', clipTs, '-i', narrationInput];
                const musicVol = Math.min(
                  0.35,
                  Math.max(0.04, Number(_voAsmCfg.musicVolume) || 0.14)
                );
                const narrVol = Math.min(
                  4.5,
                  Math.max(1, Number(_voAsmCfg.narrationVolume) || 2.4)
                );
                let filterComplex, audioMap;
                if (_sharedMusicTrack) {
                  inputs.push('-stream_loop', '-1', '-i', _sharedMusicTrack);
                  filterComplex = [
                    '[0:a]volume=0[muted]',
                    `[1:a]volume=${narrVol.toFixed(2)},apad[narration]`,
                    `[2:a]volume=${musicVol.toFixed(2)}[music]`,
                    '[muted][narration][music]amix=inputs=3:duration=first:dropout_transition=0[aout]',
                  ].join(';');
                  audioMap = '[aout]';
                } else {
                  filterComplex = `[0:a]volume=0[muted];[1:a]volume=${narrVol.toFixed(2)},apad[narration];[muted][narration]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
                  audioMap = '[aout]';
                }
                const args = [
                  ...inputs,
                  '-filter_complex',
                  filterComplex,
                  '-map',
                  '0:v',
                  '-map',
                  audioMap,
                  ...(clipDuration > 0 ? ['-t', String(clipDuration.toFixed(3))] : []),
                  '-c:v',
                  'copy',
                  '-c:a',
                  'aac',
                  '-ar',
                  '44100',
                  '-ac',
                  '2',
                  '-bsf:v',
                  'h264_mp4toannexb',
                  '-f',
                  'mpegts',
                  '-y',
                  mixedTs,
                ];
                const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
                proc.on('close', (code) => {
                  if (code === 0) {
                    voiceoverFiles[i + 1] = mixedTs;
                    log(
                      asmId,
                      `  🎙 Voiced clip: ${path.basename(mixedTs)} (${clipDuration.toFixed(1)}s)`
                    );
                    res();
                  } else {
                    rej(new Error(`Voiceover V3 clip mix failed: ${code}`));
                  }
                });
                proc.on('error', rej);
              });
            } catch (e) {
              log(
                asmId,
                `  ⚠️  Voiceover V3 clip mix failed (non-fatal): ${e.message} — using original`
              );
            }
          }

          const voicedFiles = voiceoverFiles.filter((f) => f !== null);
          const voicedTypes = groupSegTypes.filter((_, i) => voiceoverFiles[i] !== null);
          const voicedMeta = groupSegMeta.filter((_, i) => voiceoverFiles[i] !== null);
          log(
            asmId,
            `  ✅ Voiceover V3 — ${voicedFiles.length} segs (${voicedTypes.filter((t) => t === 'avatar').length} avatar on screen)`
          );
          return { files: voicedFiles, types: voicedTypes, meta: voicedMeta };
        }; // end applyVoiceoverToGroup

        // Helper: concat TS files → MP4 (group-level or final, copy when all same codec)
        const concatTsToMp4 = async (tsList, outMp4, encodeAudio = true) => {
          if (tsList.length === 1) {
            const args = [
              '-i',
              tsList[0],
              '-c:v',
              'copy',
              '-c:a',
              'aac',
              '-ar',
              '44100',
              '-ac',
              '2',
              '-bsf:a',
              'aac_adtstoasc',
              '-movflags',
              '+faststart',
              '-y',
              outMp4,
            ];
            await new Promise((res, rej) => {
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', (code) =>
                code === 0 ? res() : rej(new Error(`Single-segment group encode failed: ${code}`))
              );
              proc.on('error', rej);
            });
            return;
          }
          const listPath = outMp4.replace(/\.[^.]+$/, '_concat_list.txt');
          fs.writeFileSync(
            listPath,
            tsList.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
          );
          const encArgs = encodeAudio
            ? [
                ...ffmpegEncodeArgs(false),
                '-c:a',
                'aac',
                '-ar',
                '44100',
                '-ac',
                '2',
                '-af',
                'aresample=async=1',
              ]
            : [
                '-c:v',
                'copy',
                '-c:a',
                'aac',
                '-ar',
                '44100',
                '-ac',
                '2',
                '-bsf:a',
                'aac_adtstoasc',
              ];
          const args = [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            listPath,
            ...encArgs,
            '-movflags',
            '+faststart',
            '-y',
            outMp4,
          ];
          await new Promise((res, rej) => {
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', (code) =>
              code === 0 ? res() : rej(new Error(`Group concat failed: ${code}`))
            );
            proc.on('error', rej);
          });
          try {
            fs.unlinkSync(listPath);
          } catch (_) {}
        }; // end concatTsToMp4

        // ── Main grouped assembly loop ────────────────────────────────────────────
        let tsSkipCount = 0;
        const groupMp4Paths = [];

        for (let gIdx = 0; gIdx < segGroups.length; gIdx++) {
          const group = segGroups[gIdx];
          log(
            asmId,
            `\n  📦 Group ${gIdx + 1}/${segGroups.length}: ${group.groupId} (${group.indices.length} segs)`
          );
          assemblyJobs[asmId].pct = Math.round(42 + (gIdx / segGroups.length) * 45);

          const groupLocalFiles = group.indices.map((i) => localFiles[i]).filter(Boolean);
          const groupSegTypes = group.indices
            .map((i) => segTypes[i] || 'avatar')
            .filter((_, k) => localFiles[group.indices[k]]);
          const groupSegMeta = group.indices
            .map((i) => localFileMeta[i] || null)
            .filter((_, k) => localFiles[group.indices[k]]);
          const groupSeqIndices = group.indices.filter((i) => localFiles[i]);

          if (groupLocalFiles.length === 0) {
            log(asmId, `  ⚠️  Group ${group.groupId} skipped — no downloaded files`);
            continue;
          }

          // TS normalize for this group
          const groupTsFiles = [];
          const groupTsTypes = [];
          const groupTsMeta = [];
          for (let k = 0; k < groupLocalFiles.length; k++) {
            const segIdx = groupSeqIndices[k]; // original index into segsToProcess
            try {
              const tsPath = await processSegmentToTs(groupLocalFiles[k], segIdx, k);
              if (
                fs.existsSync(tsPath) &&
                fs.statSync(tsPath).size > CONFIG.VIDEO.MIN_SEGMENT_SIZE
              ) {
                groupTsFiles.push(tsPath);
                groupTsTypes.push(groupSegTypes[k]);
                groupTsMeta.push(groupSegMeta[k]);
              } else {
                tsSkipCount++;
                log(asmId, `  ⚠️  Segment ${segIdx + 1} skipped (TS too small)`);
              }
            } catch (e) {
              const isSkippable =
                e.isSkippable || /255/.test(e.message) || /TS convert failed: 255/.test(e.message);
              const errEntry = {
                ts: new Date().toISOString(),
                asmId,
                segment: segIdx + 1,
                file: path.basename(groupLocalFiles[k]),
                error: e.message,
                skipped: isSkippable,
              };
              try {
                fs.appendFileSync(
                  path.join(__dirname, '..', 'logs', 'errors.jsonl'),
                  JSON.stringify(errEntry) + '\n'
                );
              } catch (_) {}
              if (isSkippable) {
                tsSkipCount++;
                log(asmId, `  ⚠️  Segment ${segIdx + 1} skipped (${e.message})`);
              } else {
                log(asmId, `  ❌ HARD FAIL segment ${segIdx + 1}: ${e.message}`);
                throw new Error(`TS normalize failed on segment ${segIdx + 1}: ${e.message}`);
              }
            }
            // populate flat tsFiles for Gate 3a and legacy code paths
            if (groupTsFiles.length > 0) {
              tsFiles.push(groupTsFiles[groupTsFiles.length - 1]);
              tsSegTypes.push(groupTsTypes[groupTsTypes.length - 1]);
              tsSegMeta.push(groupTsMeta[groupTsMeta.length - 1]);
            }
          }

          if (groupTsFiles.length === 0) {
            log(asmId, `  ⚠️  Group ${group.groupId} produced no TS files — skipping`);
            continue;
          }

          // Voiceover V3 for this group
          const voResult = await applyVoiceoverToGroup(groupTsFiles, groupTsTypes, groupTsMeta);

          // Concat group TS → group MP4
          const groupMp4 = path.join(TMP_DIR, `${asmId}_group_${gIdx}_${group.groupId}.mp4`);
          await concatTsToMp4(voResult.files, groupMp4, true);

          if (fs.existsSync(groupMp4) && fs.statSync(groupMp4).size > 10000) {
            groupMp4Paths.push(groupMp4);
            log(
              asmId,
              `  ✅ Group ${gIdx + 1}/${segGroups.length} done: ${path.basename(groupMp4)}`
            );
          } else {
            log(asmId, `  ⚠️  Group ${group.groupId} MP4 too small — skipping from stitch`);
          }
        }

        if (tsSkipCount > 0 && tsSkipCount > localFiles.length / 2) {
          throw new Error(
            `Assembly aborted: ${tsSkipCount}/${localFiles.length} segments were corrupt/truncated (>50% failure rate)`
          );
        }
        if (tsSkipCount > 0) {
          log(
            asmId,
            `  ⚠️  ${tsSkipCount} segment(s) skipped — assembly continues with ${groupMp4Paths.length} groups`
          );
        }

        // Keep tsSegTypes in sync with tsFiles for Gate 3a / downstream code
        if (tsSegTypes.length === tsFiles.length && tsFiles.length > 0) {
          segTypes.length = 0;
          tsSegTypes.forEach((t) => segTypes.push(t));
        }
        log(
          asmId,
          `  ✅ ${tsFiles.length} segments normalized across ${groupMp4Paths.length} groups`
        );

        // ── Step 5: Stitch group MP4s → final output ───────────────────────────
        log(asmId, `\n🎬 Stitching ${groupMp4Paths.length} groups → ${path.basename(outPath)}...`);
        assemblyJobs[asmId].pct = 90;

        if (groupMp4Paths.length === 0) {
          throw new Error('No group MP4s produced — assembly failed');
        }

        if (groupMp4Paths.length === 1) {
          // Only one group (e.g. short asset or single-story job) — rename directly
          fs.renameSync(groupMp4Paths[0], outPath);
        } else {
          // Multi-group stitch: concat demuxer, copy streams (groups already encoded)
          const stitchListPath = outPath.replace(/\.[^.]+$/, '_stitch_list.txt');
          const stitchContent = groupMp4Paths
            .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
            .join('\n');
          fs.writeFileSync(stitchListPath, stitchContent);
          const ffArgs = [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            stitchListPath,
            '-c',
            'copy', // no re-encode — groups are already h264/aac at target spec
            '-movflags',
            '+faststart',
            '-y',
            outPath,
          ];
          await new Promise((res, rej) => {
            const ff = execFile(ffmpegPath(), ffArgs, { maxBuffer: 50 * 1024 * 1024 });
            ff.stderr.on('data', (data) => {
              const line = data.toString();
              if (line.includes('Error') || line.includes('error') || line.includes('Invalid')) {
                log(asmId, `  [stitch] ${line.trim()}`);
              }
            });
            ff.on('close', (code) => {
              if (code === 0) res();
              else rej(new Error(`Final stitch FFmpeg exited with code ${code}`));
            });
            ff.on('error', rej);
          });
          try {
            fs.unlinkSync(stitchListPath);
          } catch (_) {}
        }

        // Probe final output duration for ticker overlay + telemetry
        let durations = [0];
        try {
          const finalDur = await probeDuration(outPath);
          durations = [Number.isFinite(finalDur) && finalDur > 0 ? finalDur : 0];
        } catch (_) {}

        // Step 6: Ticker overlay (if content type has a ticker and puppeteer is installed)
        // Shorts/reels never get a ticker
        // Note: isShortContent and tickerType are declared in outer scope above

        if (tickerType && TICKER_MAP[tickerType]) {
          log(asmId, `\n🎞  Baking ${tickerType} ticker overlay...`);
          assemblyJobs[asmId].pct = 92;
          try {
            const tickerPath = await captureTicker(tickerType);
            if (tickerPath && fs.existsSync(tickerPath)) {
              const tickeredFile = outFile.replace('.mp4', '_tickered.mp4');
              const tickeredPath = path.join(outDir, tickeredFile);
              const tickerTotalSec = durations.reduce((a, b) => a + b, 0);
              const timeoutMs = Math.max(60000, tickerTotalSec * 3 * 1000); // 3x video duration, min 60s
              await new Promise((res, rej) => {
                // Overlay ticker at bottom: y=H-${CONFIG.TICKER.HEIGHT} (ticker height from config)
                // eof_action=repeat loops the ticker when it ends (stream_loop -1 handles this too)
                // Do NOT use shortest=1 — it would truncate the output to ticker duration (20s)
                // -t tickerTotalSec: tells FFmpeg exactly when to stop — prevents stalling at end
                // -stream_loop -1: loops the ticker for the full video duration
                // eof_action=repeat: redundant safety net but harmless
                const args = [
                  '-i',
                  outPath,
                  '-stream_loop',
                  '-1',
                  '-i',
                  tickerPath,
                  '-t',
                  (tickerTotalSec + 2.0).toFixed(3), // +2s buffer prevents outro truncation
                  '-filter_complex',
                  `[0:v][1:v]overlay=x=0:y=H-${CONFIG.TICKER.HEIGHT}:eof_action=repeat[vout]`,
                  '-map',
                  '[vout]',
                  '-map',
                  '0:a?',
                  '-c:v',
                  'libx264',
                  '-preset',
                  'fast',
                  '-c:a',
                  'aac',
                  '-movflags',
                  '+faststart',
                  '-y',
                  tickeredPath,
                ];
                const ff2 = require('child_process').execFile(ffmpegPath(), args, {
                  maxBuffer: 100 * 1024 * 1024,
                });

                // Watchdog — if no progress for 90s, kill and use un-tickered version
                let lastProgressAt = Date.now();
                const watchdog = setInterval(() => {
                  if (Date.now() - lastProgressAt > 90000) {
                    clearInterval(watchdog);
                    log(
                      asmId,
                      `⚠️  Ticker overlay stalled (no progress 90s) — killing and using un-tickered version`
                    );
                    try {
                      ff2.kill('SIGKILL');
                    } catch (e) {}
                  }
                }, 10000);

                // Hard timeout — absolute max
                const hardTimeout = setTimeout(() => {
                  clearInterval(watchdog);
                  log(
                    asmId,
                    `⚠️  Ticker overlay timeout (${Math.round(timeoutMs / 1000)}s) — using un-tickered version`
                  );
                  try {
                    ff2.kill('SIGKILL');
                  } catch (e) {}
                }, timeoutMs);

                ff2.stderr &&
                  ff2.stderr.on('data', (data) => {
                    lastProgressAt = Date.now(); // reset watchdog on any output
                    const line = data.toString();
                    const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
                    if (timeMatch) {
                      const parts = timeMatch[1].split(':');
                      const elapsed = +parts[0] * 3600 + +parts[1] * 60 + +parts[2];
                      const pct = Math.min(99, Math.round((elapsed / tickerTotalSec) * 100));
                      if (pct % 5 === 0)
                        log(
                          asmId,
                          `  🎞  Ticker overlay: ${timeMatch[1]} / ${Math.round(tickerTotalSec)}s (${pct}%)`
                        );
                      assemblyJobs[asmId].tickerPct = pct;
                    }
                  });
                ff2.on('close', (code) => {
                  clearInterval(watchdog);
                  clearTimeout(hardTimeout);
                  if (code === 0) {
                    // Replace original with tickered version
                    try {
                      fs.unlinkSync(outPath);
                    } catch (e) {}
                    fs.renameSync(tickeredPath, outPath);
                    log(asmId, `✅ Ticker baked in successfully`);
                    res();
                  } else {
                    log(
                      asmId,
                      `⚠️  Ticker overlay failed (code ${code}) — using un-tickered version`
                    );
                    try {
                      fs.unlinkSync(tickeredPath);
                    } catch (e) {}
                    res(); // non-fatal
                  }
                });
                ff2.on('error', (e) => {
                  clearInterval(watchdog);
                  clearTimeout(hardTimeout);
                  log(asmId, `⚠️  Ticker overlay error: ${e.message}`);
                  res();
                });
              });
            } else {
              log(asmId, `⚠️  Ticker not available — install puppeteer: npm install puppeteer`);
            }
          } catch (tickerErr) {
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
              const logoPos = CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS;
              const args = [
                '-i',
                outPath,
                '-i',
                logoPng,
                '-filter_complex',
                `[1:v]scale=${logoPos.size}:-1,format=rgba,colorchannelmixer=aa=${logoPos.opacity || 0.85}[logo];[0:v][logo]overlay=${logoPos.x}:${logoPos.y}[vout]`,
                '-map',
                '[vout]',
                '-map',
                '0:a?',
                '-c:v',
                'libx264',
                '-preset',
                'fast',
                '-crf',
                '18',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'copy',
                '-movflags',
                '+faststart',
                '-y',
                loggedFile,
              ];
              const ff = execFile(ffmpegPath(), args, { maxBuffer: 100 * 1024 * 1024 });
              ff.on('close', (code) => {
                if (code === 0) {
                  try {
                    fs.unlinkSync(outPath);
                  } catch (e) {}
                  fs.renameSync(loggedFile, outPath);
                  log(asmId, `✅ Logo bug burned in`);
                  res();
                } else {
                  log(asmId, `⚠️  Logo bug failed (code ${code}) — continuing without`);
                  try {
                    fs.unlinkSync(loggedFile);
                  } catch (e) {}
                  res();
                }
              });
              ff.on('error', (e) => {
                log(asmId, `⚠️  Logo bug error: ${e.message}`);
                res();
              });
            });
          } catch (logoErr) {
            log(asmId, `⚠️  Logo bug step failed: ${logoErr.message}`);
          }
        } else {
          log(asmId, `  ℹ️  Logo bug skipped — logo_cwn.png not found in ~/Downloads`);
        }

        // Step 6c: Banner/header intro card removed — logo overlay (Step 6b) is the only branding element.

        // Step 6.5: ffprobe validation — scan for corrupt frames or codec issues
        log(asmId, `\n🔬 Validating output video...`);
        try {
          await new Promise((res) => {
            const ffprobe = execFile(
              'ffprobe',
              [
                '-v',
                'error',
                '-select_streams',
                'v:0',
                '-show_entries',
                'stream=codec_name,r_frame_rate,avg_frame_rate,width,height',
                '-show_entries',
                'format=duration,size,bit_rate',
                '-of',
                'json',
                outPath,
              ],
              { maxBuffer: 5 * 1024 * 1024 },
              (err, stdout, stderr) => {
                if (err) {
                  log(asmId, `⚠️  ffprobe validation warning: ${err.message}`);
                } else {
                  try {
                    const info = JSON.parse(stdout);
                    const stream = info.streams && info.streams[0];
                    const fmt = info.format;
                    if (stream) {
                      log(
                        asmId,
                        `  ✓ Codec: ${stream.codec_name} | ${stream.width}x${stream.height} | ${stream.r_frame_rate} fps`
                      );
                    }
                    if (fmt) {
                      const dur = parseFloat(fmt.duration || 0);
                      const br = Math.round((fmt.bit_rate || 0) / 1000);
                      log(asmId, `  ✓ Duration: ${dur.toFixed(1)}s | Bitrate: ${br}kbps`);
                      if (dur < 10)
                        log(
                          asmId,
                          `⚠️  WARNING: Output is only ${dur.toFixed(1)}s — possible encoding failure`
                        );
                    }
                    if (stderr && stderr.includes('Invalid data')) {
                      log(asmId, `⚠️  Corrupt frames detected — video may stall in players`);
                    } else {
                      log(asmId, `  ✓ No corrupt frames detected`);
                    }
                  } catch (e) {}
                }
                res();
              }
            );
          });
        } catch (e) {
          log(asmId, `⚠️  Validation step failed: ${e.message}`);
        }

        // Step 7: Done
        const stat = fs.statSync(outPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        totalDur = durations.reduce((a, b) => a + b, 0).toFixed(1);

        log(asmId, `\n✅ Assembly complete!`);
        log(asmId, `  File: ${outFile}`);
        log(asmId, `  Size: ${sizeMB} MB | Duration: ~${totalDur}s`);

        assemblyJobs[asmId].pct = 100;
        assemblyJobs[asmId].status = 'ffmpeg_done'; // Gate 3 + Drive still pending — poller must not fire yet
        assemblyJobs[asmId].outputPath = outPath;
        assemblyJobs[asmId].filename = outFile;
        assemblyJobs[asmId].duration = totalDur;
        assemblyJobs[asmId].sizeMB = sizeMB;

        nrAssembly('AssemblyFfmpegComplete', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          assemblyBranch: 'long_form',
          outputFile: outFile,
          durationSec: Number(totalDur) || null,
          sizeMB: Number(sizeMB) || null,
          segmentCount: localFiles.length,
          jobStatusAfterEncode: 'ffmpeg_done',
        });

        // Persist ffmpeg_done state to DB (non-fatal)
        try {
          const { saveAssemblyJob: saveAsmJobDb } = require('./db');
          saveAsmJobDb(asmId, assemblyJobId || asmId, {
            contentType,
            format,
            status: 'complete',
            outPath,
            completedAt: Date.now(),
          });
        } catch (e) {}

        // Complete assembly metrics
        assemblyTimer
          .addData('outputFile', outFile)
          .addData('outputSizeMB', sizeMB)
          .addData('outputDurationSec', totalDur)
          .addData('segmentCount', localFiles.length);
        addStageMetrics(asmId, assemblyTimer.end());

        // Extract thumbnail frame at 15s (Bobby G's first clean delivery after cold open)
        const thumbFramePath = outPath.replace('.mp4', '_thumb.jpg');
        try {
          await new Promise((res, rej) => {
            const args = [
              '-ss',
              '15',
              '-i',
              outPath,
              '-vframes',
              '1',
              '-q:v',
              '2',
              '-y',
              thumbFramePath,
            ];
            execFile(ffmpegPath(), args, (err) => (err ? rej(err) : res()));
          });
          if (fs.existsSync(thumbFramePath) && fs.statSync(thumbFramePath).size > 1000) {
            assemblyJobs[asmId].thumbFrame = thumbFramePath;
            assemblyJobs[asmId].thumbFilename = path.basename(thumbFramePath);
            log(asmId, `🖼  Thumbnail frame extracted: ${path.basename(thumbFramePath)}`);
          }
        } catch (e) {
          log(asmId, `⚠️  Thumbnail frame extraction failed: ${e.message}`);
        }
        // Store per-segment durations so dashboard can build accurate chapter timestamps
        assemblyJobs[asmId].segmentDurations = durations;

        // Cleanup long-form intermediate segment files before handing off to Gate 3+
        localFiles.filter(Boolean).forEach((f) => {
          try {
            fs.unlinkSync(f);
          } catch (e) {}
        });
      } // end long-form else block (opened at LONG-FORM DETECTED)

      // ── Gate 3a + Gate 3b: Assembly QA (gate worker system) ─────────────────────
      // Gate 3a: Gemini watches 3 sample points of assembled video (qualitative)
      // Gate 3b: Claude commitment verification (analytical — reads reports, not video)
      // Both are non-fatal for now — hard fails surface to monitoring for escalation.
      const gate3Timer = new StageTimer(asmId, 'Gate 3 QA');
      const gate3aWorker = require('./portals/portal3a');
      const gate3bWorker = require('./portals/portal3b');
      const {
        saveGateResult: saveGR3,
        getJobSpec: getJS3,
        saveOutput: saveOut3,
      } = require('./job_spec');

      let g3JobSpec = null;
      const _g3LookupId = reqJobSpecId || assemblyJobId;
      if (_g3LookupId) {
        try {
          g3JobSpec = await getJS3(_g3LookupId);
        } catch (e) {}
      }
      // Fallback: try assemblyJobId directly if reqJobSpecId lookup failed
      if (!g3JobSpec && assemblyJobId && assemblyJobId !== _g3LookupId) {
        try {
          g3JobSpec = await getJS3(assemblyJobId);
        } catch (e) {}
      }
      if (!g3JobSpec) {
        const _g3IsShort = contentType?.includes('short') || format === 'portrait';
        g3JobSpec = {
          jobId: asmId,
          customerId: reqCustomerId,
          assembledPath: outPath,
          outputPath: outPath,
          templateId: _g3IsShort ? 'short-form' : 'long-form',
          contentType: contentType || 'news',
          order: {
            output: { format: format === 'portrait' ? '9:16' : '16:9' },
            formType: format === 'portrait' ? 'short' : 'long',
          },
          state: { gateResults: assemblyJobs[asmId]?.gateResults || {} },
          designSpec: reqDesignSpec || { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
          commitments: {
            assembly: {
              status: 'approved',
              summary: `Assemble ${contentType || 'news'} ${_g3IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
              issuedAt: new Date().toISOString(),
            },
          },
          deliverySpec: {
            platforms: publishPlatformsList(contentType),
            driveFolderId: process.env.DRIVE_FOLDER_ID || null,
            uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
            categoryId: categoryIdFromDesign,
            scheduledAt: null,
          },
          expectedSynth: expectedSynthFlag,
        };
      }

      Object.assign(g3JobSpec, { expectedSynth: expectedSynthFlag });

      // Attach assembled path for gate3a.canProduce()
      const g3JobSpecWithPath = { ...g3JobSpec, assembledPath: outPath, outputPath: outPath };
      const g3PriorReports = g3JobSpec?.state?.gateResults || {};

      // Persist assembledPath to the job spec record so gate3a preflight lookup
      // finds it — without this, canProduce fails because the c0_COMPACT_FETCH_
      // spec record never had assembledPath written to it.
      try {
        const { saveOutput: _saveAssembledPath } = require('./job_spec');
        await _saveAssembledPath(g3JobSpec.jobId, 'assembledPath', outPath);
        await _saveAssembledPath(g3JobSpec.jobId, 'outputPath', outPath);
      } catch (_aspErr) {
        /* non-fatal */
      }

      // Fire thumbnail generation in parallel with Gate 3a — Puppeteer render is independent of Gemini video review
      // By the time Gate 3a finishes (~45-60s), thumbnail is already on Drive
      const _specItemsThumb = reqDesignSpec?.sceneStructure?.items || [];
      const _thumbItemsParallel = _specItemsThumb.map((item) => ({
        title: item.label || item.data?.displayName || item.data?.title || item.data?.matchup || '',
        teams: item.data?.matchup || '',
        imageUrl: item.data?.imageUrl || item.data?.heroImageUrl || item.data?.thumbnailUrl || '',
      }));
      const _thumbJobSpecParallel = {
        jobId: asmId,
        customerId: reqCustomerId,
        templateId:
          contentType?.includes('short') || format === 'portrait' ? 'short-form' : 'long-form',
        contentType: contentType || 'news',
        order: { inputs: { items: _thumbItemsParallel } },
        state: { savedOutputs: { publishCopy: assemblyJobs[asmId]?.publishCopy || null } },
      };
      log(asmId, `🖼  Thumbnail generation started in parallel with Gate 3a...`);
      const _thumbnailPromise = (async () => {
        try {
          const { generateThumbnail: _gThumb } = require('./thumbnail');
          const thumbResult = await _gThumb(_thumbJobSpecParallel);
          if (thumbResult.ok && thumbResult.pngPath) {
            assemblyJobs[asmId].thumbnailPngPath = thumbResult.pngPath;
            log(asmId, `🖼  Designed thumbnail rendered: ${path.basename(thumbResult.pngPath)}`);
          }
          if (thumbResult.ok && thumbResult.driveUrl) {
            assemblyJobs[asmId].thumbnailDriveUrl = thumbResult.driveUrl;
            const { saveOutput: _saveThumb } = require('./job_spec');
            try {
              await _saveThumb(asmId, 'thumbnailDriveUrl', thumbResult.driveUrl);
            } catch (e) {}
            log(asmId, `🖼  Thumbnail on Drive: ${thumbResult.driveUrl.slice(0, 60)}...`);
          } else {
            log(asmId, `⚠️  Thumbnail skipped: ${thumbResult.error || 'unknown'}`);
          }
        } catch (e) {
          log(asmId, `⚠️  Thumbnail error (non-fatal): ${e.message}`);
        }
      })();

      // Synthetic qaResult for Drive upload gate check (replaces old geminiQACheck result)
      // Default: manual_review — Drive upload is NOT auto-allowed if Gemini skips (no API key, missing path)
      // Only set to 'pass' when Gate 3a actually runs AND returns a pass or pass_with_notes outcome
      let qaResult = {
        portal: 'portal3a',
        jobId: asmId,
        passed: false,
        outcome: 'manual_review',
        score: 65,
        sampleFindings: {},
        report: 'Gate 3a/3b gate worker system — awaiting gate run',
      };
      // Default gwG3aResult: manual_review so Gemini API error does NOT silently allow Drive upload
      let gwG3aResult = {
        portal: 'portal3a',
        jobId: asmId,
        passed: false,
        outcome: 'manual_review',
        score: 65,
        sampleFindings: {},
        ffmpegAlarm: { fired: false, targetTimestamp: null, issue: null },
        upstreamContext: {
          reviewedReports: [],
          confirmedClean: [],
          escalatedConcerns: [],
          downstreamHeadsUp: null,
        },
        completedAt: new Date().toISOString(),
      };
      let gwG3bResult = null;

      try {
        if (outPath && fs.existsSync(outPath)) {
          if (!gate2To3aReady) {
            log(asmId, `⛔ Gate 3a/3b blocked — Gate 2→3a handoff review did not pass`);
          } else {
            // Gate 3a — Gemini qualitative review
            if (gate3aWorker.canProduce(g3JobSpecWithPath).ready) {
              if (gate2ResultForGate3) {
                g3JobSpecWithPath.state = g3JobSpecWithPath.state || {};
                g3JobSpecWithPath.state.gateResults = {
                  ...(g3JobSpecWithPath.state.gateResults || {}),
                  gate2: gate2ResultForGate3,
                };
              }
              const g3aPreflight = preflightGateExecution({
                jobId: g3JobSpec.jobId,
                portal: 'portal3a',
                fallbackJobSpec: g3JobSpecWithPath,
              });
              if (g3aPreflight.softHeals.length > 0) {
                log(asmId, `🩹 Gate 3a preflight soft-heal: ${g3aPreflight.softHeals.join('; ')}`);
              }
              if (!g3aPreflight.ready) {
                log(asmId, `⚠️  Gate 3a prerequisites warning: ${g3aPreflight.reasons.join('; ')}`);
              }
              const runGate3aAttempt = async () => {
                // Always merge assembledPath/outputPath into the run spec — the preflight's
                // jobSpec comes from a synchronous in-memory lookup that lags the async DB
                // write, so g3aPreflight.jobSpec may not have assembledPath yet.
                const g3aRunSpec = {
                  ...(g3aPreflight.jobSpec || g3JobSpecWithPath),
                  assembledPath: outPath,
                  outputPath: outPath,
                };
                const priorReports3a = [
                  g3PriorReports.gate0 || null,
                  g3PriorReports.gate1 || null,
                  g3PriorReports.gate2 || null,
                ];
                const g3aAttemptResult = await gate3aWorker.run(
                  g3aRunSpec,
                  outPath,
                  priorReports3a
                );
                try {
                  await saveGR3(g3JobSpec.jobId, 'gate3a', g3aAttemptResult);
                } catch (e) {}
                emitGateResult(g3JobSpec, g3aAttemptResult, contentType);
                return g3aAttemptResult;
              };
              const g3aPolicyRun = await runUnifiedGatePolicy({
                ...assemblyUnifiedPolicyHooks(asmId),
                gateKey: 'gate3a',
                jobId: g3JobSpec.jobId,
                runWorkerAttempt: runGate3aAttempt,
                runInterventionAttempt: async () => 'no gate3a-specific intervention available',
                isPass: (r) => !!(r?.passed || r?.outcome === 'pass_with_notes'),
                persistStatus: async (policy) => saveOut3(g3JobSpec.jobId, 'gate3a_policy', policy),
              });
              gwG3aResult = g3aPolicyRun.result;
              log(asmId, `📋 Gate 3a: ${gwG3aResult.outcome} (${gwG3aResult.score}/100)`);

              assemblyJobs[asmId].gate3aScore = gwG3aResult.score;
              assemblyJobs[asmId].gate3aOutcome = gwG3aResult.outcome;
              gate3Timer
                .addData('gate3aScore', gwG3aResult.score)
                .addData('gate3aOutcome', gwG3aResult.outcome);

              // Persist gate3a score to DB (non-fatal)
              try {
                const { saveAssemblyJob: saveAsmJobDb } = require('./db');
                saveAsmJobDb(asmId, assemblyJobId || asmId, { gate3aScore: gwG3aResult.score });
              } catch (e) {}

              // Surface to drive-upload gate check
              if (gwG3aResult.passed || gwG3aResult.outcome === 'pass_with_notes') {
                qaResult = {
                  score: gwG3aResult.score,
                  outcome: 'pass',
                  passed: true,
                  report: `Gate 3a: ${gwG3aResult.outcome}`,
                };

                // Gate 3b — commitment verification (only if 3a passed)
                if (gate3bWorker.canProduce(g3JobSpec).ready) {
                  const g3bPreflight = preflightGateExecution({
                    jobId: g3JobSpec.jobId,
                    portal: 'portal3b',
                    fallbackJobSpec: g3JobSpec,
                  });
                  if (g3bPreflight.softHeals.length > 0) {
                    log(
                      asmId,
                      `🩹 Gate 3b preflight soft-heal: ${g3bPreflight.softHeals.join('; ')}`
                    );
                  }
                  if (!g3bPreflight.ready) {
                    log(
                      asmId,
                      `⚠️  Gate 3b prerequisites warning: ${g3bPreflight.reasons.join('; ')}`
                    );
                  }
                  const g3bRunSpec = g3bPreflight.jobSpec || g3JobSpec;
                  const priorReports3b = [
                    g3PriorReports.gate0 || null,
                    g3PriorReports.gate1 || null,
                    g3PriorReports.gate2 || null,
                  ];
                  gwG3bResult = await gate3bWorker.run(g3bRunSpec, gwG3aResult, priorReports3b);
                  try {
                    await saveGR3(g3JobSpec.jobId, 'gate3b', gwG3bResult);
                  } catch (e) {}
                  emitGateResult(g3JobSpec, gwG3bResult, contentType);
                  log(
                    asmId,
                    `📋 Gate 3b: ${gwG3bResult.outcome} — ${gwG3bResult.mismatches?.length || 0} mismatch(es)`
                  );
                  assemblyJobs[asmId].gate3bOutcome = gwG3bResult.outcome;

                  // Persist gate3b outcome to DB (non-fatal)
                  try {
                    const { saveAssemblyJob: saveAsmJobDb } = require('./db');
                    saveAsmJobDb(asmId, assemblyJobId || asmId, {
                      gate3bOutcome: gwG3bResult.outcome,
                    });
                  } catch (e) {}

                  // Gate 3b self-healing: attempt targeted chrome re-burn on fixable mismatches
                  if (
                    gwG3bResult &&
                    gwG3bResult.outcome === 'mismatch_fixable' &&
                    gwG3bResult.mismatches?.length > 0
                  ) {
                    const fixableMismatches = gwG3bResult.mismatches.filter((m) => m.fixable);
                    const chromeRelated = fixableMismatches.some(
                      (m) =>
                        m.field.includes('chrome') ||
                        m.field.includes('skin') ||
                        m.field.includes('logo')
                    );

                    if (chromeRelated) {
                      log(
                        asmId,
                        `🔧 Gate 3b: attempting targeted chrome re-burn for ${fixableMismatches.length} fixable mismatch(es)`
                      );
                      try {
                        pipelineBus.emit('pipeline:retry_attempt', {
                          jobId: g3JobSpec.jobId,
                          portal: 'portal3b',
                          stage: 'chrome_reburn_self_heal',
                          attempt: 1,
                          maxAttempts: 1,
                          mismatchFields: fixableMismatches.map((m) => m.field).slice(0, 16),
                        });
                      } catch (_e) {
                        /* non-fatal */
                      }
                      try {
                        // Build correct overlay from job spec designSpec using FFmpeg drawtext/drawbox
                        const baseContentType = (g3JobSpec.contentType || 'news').replace(
                          /-short$/,
                          ''
                        );
                        const _ctForReBurn =
                          baseContentType === 'twitch'
                            ? 'clips'
                            : baseContentType === 'nba'
                              ? 'sports'
                              : baseContentType;
                        const _frozenReBurnCfg = g3JobSpec?.designSpec?.chrome?.resolvedCfg;
                        const _chromeCfgReBurn =
                          _frozenReBurnCfg && typeof _frozenReBurnCfg === 'object'
                            ? JSON.parse(JSON.stringify(_frozenReBurnCfg))
                            : (() => {
                                const { loadCustomerConfig } = require('./job_spec');
                                const custConfig = loadCustomerConfig(g3JobSpec.customerId || 'c0');
                                return resolveChromeCfg(custConfig, _ctForReBurn);
                              })();
                        const episodeNumber = assemblyJobs[asmId]?.episodeNumber || 'Episode 1';
                        const _allStoriesReBurn = assemblyJobs[asmId]?.allStories || [
                          {
                            title: 'Story',
                            category: _ctForReBurn.toUpperCase(),
                            storyId: 'story_0',
                          },
                        ];

                        const _reburnParams = {
                          showFlag: true,
                          showSidebar: true,
                          episodeNumber,
                          showName: _chromeCfgReBurn.name || 'CLIPZWORLD NEWS',
                          dateStr: new Date()
                            .toLocaleDateString('en-US', {
                              month: 'long',
                              day: 'numeric',
                              year: 'numeric',
                            })
                            .toUpperCase(),
                          flagCategory:
                            _chromeCfgReBurn.flag.categoryLabel[_ctForReBurn] ||
                            _ctForReBurn.toUpperCase(),
                          flagTitle: _allStoriesReBurn[0]?.title || 'CONTENT',
                          sidebarItems: _allStoriesReBurn
                            .slice(0, _chromeCfgReBurn.sidebar.maxItems)
                            .map((s) => ({
                              title: s.title || '',
                              category: s.category || _ctForReBurn.toUpperCase(),
                            })),
                          activeIdx: 0,
                          contentType: _ctForReBurn,
                        };

                        let correctedVideoPath = outPath.replace('.mp4', '_g3b_corrected.mp4');
                        const _useLegacyReBurn = C0_LEGACY_OVERLAY_ONLY;
                        if (_useLegacyReBurn) {
                          const _storyDataReBurn = {
                            title: _reburnParams.flagTitle || 'CONTENT',
                            category: _reburnParams.flagCategory || _ctForReBurn.toUpperCase(),
                            allStories: (_reburnParams.sidebarItems || []).map((s) => ({
                              title: s.title || '',
                              category: s.category || _ctForReBurn.toUpperCase(),
                            })),
                          };
                          correctedVideoPath = await burnLegacyHtmlOverlay({
                            inputPath: outPath,
                            asmId,
                            sceneLabel: 'gate3b_reburn',
                            contentType: _ctForReBurn,
                            storyData: _storyDataReBurn,
                            activeIdx: _reburnParams.activeIdx || 0,
                            episodeNumber,
                            activeCategory:
                              _reburnParams.flagCategory || _ctForReBurn.toUpperCase(),
                            suffix: 'g3b_corrected_legacy',
                          });
                        } else {
                          await buildAndBurnChrome(
                            outPath,
                            _reburnParams,
                            _chromeCfgReBurn,
                            correctedVideoPath
                          );
                        }

                        {
                          if (
                            fs.existsSync(correctedVideoPath) &&
                            fs.statSync(correctedVideoPath).size > 100000
                          ) {
                            try {
                              fs.unlinkSync(outPath);
                            } catch (e) {}
                            fs.renameSync(correctedVideoPath, outPath);
                            log(
                              asmId,
                              `✅ Gate 3b: chrome re-burn complete — re-running Gate 3a to confirm`
                            );

                            // Re-run Gate 3a to confirm fix
                            try {
                              const reRunG3a = await gate3aWorker.run(
                                g3JobSpec,
                                outPath,
                                priorReports3a
                              );
                              if (reRunG3a.passed || reRunG3a.outcome === 'pass_with_notes') {
                                gwG3aResult = reRunG3a;
                                gwG3bResult = {
                                  ...gwG3bResult,
                                  outcome: 'pass',
                                  mismatches: [],
                                  selfHealed: true,
                                };
                                log(
                                  asmId,
                                  `✅ Gate 3b: self-heal confirmed — Gate 3a re-check: ${reRunG3a.score}/100`
                                );
                                try {
                                  const { recordAutomationSelfHeal } = require('./job_spec');
                                  recordAutomationSelfHeal(g3JobSpec.jobId, 'gate3b_chrome_reburn');
                                } catch (_e) {
                                  /* non-fatal */
                                }
                                try {
                                  await saveGR3(g3JobSpec.jobId, 'gate3a', reRunG3a);
                                } catch (e) {}
                                try {
                                  await saveGR3(g3JobSpec.jobId, 'gate3b', gwG3bResult);
                                } catch (e) {}
                              } else {
                                log(
                                  asmId,
                                  `⚠️  Gate 3b: re-burn applied but Gate 3a re-check still failed (${reRunG3a.score}/100) — proceeding`
                                );
                              }
                            } catch (reRunErr) {
                              log(
                                asmId,
                                `⚠️  Gate 3b: Gate 3a re-check error: ${reRunErr.message} — using original result`
                              );
                            }
                          }
                          // No PNG temp file to clean up — FFmpeg drawtext/drawbox generates no intermediate files
                        }
                      } catch (reburnErr) {
                        log(
                          asmId,
                          `⚠️  Gate 3b: chrome re-burn failed (non-fatal): ${reburnErr.message} — proceeding with original`
                        );
                        logError('GATE3B_REBURN_FAIL', reburnErr.message, {
                          asmId,
                          jobId: g3JobSpec.jobId,
                        });
                        // Clean up any partial/empty output file left by failed FFmpeg burn
                        if (correctedVideoPath) {
                          try {
                            if (
                              fs.existsSync(correctedVideoPath) &&
                              fs.statSync(correctedVideoPath).size < 100000
                            ) {
                              fs.unlinkSync(correctedVideoPath);
                            }
                          } catch (_cleanErr) {
                            /* non-fatal */
                          }
                        }
                      }
                    }
                  }
                  const g3bPostSpec = {
                    ...g3bRunSpec,
                    state: {
                      ...(g3bRunSpec?.state || {}),
                      gateResults: {
                        ...(g3bRunSpec?.state?.gateResults || {}),
                        gate3a: gwG3aResult,
                        gate3b: gwG3bResult,
                      },
                    },
                  };
                  const g3bHandoff = await persistGateHandoffReview({
                    asmId,
                    jobSpec: g3JobSpec,
                    fromGate: 'gate3b',
                    nextGate: 'gate4',
                    gateResult: gwG3bResult,
                    fallbackJobSpec: g3bPostSpec,
                  });
                  gate3To4Ready = !!g3bHandoff.passed;
                } else {
                  log(asmId, `⚠️  Gate 3b: commitments empty — skipping`);
                  gate3To4Ready = false;
                }
              } else if (gwG3aResult.outcome === 'hard_fail') {
                log(
                  asmId,
                  `❌ Gate 3a hard fail — ${gwG3aResult.ffmpegAlarm?.issue || 'quality check failed'} — monitoring will escalate`
                );
                qaResult = {
                  score: gwG3aResult.score,
                  outcome: 'fail',
                  passed: false,
                  report: `Gate 3a hard fail: ${gwG3aResult.ffmpegAlarm?.issue || 'quality check failed'}`,
                };
                gate3To4Ready = false;
              }
            } else {
              log(
                asmId,
                `⚠️  Gate 3a: GEMINI_API_KEY not set or assembled path unavailable — skipping`
              );
              gate3To4Ready = false;
            }
          }
        } else {
          log(asmId, `⚠️  Gate 3a/3b: assembled video not found at ${outPath} — skipping`);
          gate3To4Ready = false;
        }
      } catch (g3Err) {
        log(asmId, `⚠️  Gate 3a/3b error: ${g3Err.message} — downstream gates will be blocked`);
        logError('GATE3_QA_ERROR_FALLBACK', g3Err.message, { asmId });
        gate3To4Ready = false;
      }

      // Store gate 3 score on assemblyJobs for downstream checks
      assemblyJobs[asmId].qaScore = qaResult.score;
      assemblyJobs[asmId].qaOutcome = qaResult.outcome;
      gate3Timer.addData('score', qaResult.score).addData('outcome', qaResult.outcome);
      addStageMetrics(asmId, gate3Timer.end());

      // Finalize all job metrics now that Gate 3 is complete
      finalizeJobMetrics(asmId);

      nrAssembly('AssemblyGate3Summary', {
        assemblyId: asmId,
        sourceJobId: assemblyJobId || null,
        jobSpecId: reqJobSpecId || null,
        contentType: contentType || null,
        gate3Score: qaResult.score ?? null,
        gate3Outcome: qaResult.outcome || null,
      });

      // Log final Gate 3 outcome
      if (qaResult.outcome === 'fail') {
        log(asmId, `❌ Gate 3 HARD FAIL (score: ${qaResult.score}/100) — Drive upload blocked`);
      } else {
        log(asmId, `✅ Gate 3 PASSED (score: ${qaResult.score}/100) — proceeding to Drive upload`);
      }

      // Step 8: Auto-upload to Google Drive (blocked on hard QA fail)
      if (process.env.SKIP_DRIVE_UPLOAD === 'true') {
        const _skipLocalUrl = `http://localhost:${process.env.PORT || 3000}/download/${outFile}`;
        log(asmId, `\n☁️  Drive upload skipped (SKIP_DRIVE_UPLOAD=true in .env)`);
        log(asmId, `📥 Download locally: ${_skipLocalUrl}`);
        assemblyJobs[asmId].driveUrl = assemblyJobs[asmId].driveUrl || _skipLocalUrl;
        nrAssembly('AssemblyDriveUploadSkipped', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          reason: 'SKIP_DRIVE_UPLOAD',
        });
      } else if (assemblyJobs[asmId].qaOutcome === 'fail') {
        log(asmId, `\n☁️  Drive upload BLOCKED — QA hard fail. Fix issues then re-assemble.`);
        nrAssembly('AssemblyDriveUploadSkipped', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          reason: 'gate3_hard_fail',
        });
      } else {
        log(asmId, `\n☁️  Uploading to Google Drive...`);
        nrAssembly('AssemblyDriveUploadStart', {
          assemblyId: asmId,
          sourceJobId: assemblyJobId || null,
          contentType: contentType || null,
          fileName: outFile,
        });
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
            nrAssembly('AssemblyDriveUploadOk', {
              assemblyId: asmId,
              sourceJobId: assemblyJobId || null,
              contentType: contentType || null,
              hasDriveUrl: true,
            });

            // Gate 4/5 runs after the Drive upload section below, regardless of Drive outcome
          } else {
            log(asmId, `⚠️  Drive upload skipped — add cwn-drive-key.json to enable`);
            nrAssembly('AssemblyDriveUploadFail', {
              assemblyId: asmId,
              sourceJobId: assemblyJobId || null,
              contentType: contentType || null,
              reason: 'upload_returned_null',
            });
            // Drive unavailable — fall back to local URL so Gate 4/5 + job card still work
            const localUrl = `http://localhost:${process.env.PORT || 3000}/download/${outFile}`;
            assemblyJobs[asmId].localUrl = localUrl;
            assemblyJobs[asmId].driveUrl = assemblyJobs[asmId].driveUrl || localUrl;
          }
        } catch (driveErr) {
          log(asmId, `⚠️  Drive upload failed: ${driveErr.message}`);
          nrAssembly('AssemblyDriveUploadFail', {
            assemblyId: asmId,
            sourceJobId: assemblyJobId || null,
            contentType: contentType || null,
            reason: 'exception',
            error: (driveErr.message || '').slice(0, 500),
          });
          // Drive failed — fall back to local URL so publish flow isn't completely blocked
          const localUrl = `http://localhost:${process.env.PORT || 3000}/download/${outFile}`;
          assemblyJobs[asmId].localUrl = localUrl;
          assemblyJobs[asmId].driveUrl = assemblyJobs[asmId].driveUrl || localUrl;
          log(asmId, `📥 Local fallback URL: ${localUrl}`);
        }
      } // end SKIP_DRIVE_UPLOAD else

      // Set final terminal status — poller fires only after this point
      if (assemblyJobs[asmId].status === 'ffmpeg_done') {
        const qaOutcome = assemblyJobs[asmId].qaOutcome;
        if (qaOutcome === 'fail') {
          assemblyJobs[asmId].status = 'failed'; // Gate 3 hard fail — poller will record this
          saveAssemblyJob(asmId);
        } else {
          assemblyJobs[asmId].status = 'done'; // Gate 3 pass or no QA result
          saveAssemblyJob(asmId);
        }
      }

      // (Intermediate file cleanup and else-block close moved above Gate 3+ section
      //  so Gate 3 → Gate 4 → Gate 5 runs for both short-form AND long-form jobs.)

      // ── Gate 4 + Gate 5: run after Drive upload, regardless of Drive outcome ─────────────
      // assemblyJobs[asmId].driveUrl is always set: real Drive URL, localhost fallback, or null.
      // Gate 4 only needs the local assembled file (outPath); Gate 5 needs a public URL.
      // Gate 5 will gracefully fail if Drive is unavailable — Gate 4 still gives broadcast signal.
      if (assemblyJobs[asmId].qaOutcome !== 'fail' && outPath) {
        // Use whatever URL was set during Drive upload (real or fallback)
        const driveUrl = assemblyJobs[asmId].driveUrl;

        // Generate publish copy BEFORE Gate 4/5 — Gate 5 needs title for Upload-Post
        // Skip if already locked at Gate 1 pass (publishCopy in jobSpec or assemblyJobs card)
        const _existingPublishCopy = assemblyJobs[asmId]?.publishCopy || null;
        if (_existingPublishCopy) {
          log(asmId, `  ✅ Publish copy already locked from Gate 1 — skipping regeneration`);
          log(
            asmId,
            `     Title: "${_existingPublishCopy.youtube?.title || _existingPublishCopy.youtube?.titles?.[0] || 'n/a'}"`
          );
        } else {
          try {
            const publishCopyResp = await axios.post(
              `http://localhost:${process.env.PORT || 3000}/generate-publish-copy`,
              {
                contentType: contentType || 'twitch',
                formType: contentType && contentType.includes('-short') ? 'short' : 'compilation',
                script: fullScript || assemblyJobs[asmId]?.fullScript || '',
                date: new Date().toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                }),
                streamers: req.body.streamers || [],
                platforms: publishPlatformsList(contentType),
              },
              { timeout: 60000 }
            );
            if (publishCopyResp.data && !publishCopyResp.data.error) {
              assemblyJobs[asmId].publishCopy = publishCopyResp.data;
              log(
                asmId,
                `  ✅ Publish copy generated: "${publishCopyResp.data.youtube?.title || publishCopyResp.data.title || 'n/a'}"`
              );
              const _saveId = assemblyJobId || asmId;
              try {
                const { saveOutput: _pcSave } = require('./job_spec');
                await _pcSave(_saveId, 'publishCopy', publishCopyResp.data);
              } catch (e) {}
            }
          } catch (pcErr) {
            log(asmId, `  ⚠️  Publish copy generation failed (non-fatal): ${pcErr.message}`);
          }
        }

        // ── Gate 4 + Gate 5 (gate worker system) ─────────────────────────────────
        // Gate 4: Gemini full-video broadcast ready check (only if gate3b passed)
        // Gate 5: Upload confirmation (only fires if gate4.uploadSignal === true)
        try {
          const gate4Worker = require('./portals/portal4');
          // Ensure thumbnail promise is settled before Gate 4 checks thumbnailDriveUrl
          await _thumbnailPromise;

          const gate5Worker = require('./portals/portal5');
          const {
            saveGateResult: saveGR45,
            saveOutput: saveOut45,
            getJobSpec: getJS45,
          } = require('./job_spec');

          let g45JobSpec = null;
          const _g45LookupId = reqJobSpecId || assemblyJobId;
          if (_g45LookupId) {
            try {
              g45JobSpec = await getJS45(_g45LookupId);
            } catch (e) {}
          }
          // Fallback: try assemblyJobId directly if reqJobSpecId lookup failed
          if (!g45JobSpec && assemblyJobId && assemblyJobId !== _g45LookupId) {
            try {
              g45JobSpec = await getJS45(assemblyJobId);
            } catch (e) {}
          }
          if (!g45JobSpec) {
            const _g45IsShort = contentType?.includes('short') || format === 'portrait';
            g45JobSpec = {
              jobId: asmId,
              customerId: reqCustomerId,
              assembledPath: outPath,
              outputPath: outPath,
              driveUrl,
              templateId: _g45IsShort ? 'short-form' : 'long-form',
              contentType: contentType || 'news',
              order: {
                output: { format: format === 'portrait' ? '9:16' : '16:9' },
                formType: format === 'portrait' ? 'short' : 'long',
                publish: {
                  platforms: publishPlatformsList(contentType),
                  driveUrl,
                },
              },
              state: {
                gateResults: {},
                savedOutputs: {
                  assembledPath: outPath,
                  driveUrl,
                  thumbnailDriveUrl: assemblyJobs[asmId]?.thumbnailDriveUrl || null,
                },
              },
              designSpec: reqDesignSpec || { chrome: {}, audio: {}, resolution: {}, ffmpeg: {} },
              commitments: {
                assembly: {
                  status: 'approved',
                  summary: `Assemble ${contentType || 'news'} ${_g45IsShort ? 'short-form 9:16' : 'long-form 16:9'} video with newscast chrome`,
                  issuedAt: new Date().toISOString(),
                },
              },
              deliverySpec: {
                platforms: publishPlatformsList(contentType),
                driveFolderId: process.env.DRIVE_FOLDER_ID || null,
                uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
                categoryId: categoryIdFromDesign,
                scheduledAt: null,
              },
              expectedSynth: expectedSynthFlag,
            };
          }
          Object.assign(g45JobSpec, { expectedSynth: expectedSynthFlag });
          // Inject publishCopy and thumbnailDriveUrl into g45JobSpec.state.savedOutputs
          // so Gate 5 can read them without requiring a DB round-trip
          const _publishCopy = assemblyJobs[asmId]?.publishCopy || null;
          const _thumbDriveUrl = assemblyJobs[asmId]?.thumbnailDriveUrl || null;
          if (g45JobSpec.state?.savedOutputs) {
            if (_publishCopy) g45JobSpec.state.savedOutputs.publishCopy = _publishCopy;
            if (_thumbDriveUrl) g45JobSpec.state.savedOutputs.thumbnailDriveUrl = _thumbDriveUrl;
          }
          const g45JobSpecWithPath = {
            ...g45JobSpec,
            assembledPath: outPath,
            outputPath: outPath,
            driveUrl,
          };
          // Persist driveUrl to job spec
          try {
            await saveOut45(g45JobSpec.jobId, 'driveUrl', driveUrl);
          } catch (e) {}

          const g45PriorReports = g45JobSpec?.state?.gateResults || {};
          const priorReports45 = [
            g45PriorReports.gate0 || null,
            g45PriorReports.gate1 || null,
            g45PriorReports.gate2 || null,
            gwG3aResult || g45PriorReports.gate3a || null,
            gwG3bResult || g45PriorReports.gate3b || null,
          ];

          // Gate 4 — full video broadcast ready
          if (!gate3To4Ready) {
            log(asmId, `⛔ Gate 4/5 blocked — Gate 3b→4 handoff review did not pass`);
          } else if (gate4Worker.canProduce(g45JobSpecWithPath).ready) {
            const g4Preflight = preflightGateExecution({
              jobId: g45JobSpec.jobId,
              portal: 'portal4',
              fallbackJobSpec: g45JobSpecWithPath,
            });
            if (g4Preflight.softHeals.length > 0) {
              log(asmId, `🩹 Gate 4 preflight soft-heal: ${g4Preflight.softHeals.join('; ')}`);
            }
            if (!g4Preflight.ready) {
              log(asmId, `⚠️  Gate 4 prerequisites warning: ${g4Preflight.reasons.join('; ')}`);
            }
            const runGate4Attempt = async () => {
              const g4RunSpecAttempt = g4Preflight.jobSpec || g45JobSpecWithPath;
              const g4AttemptResult = await gate4Worker.run(
                g4RunSpecAttempt,
                outPath,
                priorReports45
              );
              try {
                await saveGR45(g45JobSpec.jobId, 'gate4', g4AttemptResult);
              } catch (e) {}
              emitGateResult(g45JobSpec, g4AttemptResult, contentType);
              return g4AttemptResult;
            };
            const g4PolicyRun = await runUnifiedGatePolicy({
              ...assemblyUnifiedPolicyHooks(asmId),
              gateKey: 'gate4',
              jobId: g45JobSpec.jobId,
              runWorkerAttempt: runGate4Attempt,
              runInterventionAttempt: async () => 'no gate4-specific intervention available',
              isPass: (r) => !!r?.passed,
              persistStatus: async (policy) => saveOut45(g45JobSpec.jobId, 'gate4_policy', policy),
            });
            const g4Result = g4PolicyRun.result;
            log(
              asmId,
              `📋 Gate 4: ${g4Result.passed ? 'PASS' : 'FAIL'} (uploadSignal=${g4Result.uploadSignal})`
            );

            // Persist gate4 result to DB (non-fatal; score stored as 1=pass, 0=fail)
            try {
              const { saveAssemblyJob: saveAsmJobDb } = require('./db');
              saveAsmJobDb(asmId, assemblyJobId || asmId, { gate4Score: g4Result.passed ? 1 : 0 });
            } catch (e) {}

            // Gate 5 — upload confirmation (only if gate4.uploadSignal is true)
            const g4PostSpec = {
              ...(g4Preflight.jobSpec || g45JobSpecWithPath),
              state: {
                ...((g4Preflight.jobSpec || g45JobSpecWithPath)?.state || {}),
                gateResults: {
                  ...((g4Preflight.jobSpec || g45JobSpecWithPath)?.state?.gateResults || {}),
                  gate4: g4Result,
                },
              },
            };
            const g4Handoff = await persistGateHandoffReview({
              asmId,
              jobSpec: g45JobSpec,
              fromGate: 'gate4',
              nextGate: 'gate5',
              gateResult: g4Result,
              fallbackJobSpec: g4PostSpec,
            });
            if (
              g4Result.uploadSignal &&
              g4Handoff.passed &&
              gate5Worker.canProduce(g45JobSpecWithPath).ready
            ) {
              const g5Preflight = preflightGateExecution({
                jobId: g45JobSpec.jobId,
                portal: 'portal5',
                fallbackJobSpec: g45JobSpecWithPath,
              });
              if (g5Preflight.softHeals.length > 0) {
                log(asmId, `🩹 Gate 5 preflight soft-heal: ${g5Preflight.softHeals.join('; ')}`);
              }
              if (!g5Preflight.ready) {
                log(asmId, `⚠️  Gate 5 prerequisites warning: ${g5Preflight.reasons.join('; ')}`);
              }
              const g5RunSpec = g5Preflight.jobSpec || g45JobSpecWithPath;
              const g5Result = await gate5Worker.run(g5RunSpec, g4Result);
              try {
                await saveGR45(g45JobSpec.jobId, 'gate5', g5Result);
              } catch (e) {}
              emitGateResult(g45JobSpec, g5Result, contentType);
              log(asmId, `📋 Gate 5: ${g5Result.passed ? 'PASS' : 'FAIL'}`);
            } else {
              log(
                asmId,
                `⚠️  Gate 5 skipped (gate4 uploadSignal=${g4Result.uploadSignal}, handoffPass=${g4Handoff.passed})`
              );
            }
          } else {
            log(asmId, `⚠️  Gate 4 not ready — assembled file may be too large or missing`);
          }
        } catch (g45Err) {
          log(asmId, `⚠️  Gate 4/5 error (non-blocking): ${g45Err.message}`);
        }
      }
    } catch (err) {
      log(asmId, `\n❌ Assembly error: ${err.message}\n${err.stack}`);
      logError('ASSEMBLY_CRASH', err.message, {
        asmId,
        jobId: assemblyJobId,
        contentType,
        pct: assemblyJobs[asmId]?.pct,
        stack: err.stack,
      });
      assemblyJobs[asmId].status = 'failed';
      assemblyJobs[asmId].error = err.message;
      saveAssemblyJob(asmId);
      nrAssembly('AssemblyFailed', {
        assemblyId: asmId,
        sourceJobId: assemblyJobId || null,
        contentType: contentType || null,
        reason: 'assembly_crash',
        error: (err.message || '').slice(0, 500),
      });
    }
  };

  run();
}

module.exports = {
  handleAssemble,
  generateIntroCardPNG,
  generateGameStoryCardPNG,
  generateNewsStoryCardPNG,
  detectTrailingSilence,
  computeNewsClipTrimDuration,
  buildConcatCommand,
  probeDuration,
  checkDiskSpace,
  captureTicker,
  TICKER_CACHE,
  TICKER_MAP,
  getTickerMap,
  getPinnedComment,
  assemblyJobs,
  saveAssemblyJob,
};
