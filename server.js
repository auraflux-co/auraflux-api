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

// ── Red 4 hotfix: strip markdown code fences from Gemini JSON output ──────
// Gemini 2.5 Flash often wraps structured JSON output in ```json ... ```
// markdown fences even when prompted to return raw JSON. JSON.parse chokes
// on the backticks. This helper strips common fence patterns before parsing.
// Safe no-op on already-raw JSON. Handles ```json, ```JSON, plain ``` variants.
function stripCodeFences(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text.trim();
  if (t.startsWith('```')) {
    // Opening fence: ```json\n, ```JSON\n, or ```\n
    t = t.replace(/^```(?:json|JSON)?\s*\n?/, '');
    // Closing fence: \n``` or ```
    t = t.replace(/\n?```\s*$/, '');
  }
  return t.trim();
}

// Validate required environment variables on startup
function validateRequiredEnv() {
  const required = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HEYGEN_API_KEY'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('\n❌ FATAL: Missing required environment variables:');
    missing.forEach((key) => console.error(`   - ${key}`));
    console.error('\nPlease add these to your .env file and restart.\n');
    process.exit(1);
  }
  console.log('✅ All required environment variables present');
}

validateRequiredEnv();

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
const puppeteer = require('puppeteer');

/** When Puppeteer's cache has no bundled Chrome, fall back to a system install. */
function puppeteerExecutablePath() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Probe Puppeteer's own download cache (npx puppeteer browsers install chrome).
  // Puppeteer caches under ~/.cache/puppeteer/chrome/<platform>-<ver>/chrome-<platform>/<App>.
  try {
    const cacheBase = path.join(require('os').homedir(), '.cache', 'puppeteer', 'chrome');
    if (fs.existsSync(cacheBase)) {
      // Walk one level of version dirs, newest first
      const vers = fs.readdirSync(cacheBase).sort().reverse();
      for (const ver of vers) {
        const candidates = [
          // macOS arm / x64
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
          // Linux
          path.join(cacheBase, ver, 'chrome-linux64', 'chrome'),
          // Win
          path.join(cacheBase, ver, 'chrome-win64', 'chrome.exe'),
          path.join(cacheBase, ver, 'chrome-win32', 'chrome.exe'),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch (_) {
    /* non-fatal */
  }

  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function withPuppeteerExecutable(opts) {
  const exe = puppeteerExecutablePath();
  return exe ? { ...opts, executablePath: exe } : opts;
}

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

// ── FFmpeg encoder selection ─────────────────────────────────────────────────
// macOS (local dev, M4 Pro): VideoToolbox hardware encoder — ~5x faster than libx264
// Linux (Railway standard): libx264 ultrafast — no GPU on standard plan
// Linux + GPU (Railway future): h264_nvenc — add when GPU instance available
const _IS_MACOS = process.platform === 'darwin';
const _HW_AVAIL = _IS_MACOS; // extend to check process.env.ENABLE_NVENC when Railway GPU added

// Returns encoder + quality args for the current platform.
// hwQuality=true for chrome burns (short segments, worth extra quality)
// hwQuality=false for normalize/concat (large files, speed matters more)
function ffmpegEncodeArgs(hwQuality = false) {
  if (_HW_AVAIL) {
    // Apple VideoToolbox — uses M4 Pro media engine, doesn't compete with CPU
    return [
      '-c:v',
      'h264_videotoolbox',
      ...(hwQuality ? CONFIG.FFMPEG.HW_QUALITY_HQ : CONFIG.FFMPEG.HW_QUALITY_FLAG),
      ...CONFIG.FFMPEG.THREADS,
    ];
  } else {
    // Linux / Railway — software encode, ultrafast preset for speed
    return [
      '-c:v',
      'libx264',
      ...(hwQuality ? CONFIG.FFMPEG.SW_QUALITY_HQ : CONFIG.FFMPEG.SW_QUALITY_FLAGS),
      ...CONFIG.FFMPEG.THREADS,
    ];
  }
}

console.log(
  `[ffmpeg] Encoder: ${_HW_AVAIL ? 'h264_videotoolbox (hardware)' : 'libx264 (software)'} on ${process.platform}`
);

const TMP_DIR = require('path').join(__dirname, 'tmp');
const CWN_LOGO_PATH = path.join(__dirname, 'assets', 'cwn_logo.png');
const CWN_BANNER_PATH = path.join(__dirname, 'assets', 'cwn_banner.png');
const OUTPUT_DIR = require('path').join(__dirname, 'output');
require('fs').mkdirSync(TMP_DIR, { recursive: true });
require('fs').mkdirSync(OUTPUT_DIR, { recursive: true });

// Clean up orphaned temp files on startup (older than 24 hours)
function cleanupOrphanedTempFiles() {
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();
  let cleaned = 0;

  try {
    const files = fs.readdirSync(TMP_DIR);
    for (const f of files) {
      const fp = path.join(TMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch (e) {
        // File already deleted or inaccessible, skip
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} orphaned temp file(s) from previous sessions`);
    }
  } catch (e) {
    console.error(`⚠️  Temp file cleanup failed: ${e.message}`);
  }
}

// Validate directory write permissions on startup
function validateDirWritable(dirPath, dirName) {
  try {
    const testFile = path.join(dirPath, `.writetest_${Date.now()}`);
    fs.writeFileSync(testFile, 'permission_test');
    fs.unlinkSync(testFile);
    console.log(`✅ ${dirName} directory is writable`);
  } catch (e) {
    console.error(`\n❌ FATAL: ${dirName} directory is not writable: ${dirPath}`);
    console.error(`   Error: ${e.message}`);
    console.error(`   Fix permissions and restart.\n`);
    process.exit(1);
  }
}

cleanupOrphanedTempFiles();
validateDirWritable(TMP_DIR, 'tmp');
validateDirWritable(OUTPUT_DIR, 'output');
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
app.use(require('express').json({ limit: '10mb' }));
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

// ── VectCut Design Orchestrator ─────────────────────────────────────
// Bridge between Node.js and Python video engine (port 9001)
// Handles: Split-screen assembly, branded overlays, burn-in images
// Reference: "Creative Requirements and Direction.txt" (Gemini = Design Lead, Claude = Implementation Lead)
class VectCutClient {
  constructor(port = 9001) {
    this.baseUrl = process.env.VECTCUT_API_URL || `http://localhost:${port}`;
  }

  /**
   * Short-Form Split-Screen Assembly (9:16 Portrait)
   * Top 50%: Source clip (1080×960)
   * Bottom 50%: Bobby G avatar (1080×960)
   * Logo: 80px top-right, 85% opacity
   */
  async assembleShortForm(clipPath, avatarPath, jobId) {
    console.log(`[VectCut] Orchestrating split-screen for ${jobId}`);
    const layout = CONFIG.VISUAL_LAYOUTS.SHORT_FORM;

    const payload = {
      jobId,
      canvas: { width: layout.WIDTH, height: layout.HEIGHT },
      layers: [
        {
          path: clipPath,
          x: layout.CLIP_ZONE.x,
          y: layout.CLIP_ZONE.y,
          w: layout.CLIP_ZONE.w,
          h: layout.CLIP_ZONE.h,
          z: 1,
        },
        {
          path: avatarPath,
          x: layout.AVATAR_ZONE.x,
          y: layout.AVATAR_ZONE.y,
          w: layout.AVATAR_ZONE.w,
          h: layout.AVATAR_ZONE.h,
          z: 2,
        },
      ],
      branding: {
        path: findBrandingAsset('logo-80px.png'),
        x: layout.LOGO_POS.x,
        y: layout.LOGO_POS.y,
        size: layout.LOGO_POS.size,
        opacity: 0.85,
      },
    };

    return axios.post(`${this.baseUrl}/assemble`, payload);
  }

  /**
   * Branded "Gold Ring" Overlay for Long-Form (16:9 Landscape)
   * Applies CWN Gold (#c7af4f) 5px border + drop shadow
   * Position: TV-shaped card (640×360) at OVERLAY_ZONE (top-right, facing Bobby G who faces viewer's left)
   * Used for: NBA intro cards, News article images
   */
  async addBrandedOverlay(videoPath, assetPath, layout = 'LONG_FORM') {
    const coords = CONFIG.VISUAL_LAYOUTS[layout].OVERLAY_ZONE;

    return axios.post(`${this.baseUrl}/overlay`, {
      videoPath,
      assetPath,
      x: coords.x,
      y: coords.y,
      w: coords.w,
      h: coords.h,
      style: {
        border: '5px solid #c7af4f', // CWN Gold border
        shadow: '0 4px 15px rgba(0,0,0,0.5)', // 50% opacity shadow
      },
    });
  }

  /**
   * Health check - verify VectCut API is responsive
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.baseUrl}/`);
      return { healthy: true, status: response.status };
    } catch (error) {
      console.error(`[VectCut] Health check failed: ${error.message}`);
      return { healthy: false, error: error.message };
    }
  }
}

// Initialize singleton instance
const vectCutClient = new VectCutClient();

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
  if (fs.existsSync(localCopy)) {
    console.log(`[font] Using local copy: ${localCopy}`);
    return localCopy;
  }

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
        if (!fs.existsSync(path.join(__dirname, 'tmp')))
          fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
        fs.copyFileSync(src, localCopy);
        console.log(`[font] Copied ${src} → ${localCopy}`);
        return localCopy;
      } catch (e) {
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

// downloadFile moved to lib/downloader.js (imported above)

// Delegate to lib/ffmpeg_utils — routes through Docker container (bin/ffmpeg-docker)
function ffmpegPath() {
  return _ffmpegDockerPath();
}
function ffprobePath() {
  return _ffprobeDockerPath();
}

function checkFFmpeg(cb) {
  execFile(ffmpegPath(), ['-version'], (err, stdout) => {
    if (err) return cb(new Error('FFmpeg not found or Docker not running.'));
    const versionLine = stdout.split('\n')[0];
    cb(null, versionLine);
  });
}

// ── Health check cache ──────────────────────────────────────────────────────
// All expensive checks (FFmpeg spawn, disk df, VectCut HTTP) run once at
// startup and every 60s. The /health route returns the cached snapshot
// instantly so it stays < 5ms under load.
const _healthCache = {
  ffmpeg: { status: 'pending', version: null },
  apiKeys: {},
  directories: {},
  vectcut: { status: 'pending' },
  freeSpaceGB: null,
  lastRefreshed: null,
};

async function _refreshHealthCache() {
  // FFmpeg
  try {
    const ver = await new Promise((resolve, reject) =>
      checkFFmpeg((err, v) => (err ? reject(err) : resolve(v)))
    );
    _healthCache.ffmpeg = { status: 'ok', version: ver };
  } catch (e) {
    _healthCache.ffmpeg = { status: 'error', error: e.message };
  }

  // API keys — just presence check, no network call
  ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HEYGEN_API_KEY'].forEach((k) => {
    _healthCache.apiKeys[k] = { status: process.env[k] ? 'ok' : 'missing' };
  });

  // Directories — stat only
  for (const [name, dir] of Object.entries({ tmp: TMP_DIR, output: OUTPUT_DIR })) {
    try {
      fs.statSync(dir);
      _healthCache.directories[name] = { path: dir, exists: true, writable: true };
    } catch (e) {
      _healthCache.directories[name] = { path: dir, exists: false, error: e.message };
    }
  }

  // Disk space
  try {
    const freeKB = await new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(`df -k "${OUTPUT_DIR}" | awk 'NR==2 {print $4}'`, (err, stdout) =>
        err ? reject(err) : resolve(parseInt(stdout.trim()))
      );
    });
    const freeGB = parseFloat((freeKB / 1024 / 1024).toFixed(1));
    _healthCache.freeSpaceGB = freeGB;
    if (_healthCache.directories.output) {
      _healthCache.directories.output.freeSpaceGB = freeGB;
    }
  } catch (_e) {}

  // VectCut — optional external call
  try {
    const vectCutHealth = await vectCutClient.healthCheck();
    _healthCache.vectcut = vectCutHealth.healthy
      ? { status: 'ok' }
      : { status: 'offline', error: vectCutHealth.error };
  } catch (e) {
    _healthCache.vectcut = { status: 'offline', error: e.message };
  }

  _healthCache.lastRefreshed = new Date().toISOString();
}

// Prime the cache immediately, then refresh every 60s
_refreshHealthCache().catch(() => {});
setInterval(() => _refreshHealthCache().catch(() => {}), 60_000);

// Check available disk space before assembly

// ── Build FFmpeg concat filter ─────────────────────────────────────

// Probe clip duration via ffprobe

// ── Route modules (Phase 2 extraction) ────────────────────────────
const jobsRouter = require('./lib/routes/jobs');
const jobsC1Router = require('./lib/routes/jobs_c1');
const createAdminRouter = require('./lib/routes/admin');
const publishRouter = require('./lib/routes/publish');
const heygenRouter = require('./lib/routes/heygen');

// Mount routers — must come after middleware and _healthCache init
app.use('/', jobsRouter);
app.use('/', jobsC1Router); // CPD-67: C1+ POST /jobs entry endpoint
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

// ── Topaz Labs Video Enhancement ──────────────────────────────────
// Enhances video quality using Topaz Labs API (fix compression artifacts, frozen frames, pixelation)
async function enhanceVideoWithTopaz(videoPath, opts = {}) {
  const TOPAZ_API_KEY = process.env.TOPAZLABS_API_KEY;
  if (!TOPAZ_API_KEY) {
    console.log('[topaz] TOPAZLABS_API_KEY not set — skipping enhancement');
    return { success: false, reason: 'No API key' };
  }

  const stat = fs.statSync(videoPath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > 500) {
    console.log(`[topaz] Video ${sizeMB.toFixed(1)} MB exceeds 500MB API limit — skipping`);
    return { success: false, reason: 'File too large (>500MB)' };
  }

  try {
    console.log(
      `[topaz] Enhancing video: ${path.basename(videoPath)} (${sizeMB.toFixed(1)} MB)...`
    );

    // Step 1: Probe video metadata with FFprobe
    const metadata = await new Promise((res, rej) => {
      execFile(
        ffprobePath(),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-count_frames',
          '-show_entries',
          'stream=width,height,r_frame_rate,nb_read_frames,codec_name,duration',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          videoPath,
        ],
        (err, stdout) => {
          if (err) return rej(err);
          try {
            const json = JSON.parse(stdout);
            const stream = json.streams?.[0] || {};
            const format = json.format || {};
            const [num, den] = (stream.r_frame_rate || '30/1').split('/').map(Number);
            res({
              width: stream.width || 1920,
              height: stream.height || 1080,
              fps: Math.round(num / den),
              duration: parseFloat(format.duration || stream.duration || '60'),
              codec: stream.codec_name || 'h264',
              container: path.extname(videoPath).slice(1) || 'mp4',
            });
          } catch (e) {
            rej(e);
          }
        }
      );
    });

    console.log(
      `[topaz] Metadata: ${metadata.width}x${metadata.height} @ ${metadata.fps}fps, ${metadata.duration.toFixed(1)}s, ${metadata.codec}/${metadata.container}`
    );

    // Step 2: Create enhancement request
    const createResp = await axios.post(
      'https://api.topazlabs.com/video/',
      {
        source: {
          resolution: [metadata.width, metadata.height],
          container: metadata.container,
          frameRate: metadata.fps,
          duration: metadata.duration,
        },
        output: {
          resolution: [metadata.width, metadata.height], // no upscaling, just enhancement
          audioCodec: 'AAC',
          container: 'mp4',
        },
        filter: {
          model: 'apo-3', // Proteus model for quality + artifact recovery
          slowmo: { enabled: false },
          frameRate: metadata.fps,
        },
      },
      {
        headers: {
          'X-API-Key': TOPAZ_API_KEY,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const requestID = createResp.data?.requestID;
    if (!requestID) throw new Error('No requestID in Topaz create response');
    console.log(`[topaz] Created request: ${requestID}`);

    // Step 3: Accept and get upload URLs
    const acceptResp = await axios.patch(
      `https://api.topazlabs.com/video/${requestID}/accept`,
      {},
      {
        headers: {
          'X-API-Key': TOPAZ_API_KEY,
          accept: 'application/json',
          'content-type': 'application/json',
        },
      }
    );

    const uploadUrl = acceptResp.data?.uploadUrl;
    if (!uploadUrl) throw new Error('No uploadUrl in Topaz accept response');
    console.log(`[topaz] Got upload URL, uploading video...`);

    // Step 4: Upload video to signed URL
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(uploadUrl, videoBuffer, {
      headers: { 'Content-Type': 'video/mp4' },
      maxBodyLength: Infinity,
      timeout: 300000, // 5 min upload timeout
    });

    console.log(`[topaz] Video uploaded, completing...`);

    // Step 5: Complete upload to start processing
    await axios.patch(
      `https://api.topazlabs.com/video/${requestID}/complete-upload`,
      {},
      {
        headers: {
          'X-API-Key': TOPAZ_API_KEY,
          accept: 'application/json',
          'content-type': 'application/json',
        },
      }
    );

    console.log(`[topaz] Processing started, polling status...`);

    // Step 6: Poll for completion (timeout after 30 min)
    const startTime = Date.now();
    const POLL_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    let downloadUrl = null;

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 15000)); // poll every 15s

      const statusResp = await axios.get(`https://api.topazlabs.com/video/${requestID}/status`, {
        headers: {
          'X-API-Key': TOPAZ_API_KEY,
          accept: 'application/json',
        },
      });

      const status = statusResp.data?.status;
      console.log(`[topaz] Status: ${status || 'unknown'}`);

      if (status === 'complete' || status === 'completed') {
        downloadUrl = statusResp.data?.downloadUrl || statusResp.data?.output_url;
        if (downloadUrl) break;
      } else if (status === 'failed' || status === 'error') {
        throw new Error(`Topaz processing failed: ${statusResp.data?.error || 'unknown error'}`);
      }
    }

    if (!downloadUrl) throw new Error('Topaz processing timeout (30 min)');

    console.log(`[topaz] Enhancement complete, downloading...`);

    // Step 7: Download enhanced video
    const enhancedPath = videoPath.replace('.mp4', '_topaz_enhanced.mp4');
    const writer = fs.createWriteStream(enhancedPath);
    const downloadResp = await axios.get(downloadUrl, { responseType: 'stream' });
    downloadResp.data.pipe(writer);

    await new Promise((res, rej) => {
      writer.on('finish', res);
      writer.on('error', rej);
    });

    const enhancedStat = fs.statSync(enhancedPath);
    console.log(
      `[topaz] Downloaded enhanced video: ${(enhancedStat.size / 1024 / 1024).toFixed(1)} MB`
    );

    // Step 8: Replace original with enhanced
    fs.unlinkSync(videoPath);
    fs.renameSync(enhancedPath, videoPath);
    console.log(`[topaz] ✅ Video enhanced successfully`);

    return { success: true, requestID };
  } catch (err) {
    console.error(`[topaz] ❌ Enhancement failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ── Gemini QA Check ────────────────────────────────────────────────
// Reviews the assembled video before Drive upload
// Samples at 10%, 50%, and 90% of the video to catch issues throughout
// Returns { score: 0-100, report: string, passed: boolean }

// ── HeyGen API Integration ────────────────────────────────────────
// Parse script into individual scenes

// Submits approved script to HeyGen for avatar video generation
// UPDATED: Generates one video per scene to avoid HeyGen multi-scene processing issues

// ── Gate 1: Script Generation — Gemini writes the script ──────────
// NEW ARCHITECTURE (as of April 2026):
// Claude consistently generated 11 scenes instead of 72 for Twitch format,
// ignoring all prompt instructions due to learned "one section per streamer" pattern.
// SOLUTION: Gemini writes script (no learned bias), Claude QAs it (fresh evaluation).

// ── Gate 1: Clip Availability Report ─────────────────────────────
// Appended to every Gate 1 why-doc (pass or fail) to show why some
// streamers had fewer than the target number of clips.
// Helps Rob understand shortfalls without digging through logs.

// ── Gate 1: Script QA — Claude reviews Gemini's script ────────────
// NEW ARCHITECTURE (as of April 2026):
// Claude now QAs scripts written by Gemini (role swap from original architecture).
// Claude did NOT write the script — it's a clean cross-check with advanced reasoning.
//
// PASS:          score >= 90 → auto-proceed to HeyGen
// MANUAL REVIEW: score 70-89 → hold, show Rob the why-doc
// HARD FAIL:     score < 70 OR any critical failure → back to Gemini (max 3 retries)
//
// Critical failures (always hard-fail regardless of score):
//   - Wrong [CLIP PLAYS HERE] count
//   - Missing "Appreciate you!" in outro
//   - Wrong scene count (e.g., 11 instead of 72)
//   - Clip content mismatch (setup doesn't match video analysis)
//   - Wrong streamer display name used

// ── Claude Script Fix — surgically rewrites broken clip sections ──────────────
// Called after Gate 1 FAIL when the only issue is CLIP MATCH (descriptions don't
// match actual clip content). Claude rewrites ONLY the broken SETUP/REACTION
// sections using the actual Gemini clip analyses, preserving all structure.
//
// Returns: { script: string, fixed: boolean }

// ── Gate 1: Script QA — Gemini reviews Claude's script (LEGACY) ───
// This function is now only used for non-Twitch/NBA/News content types
// where the scene count issue doesn't apply.
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

// ── Gate 2: Segment QA — Gemini reviews HeyGen segments ───────────
// Called after all HeyGen segments complete, before assembly.
// Samples the first, middle, and last avatar segments.
// PASS: score >= 85 → auto-proceed to CapCut/FFmpeg assembly
// MANUAL REVIEW: score 65-84 → hold for Rob
// HARD FAIL: score < 65 OR critical failure → back to HeyGen (max 3 retries)
//
// Critical failures: freeze in avatar, lip sync broken, audio missing, wrong avatar

// Claude API wrapper with detailed error handling

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
