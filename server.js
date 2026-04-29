// Load repo-root .env regardless of PM2/cwd (folder_id and keys live here).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
require('newrelic');

// ── Build identity — set once at startup, never changes during runtime ────────
const BUILD_INFO = (() => {
  const { execSync: _execSync } = require('child_process');
  try {
    const hash = _execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    const fullHash = _execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim();
    const branch = _execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname })
      .toString()
      .trim();
    const commitMsg = _execSync('git log -1 --format=%s', { cwd: __dirname }).toString().trim();
    const pkg = require('./package.json');
    return {
      version: pkg.version,
      gitHash: hash,
      gitHashFull: fullHash,
      gitBranch: branch,
      lastCommit: commitMsg,
      deployedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      version: require('./package.json').version,
      gitHash: 'unknown',
      deployedAt: new Date().toISOString(),
    };
  }
})();

// ── New Relic custom event helpers (extracted to lib/nr_events.js) ────────────
const {
  nrEvent,
  nrGateAttribute,
  nrJobConfirmed,
  nrQaGenerateConfirmPolicy,
  nrGateResult,
  nrScriptSendback,
  nrVideoPublished,
  nrAssemblyComplete,
} = require('./lib/nr_events');

// ── Red 4: Proactive chrome directive architecture ─────────────────────────
// Feature flag — default true. Set USE_DIRECTIVE_CHROME=false to fall back
// to the legacy Fix 5/7 reactive state machine (emergency rollback only).
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false';
const {
  directiveToOverlayParams,
  validateScript: validateChromeScript,
} = require('./lib/chromeDirectives');
const {
  writeDirectiveForJob,
  loadDirectiveForJob,
  hasDirectiveForJob,
  extractSpokenTextFromDirective,
  pruneOldDirectives,
} = require('./lib/directives');

// ── Option Y hotfix 1: browser-like headers to bypass Al Jazeera WAF ──────
// axios default User-Agent (axios/1.x.x) gets blocked by Al Jazeera's bot
// detection. Full Chrome-on-macOS header set makes requests look like a real
// browser. Rotate Chrome version (currently 132) quarterly to avoid staleness.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="132", "Google Chrome";v="132", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
};

// Validate required environment variables on startup
// validateRequiredEnv moved to lib/startup.js — called via runStartupChecks() below

/**
 * AuraFlux API Server
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

// ── Timestamp all console output ──────────────────────────────────────────────
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
const _ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
console.log = (...a) => _origLog(`[${_ts()}]`, ...a);
console.warn = (...a) => _origWarn(`[${_ts()}]`, ...a);
console.error = (...a) => _origError(`[${_ts()}]`, ...a);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { strictLimit, apiLimit, healthLimit } = require('./lib/rateLimiter');
const requestLogger = require('./lib/requestLogger');
const axios = require('axios');
const fs = require('fs');
const { execFile, exec, execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { withPuppeteerExecutable, puppeteerExecutablePath } = require('./lib/services/puppeteer_utils');

const { body, validationResult } = require('express-validator');
const { logError, getErrorRate, getRecentErrors, errorMiddleware } = require('./lib/error_logger');
const {
  requireFields,
  validateContentType,
  validateArrayLength,
  sanitizeStrings,
} = require('./lib/validation');
const TwitchClient = require('./lib/clients/twitch_client');
const { CONFIG } = require('./lib/config');
const logger = require('./lib/logger');
const pipelineBus = require('./lib/pipeline_events');
const {
  StageTimer,
  jobMetrics,
  initJobMetrics,
  addStageMetrics,
  finalizeJobMetrics,
} = require('./lib/metrics');
const db = require('./lib/db');
const { createJobSpec, getJobSpec } = require('./lib/job_spec');
const {
  shouldUseManualCheckpoint,
  useC0ImmediateManualHold,
  writeManualManifest,
  prefetchManualSourceClips,
  prepareC0ManualHoldAfterHeyGen,
  applyManualOverrides,
} = require('./lib/manual_segment_workflow');
const { persistJobSpecGateContracts } = require('./lib/job_spec_contracts');
const { startMonitoring } = require('./lib/monitoring');
const {
  generateTwitchLongformThumbnail,
  generateNewsNbaThumbnail,
  burnSceneChromeFromDirective,
  generateChromeOverlayFromDirective,
  generateNewscastOverlay,
} = require('./lib/chrome_overlay');
const {
  geminiQACheck, // TODO: remove — dead code, gate2Worker.run() replaces this (see /gate2-segment-qa endpoint)
  parseScriptIntoScenes,
  generateClipAvailabilityReport,
  claudeScriptQA,
  claudeScriptFix,
  geminiSegmentQA, // TODO: remove — dead code, gate2Worker.run() replaces this
  callClaudeAPI,
  uploadToGeminiFiles,
  waitForGeminiFile,
  deleteGeminiFile,
  autoAction,
} = require('./lib/qa');
const {
  sendScriptToHeyGen,
  geminiScriptGeneration,
  getVoiceGuide,
  scrapeArticleVideo,
  scrapeArticleOgImage,
  geminiAnalyzeClip,
  geminiAnalyzeThumbnail,
  prioritizeNewsStories,
  handleGenerateFullScript,
} = require('./lib/script_gen');
const {
  getDriveClient,
  getDriveFolderId,
  uploadToDrive,
  importToCanva,
  readUploadStatus,
  writeUploadStatus,
  logUploadAttempt,
  generateShortFormCaption,
  handlePublish,
  handleGeneratePublishCopy,
} = require('./lib/publish');
const {
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
  getPinnedComment,
  TICKER_CACHE,
  TICKER_MAP,
  assemblyJobs,
} = require('./lib/assembly');
const { downloadFile } = require('./lib/downloader');
const {
  ffmpegPath: _ffmpegDockerPath,
  ffprobePath: _ffprobeDockerPath,
} = require('./lib/ffmpeg_utils');
const cheerio = require('cheerio');

const app = express();

// ffmpegEncodeArgs lives in lib/ffmpeg_utils.js — used by lib/assembly.js directly
const { ffmpegEncodeArgs } = require('./lib/ffmpeg_utils');
console.log(`[ffmpeg] ffmpegEncodeArgs loaded from lib/ffmpeg_utils (platform: ${process.platform})`);

const TMP_DIR    = require('path').join(__dirname, 'tmp');
const OUTPUT_DIR = require('path').join(__dirname, 'output');
const { CWN_LOGO_PATH, CWN_BANNER_PATH, SYSTEM_FONT } = require('./lib/services/branding_assets');
require('fs').mkdirSync(TMP_DIR,    { recursive: true });
require('fs').mkdirSync(OUTPUT_DIR, { recursive: true });

// Clean up orphaned temp files on startup (older than 24 hours)
const { runStartupChecks } = require('./lib/startup');
runStartupChecks({
  requiredEnv: ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HEYGEN_API_KEY'],
  tmpDir:      TMP_DIR,
  outputDir:   OUTPUT_DIR,
});
pruneOldDirectives(); // Red 4 hotfix 12: prune directive sidecar files older than 7 days

// assemblyJobs imported from lib/assembly.js (shared in-memory state)
const heygenJobs = {};

// ── Job Card Persistence (extracted to lib/job_card.js) ──────────────────────
const {
  persistedJobs,
  JOBS_FILE,
  initJobCardSQLite,
  inferJobStage,
  saveJobCard,
  markJobStuck,
  checkContentTypeStuckPattern,
} = require('./lib/job_card');

// Initialise SQLite alongside jobs.json (called immediately on require inside job_card.js)
initJobCardSQLite();

// ── HeyGen Poller (extracted to lib/heygen_poller.js) ───────────────────────
const {
  activePollers,
  registerPoller,
  unregisterPoller,
  startHeyGenPoller,
  resumeInFlightPollers,
} = require('./lib/heygen_poller');

// ── Pipeline Bus Subscribers (extracted to lib/pipeline_bus_subscribers.js) ──
const { registerPipelineBusSubscribers } = require('./lib/pipeline_bus_subscribers');

// Register heygen:all_complete → Gate 2 → assembly subscriber
registerPipelineBusSubscribers();

// Resume any pollers that were active when the server last exited
setImmediate(resumeInFlightPollers);

// Initialize Anthropic client for Claude API calls
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize Twitch client
const twitchClient = new TwitchClient({
  clientId: process.env.TWITCH_CLIENT_ID,
  token: process.env.TWITCH_TOKEN,
});

// Security headers via helmet
app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled for local dashboard with inline scripts
    crossOriginEmbedderPolicy: false, // Disabled for embedded videos/images
  })
);

// CORS configuration with origin whitelist
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [
      'http://localhost:8765',
      'http://localhost:3000',
      'https://app.auraflux.co',
      'https://auraflux.co',
      'https://www.auraflux.co',
    ];

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Structured HTTP request logging (pino-http) — one JSON line per request
app.use(requestLogger);

// ── Clerk auth — CPD-21 ──────────────────────────────────────────────────────
// clerkMiddleware() must run before any route that calls requireAuth.
// It attaches the Clerk session to req without enforcing auth yet.
const { clerkInit } = require('./lib/auth');
app.use(clerkInit());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        console.warn(`⚠️  Blocked CORS request from unauthorized origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);
app.use(require('express').json({
  limit: '10mb',
  // CPD-45: capture raw body for Stripe webhook signature verification
  verify: (req, _res, buf) => {
    if (req.path === '/credits/webhook') req.rawBody = buf;
  },
}));
app.use(require('express').urlencoded({ extended: true, limit: '10mb' }));

// Catch malformed JSON bodies before they reach routes — returns 400 instead of 500.
// Triggered when Jira Automation interpolates ADF comment bodies as raw strings.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      ok: false,
      error: 'Invalid JSON body — check payload serialisation',
      label: 'BODY_PARSE_FAILED',
    });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

// VectCutClient, findBrandingAsset, findSystemFont → extracted modules
// SYSTEM_FONT, CWN_LOGO_PATH, CWN_BANNER_PATH already destructured above
const { vectCutClient } = require('./lib/clients/vectcut_client');

// ── Generate intro card PNG using Node Canvas ─────────────────────
// TV Rectangle design (1280×720 canvas → 640×360 final after FFmpeg scale)
// All 3 content types (Twitch, NBA, News) use this same TV-rectangle design
// for CWN brand consistency. Layout: profile image left, text right.
// Returns path to PNG file, or null if canvas not installed

// ── Generate NBA/News Intro Card (Square Design) ────────────────────
// For NBA: game thumbnail in square
// For News: story image in square
// Same placement as Twitch card (right of Bobby G during intro)

// ── Fix 9: Detect trailing silence in a clip (for AJ outro branding removal) ──────────────
/**
 * Detect the timestamp where trailing silence begins in a clip.
 * Uses FFmpeg silencedetect filter. Returns the silence-start timestamp
 * if trailing silence is found, or null if the clip ends on speech.
 *
 * @param {string} clipPath - absolute path to input clip (mp4/ts/mkv)
 * @returns {Promise<{totalDuration: number, silenceStart: number|null}>}
 */

/**
 * Compute the output duration for a News source clip, stripping the
 * Al Jazeera red outro branding card.
 *
 * Priority:
 *   1. If silencedetect finds trailing silence starting before clip end,
 *      trim to silence_start (that's where speech ended + branding began).
 *   2. If no trailing silence detected (clip ends on speech), fall back
 *      to trimming the last 5.0 seconds on the assumption the branding
 *      frame is at the tail regardless.
 *   3. Sanity guards:
 *      - Never trim more than 30% of the clip duration (prevents aggressive
 *        cuts on short clips where silencedetect is unreliable)
 *      - Never return a duration less than 5 seconds (floor — below that,
 *        the clip is too short to be useful regardless)
 *
 * @param {string} clipPath
 * @returns {Promise<number>} - output duration in seconds
 */

/**
 * Generate a News TV card PNG for a single story.
 * Renders at 2× resolution (1040×586) to match OVERLAY_ZONE 520×293 after lanczos scale.
 * Fix 8B: uses scraped og:image as background, story headline as foreground text, gold border.
 */

// ffmpegPath/ffprobePath/checkFFmpeg → lib/ffmpeg_utils (already imported above as _ffmpegDockerPath etc.)
// Use the lib/ffmpeg_utils exports directly — no local wrappers needed
function ffmpegPath()  { return _ffmpegDockerPath();  }
function ffprobePath() { return _ffprobeDockerPath(); }

// ── Health check cache — extracted to lib/health_cache.js ────────────────────
const { _healthCache, startHealthRefresh } = require('./lib/health_cache');
startHealthRefresh({ vectCutClient, TMP_DIR, OUTPUT_DIR });

// Check available disk space before assembly

// ── Build FFmpeg concat filter ─────────────────────────────────────

// Probe clip duration via ffprobe

// ── Route modules (Phase 2 extraction) ────────────────────────────
const jobsRouter = require('./lib/routes/jobs');
const jobsC1Router = require('./lib/routes/jobs_c1');
const creditsRouter    = require('./lib/routes/credits');    // CPD-43
const thumbnailRouter  = require('./lib/routes/thumbnail');  // CPD-55
const conciergeRouter  = require('./lib/routes/concierge');  // CPD-83
const clipSourcingRouter = require('./lib/routes/clip_sourcing'); // CPD-73
const { runOverageBillingCycle } = require('./lib/services/billing_cron'); // CPD-46
const createAdminRouter = require('./lib/routes/admin');
const publishRouter = require('./lib/routes/publish');
const heygenRouter = require('./lib/routes/heygen');

// Mount routers — must come after middleware and _healthCache init
app.use('/', jobsRouter);
app.use('/', jobsC1Router); // CPD-67: C1+ POST /jobs entry endpoint
app.use('/', creditsRouter);   // CPD-43: credit ledger consume + balance
app.use('/', thumbnailRouter); // CPD-55: thumbnail approval stage
app.use('/', conciergeRouter);     // CPD-83: AI Concierge
app.use('/', clipSourcingRouter); // CPD-73: Clip sourcing
const planRouter = require('./lib/routes/plan'); // CPD-84: Plan feature matrix
app.use('/', planRouter);
app.use('/', createAdminRouter({ _healthCache, BUILD_INFO }));
app.use('/', publishRouter);
app.use('/', heygenRouter);

// ── AI Video Generation ────────────────────────────────────────────────────────
const videoRouter = require('./lib/routes/video');
app.use('/', videoRouter);

// ── Jira Webhook Queue ───────────────────────────────────────────────────────
// Receives Jira webhook payloads and stores them as a queue so the local Mac
// poller (scripts/jira_poller.sh, runs every 5 min via launchd) can pick them
// up and trigger Aider immediately instead of waiting until 1 AM.
//
// Queue file: data/jira_queue.json  (persisted on Render disk)
// Secret:     JIRA_WEBHOOK_SECRET env var (passed as ?secret= query param)
// Helpers + constants now in lib/jira_queue.js — mounted via createAdminRouter

// POST /api/jira-webhook?secret=<JIRA_WEBHOOK_SECRET>
// Jira sends this when an issue transitions or is updated.
// Stores unprocessed tasks in jira_queue.json for the Mac poller to pick up.
// ── Routes ────────────────────────────────────────────────────────
// /api/jira-webhook, /api/jira-queue, /health — now in lib/routes/admin.js

// /jobs, /job/:id/*, /content-type-status — now in lib/routes/jobs.js
// Serve assets folder for images (Bobby G, etc.)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// ── POST /assemble ────────────────────────────────────────────────
// ── GOOGLE DRIVE AUTO-UPLOAD ──────────────────────────────────────
// Uses a service account key at ~/Downloads/cwn-drive-key.json
// One-time setup: https://console.cloud.google.com → Drive API → Service Account
// Share your "CWN Videos" Drive folder with the service account email (Editor)

// DRIVE_KEY_PATH + DRIVE_FOLDER_NAME moved to lib/publish.js (only consumer after module split)

// enhanceVideoWithTopaz → lib/services/topaz.js
const { enhanceVideoWithTopaz } = require('./lib/services/topaz');

// ── Assembly, Drive, Canva, Ticker routes ───────────────────────────────────────
const assemblyRouter = require('./lib/routes/assembly_routes');
app.use('/', assemblyRouter);

// ── C0 Content Sources (Twitch, NBA, News, Analyze) ────────────────────────────
const c0SourcesRouter = require('./lib/routes/c0_sources');
app.use('/', c0SourcesRouter);

// ── C0 CapCut Progressive Assembly + Short-Form ────────────────────────────────
const c0CapcutRouter = require('./lib/routes/c0_capcut');
app.use('/', c0CapcutRouter);

// ── C0 Gate Tools, Remediation, Thumbnail, Cleanup ─────────────────────────────
const c0GateToolsRouter = require('./lib/routes/c0_gate_tools');
app.use('/', c0GateToolsRouter);

// ── Express error middleware (must be last) ───────────────────────
app.use(errorMiddleware);

// ── Start ─────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🚀 AuraFlux API running on http://localhost:${PORT}`);
  console.log(`   FFmpeg path: ${ffmpegPath()}`);
  console.log(`   Tmp dir:     ${TMP_DIR}`);
  console.log(`   Output dir:  ${OUTPUT_DIR}`);
  const gateTestMode = process.env.GATE_TEST_MODE === 'true';
  if (gateTestMode) {
    console.log(
      `   ⏸  GATE_TEST_MODE=true — HeyGen auto-send DISABLED ($0.33/segment protected)\n`
    );
  } else {
    console.log(`   🔴 GATE_TEST_MODE=false — HeyGen auto-send LIVE (each segment costs $0.33)\n`);
  }
  checkFFmpeg((err, v) => {
    if (err) console.warn('⚠️  FFmpeg not found:', err.message);
    else console.log('✅ FFmpeg:', v);
  });
  startMonitoring(); // Start pipeline event monitoring

  // CPD-46: nightly overage billing cron — runs at 02:00 server time
  try {
    const cron = require('node-cron');
    cron.schedule('0 2 * * *', async () => {
      console.log('[billing-cron] Running nightly overage reporting...');
      try {
        const result = await runOverageBillingCycle();
        console.log(`[billing-cron] Completed: ${JSON.stringify(result.results?.length)} clients processed`);
      } catch (err) {
        console.error('[billing-cron] Error:', err.message);
      }
    });
    console.log('[billing-cron] Nightly overage cron scheduled (02:00 daily)');
  } catch (_e) { /* non-fatal if node-cron unavailable */ }
});

// Graceful shutdown — waits for both HeyGen pollers and in-flight assembly jobs
async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received — checking in-flight work...`);

  const pollerCount = activePollers.size;
  const assemblyCount = Object.keys(assemblyJobs).filter(
    (id) => assemblyJobs[id].status === 'running'
  ).length;

  if (pollerCount === 0 && assemblyCount === 0) {
    console.log('[shutdown] No active pollers or assemblies — exiting cleanly');
    process.exit(0);
  }

  console.log(
    `[shutdown] ${pollerCount} poller(s), ${assemblyCount} assembly job(s) in flight — waiting up to 35s...`
  );

  // Hard exit after 35s no matter what
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] 35s timeout — forcing exit');
    process.exit(1);
  }, 35000);
  forceTimer.unref();

  // Wait for all pollers to checkpoint their current poll cycle
  if (pollerCount > 0) {
    await Promise.race([
      Promise.all([...activePollers.values()].map((e) => e.done)),
      new Promise((r) => setTimeout(r, 33000)),
    ]);
    console.log('[shutdown] Pollers checkpointed');
  }

  // Wait for running assembly jobs to finish (polls every 1s)
  if (assemblyCount > 0) {
    await Promise.race([
      new Promise((resolve) => {
        const interval = setInterval(() => {
          const still = Object.keys(assemblyJobs).filter(
            (id) => assemblyJobs[id].status === 'running'
          ).length;
          if (still === 0) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      }),
      new Promise((r) => setTimeout(r, 30000)),
    ]);
    console.log('[shutdown] Assemblies checkpointed');
  }

  console.log('[shutdown] Clean exit');
  process.exit(0);
}
