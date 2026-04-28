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
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:8765', 'http://localhost:3000'];

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  res.setHeader('X-Request-ID', req.id);
  next();
});

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
app.use(require('express').json({ limit: '50mb' }));
app.use(require('express').urlencoded({ extended: true, limit: '50mb' }));

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
    _healthCache.vectcut = vectCutHealth.healthy ? { status: 'ok' } : { status: 'offline', error: vectCutHealth.error };
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
const jobsRouter        = require('./lib/routes/jobs');
const createAdminRouter = require('./lib/routes/admin');
const publishRouter     = require('./lib/routes/publish');
const heygenRouter      = require('./lib/routes/heygen');

// Mount routers — must come after middleware and _healthCache init
app.use('/', jobsRouter);
app.use('/', createAdminRouter({ _healthCache, BUILD_INFO }));
app.use('/', publishRouter);
app.use('/', heygenRouter);

// ── AI Video Generation ───────────────────────────────────────────
const { generateWanVideo, pollComfyResult, downloadComfyOutput } = require('./lib/ai/runpod');

// POST /api/generate-video
// Body: { prompt, negativePrompt?, width?, height?, numFrames?, seed? }
// Returns: { promptId } — poll GET /api/generate-video/:promptId for result
app.post('/api/generate-video', async (req, res) => {
  try {
    const { prompt, negativePrompt, width, height, numFrames, seed } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const outputPrefix = `wan_${Date.now()}`;
    const promptId = await generateWanVideo({
      positivePrompt: prompt,
      negativePrompt,
      width: width || 832,
      height: height || 480,
      numFrames: numFrames || 25,
      seed,
      outputPrefix,
    });

    res.json({ promptId, outputPrefix, status: 'queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/generate-video/:promptId
// Polls ComfyUI for job completion. Returns { status, files } when done.
app.get('/api/generate-video/:promptId', async (req, res) => {
  try {
    const { promptId } = req.params;
    const podId = process.env.RUNPOD_POD_ID;
    const base = `https://${podId}-8188.proxy.runpod.net`;

    const resp = await fetch(`${base}/history/${promptId}`);
    const history = await resp.json();

    if (!history[promptId]) return res.json({ status: 'running' });

    const info = history[promptId];
    const statusStr = info?.status?.status_str;
    if (statusStr === 'error') {
      const errMsg = info.status.messages.find((m) => m[0] === 'execution_error');
      return res.status(500).json({ status: 'error', error: errMsg?.[1]?.exception_message });
    }

    const files = [];
    for (const out of Object.values(info.outputs || {})) {
      for (const fileList of Object.values(out)) {
        for (const f of Array.isArray(fileList) ? fileList : [fileList]) {
          if (f?.filename) files.push({ filename: f.filename, url: `${base}/view?filename=${f.filename}` });
        }
      }
    }

    res.json({ status: 'success', files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
let _driveFolderId = null; // cached after first lookup (getDriveFolderId is in lib/publish.js)

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

// POST /upload-to-drive — manual trigger from dashboard
app.post('/upload-to-drive', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found: ' + filename });

  try {
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl)
      return res
        .status(400)
        .json({ error: 'cwn-drive-key.json not found in Downloads. See setup instructions.' });
    res.json({ ok: true, driveUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /drive-then-canva — upload to Drive and auto-import to Canva
app.post('/drive-then-canva', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found: ' + filename });

  res.json({ ok: true, message: 'Upload started — check /assemble-progress for status' });

  try {
    console.log(`[drive-then-canva] Starting for: ${filename}`);
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl) {
      console.warn('[drive-then-canva] No Drive key configured');
      return;
    }
    console.log(`[drive-then-canva] Drive URL: ${driveUrl}`);
    console.log(`[drive-then-canva] Paste that URL in Claude chat to import to Canva`);
  } catch (err) {
    console.error('[drive-then-canva] Error:', err.message);
  }
});

app.post(
  '/assemble',
  body('asmId').optional().isString().trim(),
  body('segments').isArray(),
  body('contentType').isString(),
  body('formType').optional().isString(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  requireFields('segments', 'segmentData'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  async (req, res) => {
    // Load job spec for this job (created at script gen time)
    const jobId = req.body.jobSpecId || req.body.asmId;
    if (jobId) {
      try {
        req.jobSpec = await getJobSpec(jobId);
      } catch (e) {
        console.warn(`[assemble] No job spec found for ${jobId} — proceeding without`);
      }
    }
    handleAssemble(req, res, saveJobCard);
  }
);

// GET /job-spec/:jobId — now in lib/routes/jobs.js

// GET /assemble-progress/:id
app.get('/assemble-progress/:id', (req, res) => {
  const job = assemblyJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Return new log lines since last poll (client tracks offset)
  const logOffset = parseInt(req.query.offset) || 0;
  const fullLog = job.log || '';
  const newLog = fullLog.slice(logOffset);

  res.json({
    pct: job.pct,
    tickerPct: job.tickerPct || null,
    status: job.status,
    error: job.error || null,
    log: newLog,
    logOffset: fullLog.length,
    outputPath: job.outputPath,
    filename: job.filename,
    duration: job.duration,
    segmentDurations: job.segmentDurations || null,
    gate2Score: job.gate2Score || null,
    gate2Outcome: job.gate2Outcome || null,
    downloadUrl: job.filename ? `/download/${job.filename}` : null,
    thumbFilename: job.thumbFilename || null,
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
        messages: [
          {
            role: 'user',
            content: `Import this video into Canva: ${videoUrl}\nLabel: ${label || 'CWN Video'}\nReturn JSON with design_id and design_url.`,
          },
        ],
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.canva.com/mcp',
            name: 'canva-mcp',
          },
        ],
      });

      // Parse response
      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock) throw new Error('No text response from Claude');

      let parsed;
      try {
        const clean = textBlock.text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch (e) {
        // Try to extract a URL from the text
        const urlMatch = textBlock.text.match(/https:\/\/www\.canva\.com\/design\/[^\s"']+/);
        if (urlMatch) {
          parsed = { design_url: urlMatch[0], status: 'success' };
        } else {
          throw new Error('Could not parse Canva response: ' + textBlock.text.slice(0, 200));
        }
      }

      canvaJobs[jobId].status = 'success';
      canvaJobs[jobId].design_url = parsed.design_url || parsed.url;
      canvaJobs[jobId].design_id = parsed.design_id;
      console.log(`[canva] Import complete: ${canvaJobs[jobId].design_url}`);
    } catch (err) {
      console.error('[canva] Import failed:', err.message);
      canvaJobs[jobId].status = 'failed';
      canvaJobs[jobId].error = err.message;
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

// getPinnedComment imported at top-level assembly require block above.

// GET /ticker-status — check which tickers are cached
app.get('/ticker-status', (req, res) => {
  res.json({
    cached: Object.keys(TICKER_CACHE),
    available: Object.keys(TICKER_MAP),
    puppeteerInstalled: (() => {
      try {
        require('puppeteer');
        return true;
      } catch (e) {
        return false;
      }
    })(),
  });
});

// POST /precapture-tickers — warm up ticker cache before assembly
// Body: { types: ['nba','news','twitch'] }  (omit to capture all)
app.post('/precapture-tickers', async (req, res) => {
  const types = (req.body && req.body.types) || Object.keys(TICKER_MAP);
  const captured = [],
    failed = [];

  console.log(`[ticker] Pre-capturing tickers: ${types.join(', ')}`);
  for (const type of types) {
    try {
      const p = await captureTicker(type);
      if (p) {
        captured.push(type);
        console.log(`[ticker] ✓ ${type}`);
      } else {
        failed.push(type);
      }
    } catch (e) {
      failed.push(type);
      console.warn(`[ticker] ✗ ${type}: ${e.message}`);
    }
  }
  res.json({ ok: true, captured, failed });
});

// POST /capture-ticker — pre-capture a ticker on demand
app.post('/capture-ticker', async (req, res) => {
  const { contentType } = req.body;
  if (!TICKER_MAP[contentType])
    return res.status(400).json({ error: 'Unknown content type. Use: nba, news, twitch' });
  delete TICKER_CACHE[contentType]; // force re-capture
  res.json({ ok: true, message: `Capturing ${contentType} ticker in background...` });
  captureTicker(contentType).catch((e) =>
    console.warn('[ticker] Background capture failed:', e.message)
  );
});

/**
 * Scrape ESPN game page for HLS manifest URL using Puppeteer.
 * ESPN uses BAMGrid/Hive player on Akamai CDN (not Brightcove).
 * HLS manifests are at service-pkgespn.akamaized.net/opp/cmaf/espn/.../*.m3u8
 * @param {string} gameId
 * @returns {Promise<{videoUrl: string, duration?: number, title?: string} | null>}
 */
async function scrapeEspnGameVideoUrl(gameId) {
  const gamePageUrl = `https://www.espn.com/nba/video/_/gameId/${gameId}`;
  let capturedHlsUrl = null;
  let browser;

  try {
    browser = await puppeteer.launch(
      withPuppeteerExecutable({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
    );
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => req.continue());
    page.on('response', async (resp) => {
      const url = resp.url();
      // ESPN uses service-pkgespn.akamaized.net for HLS manifests
      if (url.includes('service-pkgespn.akamaized.net') && url.includes('.m3u8')) {
        capturedHlsUrl = url;
        console.log(`[nba-scrape] HLS manifest captured: ${url.slice(0, 80)}...`);
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await page.goto(gamePageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Scroll to trigger lazy-loaded video player
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await new Promise((r) => setTimeout(r, 600));
    }

    // Wait up to 5s for HLS manifest intercept
    for (let i = 0; i < 10 && !capturedHlsUrl; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }

    await browser.close();
    browser = null;

    if (capturedHlsUrl) {
      console.log(
        `[nba-scrape] Puppeteer HLS captured for ${gameId}: ${capturedHlsUrl.slice(0, 80)}...`
      );
      return { videoUrl: capturedHlsUrl };
    }
  } catch (e) {
    console.warn(`[nba-scrape] Puppeteer fallback failed for ${gameId}: ${e.message}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }

  return null;
}

// downloadEspnVideo — thin wrapper around the universal downloader
// Keeping this name so existing callers don't need changes.
const { downloadVideoForAnalysis } = require('./lib/downloader');
async function downloadEspnVideo(url, outPath) {
  return downloadVideoForAnalysis(url, outPath, { maxSecs: 90 });
}

// ── GET /nba/game-clips/:gameId ────────────────────────────────────
// Returns ALL available clips for a game from ESPN Summary API.
// Used by the dashboard short-form clip picker to show the full menu.
// ── GET /twitch/clips-pool ────────────────────────────────────────────────────
// Returns recent clip metadata (thumbnails, titles, durations) for a list of
// streamers. Used by the dashboard short-form clip picker — no MP4 resolution,
// just Helix API metadata so the UI loads fast.
app.get('/twitch/clips-pool', async (req, res) => {
  const streamersParam = (req.query.streamers || '').trim();
  const clipsPerStreamer = Math.max(1, Math.min(10, parseInt(req.query.clipsPerStreamer) || 3));
  if (!streamersParam) return res.status(400).json({ error: 'streamers query param required' });

  const streamerList = streamersParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!streamerList.length) return res.status(400).json({ error: 'no streamers provided' });

  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token)
    return res.status(500).json({ error: 'TWITCH_CLIENT_ID / TWITCH_TOKEN not set' });

  try {
    // Resolve user IDs in one batch call
    const userResp = await axios.get(
      `https://api.twitch.tv/helix/users?${streamerList.map((s) => `login=${s}`).join('&')}`,
      { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    const users = userResp.data?.data || [];

    // Fetch recent clips for each resolved user in parallel
    const allClips = (
      await Promise.all(
        users.map(async (user) => {
          try {
            const clipsResp = await axios.get(
              `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${clipsPerStreamer}`,
              {
                headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
                timeout: 10000,
              }
            );
            return (clipsResp.data?.data || []).map((c) => ({
              streamer: user.display_name || user.login,
              title: c.title || 'Clip',
              thumbnail: c.thumbnail_url || '',
              duration: Math.round(c.duration || 0),
              url: c.url || '',
              slug: c.id || '',
              game: c.game_id || '',
              viewCount: c.view_count || 0,
            }));
          } catch (e) {
            console.warn(`[twitch/clips-pool] Failed for ${user.login}: ${e.message}`);
            return [];
          }
        })
      )
    ).flat();

    res.json({ ok: true, clips: allClips });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /nba/game-clips/:gameId ────────────────────────────────────────────────
app.get('/nba/game-clips/:gameId', async (req, res) => {
  const { gameId } = req.params;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  try {
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await axios.get(summaryUrl, { timeout: 10000 });
    const summaryData = summaryResp.data;

    const articleVideos = Array.isArray(summaryData.article?.video)
      ? summaryData.article.video
      : summaryData.article?.video
        ? [summaryData.article.video]
        : [];
    const topVideos = summaryData.videos || [];
    const all = [...topVideos, ...articleVideos];

    const clips = all
      .map((v) => {
        const src = v.links?.source || {};
        const url = src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href || '';
        if (!url) return null;
        return {
          headline: v.headline || v.title || 'Clip',
          duration: v.duration || 0,
          url,
          thumbnail: (typeof v.thumbnail === 'string' ? v.thumbnail : v.thumbnail?.href) || '',
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.duration - a.duration);

    res.json({ ok: true, gameId, clips });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /nba/scrape-game-highlight ─────────────────────────────────
// Scrapes the ESPN game page for the video with the highest duration
// User requirement: "video on that page with the highest duration--top left of the game_id page"
app.post('/nba/scrape-game-highlight', async (req, res) => {
  const { gameId, formType } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });
  // Short-form clips need 30-90s for split-screen. Long-form uses any duration ≥ 10s.
  const isShortFormRequest = formType === 'short';
  const minDurationSecs = isShortFormRequest ? 30 : 10;
  const maxDurationSecs = isShortFormRequest ? 90 : null;

  try {
    console.log(`[nba-scrape] Fetching highlights for gameId: ${gameId} via ESPN Summary API`);

    // Primary path: ESPN Summary API — returns Akamai HLS URLs (stable, no expiry)
    // article.video = compiled highlights reel (87-115s) — not always present
    // d.videos = individual play clips + highlights — longest duration = highlights reel
    // Puppeteer removed: d.videos Akamai HLS is reliable and doesn't require a browser
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await axios.get(summaryUrl, { timeout: 10000 });
    const summaryData = summaryResp.data;

    // Check article.video first — this is where the compiled highlights reel lives
    const articleVideos = (summaryData.article && summaryData.article.video) || [];
    if (articleVideos.length) {
      const highlight = articleVideos[0]; // First is always the Game Highlights reel
      // Prefer Akamai HLS manifest (stable, no expiring token) over direct CDN MP4 (expires in seconds)
      const hlsUrl = highlight.links?.source?.HLS?.HD?.href || highlight.links?.source?.HLS?.href;
      const directMp4 = highlight.links?.source?.HD?.href;
      const hlUrl = hlsUrl || directMp4;
      if (hlUrl) {
        console.log(
          `[nba-scrape] ✅ Gate 0 PASS: Game Highlights from article.video: "${highlight.headline}" (${highlight.duration}s) [${hlsUrl ? 'HLS' : 'direct MP4'}]`
        );
        // Download immediately — ESPN CDN URLs expire within seconds
        const tmpPathAv = path.join(__dirname, 'tmp', `nba_highlight_${gameId}_${Date.now()}.mp4`);
        let localPathAv = null;
        try {
          localPathAv = await downloadEspnVideo(hlUrl, tmpPathAv);
        } catch (e) {
          console.warn(`[nba-scrape] Download failed (will use URL fallback): ${e.message}`);
        }
        return res.json({
          ok: true,
          gate0: 'pass',
          gameId,
          videoUrl: hlUrl,
          localPath: localPathAv,
          thumbnail: (highlight.thumbnail && highlight.thumbnail.href) || '',
          title: highlight.headline || 'Game Highlights',
          description: highlight.description || '',
          duration: highlight.duration || 0,
          source: 'article.video',
        });
      }
    }

    // Step 3: Fall back to play clips (d.videos) — longest duration
    console.warn(
      `[nba-scrape] ⚠️ article.video empty — falling back to API play clips (longest duration)`
    );
    const videos = summaryData.videos || [];

    if (!videos.length) {
      // Gate 0 FAIL: Puppeteer failed and API has no videos either
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No videos found for game ${gameId} — video page Puppeteer failed and ESPN API returned empty videos[]. Game may be too recent or too old.`,
      });
    }

    console.log(
      `[nba-scrape] Found ${videos.length} API play clips for game ${gameId} — selecting ${isShortFormRequest ? 'best 30-90s clip for short-form' : 'longest clip for long-form'}`
    );

    // Step 2: Use full video pool — select best clip based on form type.
    // Long-form: select longest duration (game highlights reel is reliably longest at 115s).
    // Short-form: prefer clips in 30-90s range for split-screen; fall back to longest if none in range.
    // Keyword filtering on API metadata was removed: ESPN titles don't contain "highlight"
    // even when the page shows "Game Highlights", so the filter always returned 0 matches.
    const videoPool = videos;
    console.log(`[nba-scrape]   Using full pool of ${videoPool.length} videos`);

    // Step 3: Find best video — prefer 30-90s range for short-form, longest for long-form
    let highestDurationVideo = null;
    let maxDuration = 0;
    let shortFormPreferred = null; // best clip in 30-90s range for short-form

    for (const video of videoPool) {
      const duration = video.duration || 0;
      const title = video.headline || video.title || video.description || '';

      console.log(`[nba-scrape]   Video: "${title}" (${duration}s)`);

      // Track the longest clip (long-form selection + short-form fallback)
      if (duration > maxDuration) {
        maxDuration = duration;
        highestDurationVideo = video;
      }

      // Track best clip in 30-90s range for short-form (prefer longer within range)
      if (isShortFormRequest && duration >= minDurationSecs && duration <= maxDurationSecs) {
        if (!shortFormPreferred || duration > (shortFormPreferred.duration || 0)) {
          shortFormPreferred = video;
        }
      }
    }

    // Short-form: use preferred 30-90s clip if found, otherwise fall back to longest
    if (isShortFormRequest && shortFormPreferred) {
      highestDurationVideo = shortFormPreferred;
      maxDuration = shortFormPreferred.duration || 0;
      console.log(`[nba-scrape] Short-form: selected ${maxDuration}s clip in target 30-90s range`);
    } else if (isShortFormRequest) {
      console.warn(
        `[nba-scrape] Short-form: no clip in 30-90s range found — falling back to longest (${maxDuration}s)`
      );
    }

    if (!highestDurationVideo) {
      console.warn(`[nba-scrape] No valid video with duration found`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No video with duration >0 found for game ${gameId} — ESPN may not have processed highlights yet.`,
      });
    }

    // Step 4: Extract best quality video URL — prefer Akamai HLS (stable, no expiry)
    // over direct CDN MP4 (expires within seconds of being generated)
    const links = highestDurationVideo.links || {};
    const source = links.source || {};
    let videoUrl =
      source.HLS?.HD?.href ||
      source.HLS?.href ||
      source.HD?.href ||
      source.mezzanine?.href ||
      source.full?.href ||
      source.href ||
      links.mobile?.href ||
      '';

    // Gate 0: Validate the selected URL is usable
    // Puppeteer already ran first and failed, so no further fallback is available.
    if (!videoUrl) {
      console.error(`[nba-scrape] Gate 0 FAIL: No usable video URL found for game ${gameId}`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clip URL found for game ${gameId} — Puppeteer failed and API returned metadata but no downloadable URL. Check ESPN API response at: ${summaryUrl}`,
      });
    }

    // Gate 0: Validate duration meets minimum threshold (30s for short-form, 10s for long-form)
    if (maxDuration > 0 && maxDuration < minDurationSecs) {
      console.warn(
        `[nba-scrape] Gate 0 WARN: Best video for game ${gameId} is only ${maxDuration}s — below ${minDurationSecs}s minimum (formType: ${formType || 'long'})`
      );
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clips found for game ${gameId} — longest clip is only ${maxDuration}s (minimum: ${minDurationSecs}s for ${isShortFormRequest ? 'short-form' : 'long-form'})`,
      });
    }

    // Also extract thumbnail
    const thumbnail = highestDurationVideo.thumbnail || '';

    console.log(
      `[nba-scrape] ✅ Gate 0 PASS: Selected longest duration video: "${highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights'}" (${maxDuration}s)`
    );
    console.log(`[nba-scrape]    URL: ${videoUrl.slice(0, 80)}...`);

    // Download immediately — ESPN CDN URLs expire within seconds
    const tmpPathApi = path.join(__dirname, 'tmp', `nba_highlight_${gameId}_${Date.now()}.mp4`);
    let localPathApi = null;
    try {
      const { execFile } = require('child_process');
      const ffmpegBin = ffmpegPath();
      const ffmpegArgs = [
        '-i',
        videoUrl,
        '-t',
        '90',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '28',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-y',
        tmpPathApi,
      ];
      await new Promise((resolve, reject) => {
        execFile(ffmpegBin, ffmpegArgs, { timeout: 120000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
      const sizeApi = fs.existsSync(tmpPathApi) ? fs.statSync(tmpPathApi).size : 0;
      if (sizeApi > 1000) {
        localPathApi = tmpPathApi;
        console.log(
          `[nba-scrape] ✅ Downloaded highlight to ${tmpPathApi} (${(sizeApi / 1024 / 1024).toFixed(1)}MB)`
        );
      }
    } catch (e) {
      console.warn(`[nba-scrape] Download failed (will use URL fallback): ${e.message}`);
    }

    res.json({
      ok: true,
      gate0: 'pass',
      gameId,
      videoUrl,
      localPath: localPathApi,
      thumbnail,
      title: highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights',
      description: highestDurationVideo.description || '',
      duration: maxDuration,
      videoCount: videos.length,
      source: 'api',
    });
  } catch (err) {
    console.error(`[nba-scrape] Error:`, err.message);
    res.status(500).json({ error: err.message, gate0: 'error' });
  }
});

// ── GET /news/us-canada-videos ────────────────────────────────────
// Scrapes Al Jazeera with US & Canada editorial priority: hub page links first,
// then /us-canada/… sitemap URLs, then other sitemap articles (excludes /features/, /opinion/, /longform/).
// Returns 100% video-guaranteed stories (vs ~20-30% hit rate from global RSS feed).
// Supports NEWS_RSS_URL env var override for future RSS.app migration (Fix 30).
//
// Response: { ok, source, lookbackHours, totalFound, recentCount, videos[] }
// Each video: { url, href, title, thumbnail, publishedAt, dateString }

const NEWS_SOURCE_URL = process.env.NEWS_RSS_URL || 'https://www.aljazeera.com/us-canada/';
const NEWS_LOOKBACK_HOURS = 48; // Red 4 hotfix 2: was 24, extended to 48 to handle midnight-UTC edge case where AJ URL dates are parsed as start-of-day and every story becomes "25 hours old" after UTC midnight rolls. Paired with end-of-day timestamp parse below at line 5800.

// ── Track C: per-video validation pass ───────────────────────────────────────
// 5 checks run in parallel per video before the dashboard renders story cards.
// Results flow back as video.validation = { status, checks, issues[] }
// status: 'ok' | 'warning' | 'fail'
async function validateVideo(v) {
  const checks = {};
  const issues = [];

  // Check 1: Brightcove URL reachable (HEAD, 3s timeout)
  try {
    const headResp = await axios.head(v.url, { timeout: 3000, maxRedirects: 3 });
    checks.brightcoveReachable = headResp.status < 400;
    if (!checks.brightcoveReachable) issues.push(`Article URL returned HTTP ${headResp.status}`);
  } catch (e) {
    checks.brightcoveReachable = false;
    issues.push(`Article URL unreachable: ${e.message}`);
  }

  // Check 2: scrapeArticleVideo() full Fix 9 flow — fetch article HTML, extract
  // JSON-LD VideoObject.embedUrl (Brightcove player URL), run yt-dlp on the
  // Brightcove URL (NOT the article URL — yt-dlp doesn't support AJ article URLs
  // directly and always returns "Unsupported URL"). This is the correct pattern
  // per Fix 9's scrapeArticleVideo() helper at server.js:6710.
  //
  // Red 4 hotfix 3: Track C was calling yt-dlp directly on the article URL,
  // which fails 100% of the time because AJ /video/newsfeed/ URLs are not a
  // supported yt-dlp extractor target. Every video was marked fail on ytdlpExtract
  // regardless of actual content. Fix: reuse scrapeArticleVideo() which handles
  // the JSON-LD intermediate step.
  let hlsUrl = null;
  try {
    hlsUrl = await scrapeArticleVideo(v.url);
    checks.ytdlpExtract = !!hlsUrl;
    if (!hlsUrl)
      issues.push(
        'scrapeArticleVideo returned null (no Brightcove embed or yt-dlp failed on embed URL)'
      );
  } catch (e) {
    checks.ytdlpExtract = false;
    issues.push(`scrapeArticleVideo failed: ${e.message}`);
  }

  // Check 3 & 4: dimensions and duration are SKIPPED in Track C v1.
  // The old code path tried to read them from yt-dlp JSON output, but
  // scrapeArticleVideo() returns only the HLS manifest URL (not metadata).
  // To get dimensions/duration we'd need an additional ffprobe call on the
  // HLS manifest, which adds latency per-video. Deferred to Track C v2.
  //
  // For now: if scrapeArticleVideo() returned a non-null URL, treat dimensions
  // and duration as "passed by absence of evidence" — the article HAS a video,
  // which is the only thing that truly matters for the selection gate.
  checks.dimensionsOk = hlsUrl ? null : false;
  checks.durationOk = hlsUrl ? null : false;

  // Check 5: og:image reachable (HEAD, 3s timeout)
  if (v.thumbnail) {
    try {
      const imgResp = await axios.head(v.thumbnail, { timeout: 3000, maxRedirects: 3 });
      checks.ogImageReachable = imgResp.status < 400;
      if (!checks.ogImageReachable) issues.push(`og:image returned HTTP ${imgResp.status}`);
    } catch (e) {
      checks.ogImageReachable = false;
      issues.push(`og:image unreachable: ${e.message}`);
    }
  } else {
    checks.ogImageReachable = null; // no thumbnail to check
  }

  // Derive overall status
  const hasFail =
    checks.brightcoveReachable === false ||
    checks.ytdlpExtract === false ||
    checks.durationOk === false;
  const hasWarning =
    checks.dimensionsOk === false ||
    checks.durationOk === 'warning' ||
    checks.ogImageReachable === false;
  const status = hasFail ? 'fail' : hasWarning ? 'warning' : 'ok';

  return { ...v, validation: { status, checks, issues } };
}

// ── AJ Sitemap-driven article discovery ──────────────────────────────────────
// Fetches Al Jazeera's per-day sitemap XML, filters to US-topic news articles.
// Excludes: /liveblog/ /video/ /longform/ /podcasts/ (no video or wrong format)
// Returns array of article URL strings.
async function fetchAjSitemapUrls(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const sitemapUrl = `https://www.aljazeera.com/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  console.log(`[fetchAjSitemapUrls] Fetching ${sitemapUrl}`);
  const resp = await axios.get(sitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' },
  });

  const xml = resp.data || '';
  // Extract all <loc> URLs from the sitemap XML
  const locMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
  const allUrls = locMatches
    .map((m) => m.replace(/<\/?loc>/g, '').trim())
    .filter((u) => u.startsWith('https://www.aljazeera.com/'));

  // Exclude non-article paths — return ALL remaining articles (no topic keyword filter)
  const EXCLUDE_PATHS = ['/liveblog/', '/video/', '/longform/', '/podcasts/', '/program/'];
  const articleUrls = allUrls.filter((u) => !EXCLUDE_PATHS.some((p) => u.includes(p)));

  console.log(
    `[fetchAjSitemapUrls] ${allUrls.length} total → ${articleUrls.length} articles (all topics)`
  );
  return articleUrls;
}

/**
 * Collect article URLs linked from the US & Canada hub (editorial queue), excluding /features/ etc.
 * @returns {Promise<string[]>}
 */
const AJ_ALLOWED_SECTION_PATH_RE = /\/(where\/united-states|us-canada)\//i;

/** Dated article slug: /news/2026/4/22/… or /where/united-states/…/2026/…/… */
function ajArticleHasDatedSlugPath(pathname) {
  return /\/\d{4}\/\d{1,2}\/\d{1,2}\/[^/]+/i.test(pathname || '');
}

function ajAljazeeraArticleBaseOk(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  let p;
  try {
    p = new URL(urlStr).pathname || '';
  } catch {
    return false;
  }
  if (!/^https:\/\/(www\.)?aljazeera\.com\//i.test(urlStr)) return false;
  if (/\/(features|opinion|longform|podcasts|program|gallery)\b/i.test(p)) return false;
  if (!ajArticleHasDatedSlugPath(p)) return false;
  return true;
}

/**
 * Sitemap (and Gemini recovery): only URLs whose path is explicitly US/Canada editorial.
 * Do NOT use bare /news/… from the sitemap — those are global and not US-first.
 */
function ajArticlePathFromSitemapStrict(urlStr) {
  if (!ajAljazeeraArticleBaseOk(urlStr)) return false;
  try {
    return AJ_ALLOWED_SECTION_PATH_RE.test(new URL(urlStr).pathname || '');
  } catch {
    return false;
  }
}

/**
 * Hub queues (where/united-states + us-canada landing pages): allow /news/YYYY/MM/DD/…
 * because those links are curated on those pages (US-first queue), not raw sitemap.
 */
function ajArticlePathFromHubQueues(urlStr) {
  if (!ajAljazeeraArticleBaseOk(urlStr)) return false;
  let p;
  try {
    p = new URL(urlStr).pathname || '';
  } catch {
    return false;
  }
  return AJ_ALLOWED_SECTION_PATH_RE.test(p) || /\/news\//i.test(p);
}

async function fetchAjHubArticleUrls(hubUrl, maxUrls = 45) {
  const hub = String(hubUrl || '')
    .trim()
    .replace(/\/?$/, '/');
  if (!hub) return [];
  const resp = await axios.get(hub, {
    timeout: 25000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  const $ = cheerio.load(resp.data || '');
  const out = [];
  const badPath = (p) =>
    /\/(features|opinion|longform|podcasts|program|gallery|sport|sports)\b/i.test(p);
  const looksArticle = (p) =>
    ajArticleHasDatedSlugPath(p) && (AJ_ALLOWED_SECTION_PATH_RE.test(p) || /\/news\//i.test(p));
  $('a[href]').each((_, el) => {
    if (out.length >= maxUrls) return false;
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    let abs;
    try {
      abs = new URL(href, 'https://www.aljazeera.com').href.split('#')[0];
    } catch {
      return;
    }
    let p;
    try {
      const u = new URL(abs);
      if (!/aljazeera\.com$/i.test(u.hostname || '')) return;
      p = u.pathname || '';
    } catch {
      return;
    }
    if (badPath(p)) return;
    if (!looksArticle(p)) return;
    out.push(abs);
  });
  const uniq = [...new Set(out)];
  console.log(`[fetchAjHubArticleUrls] ${uniq.length} article URL(s) from ${hub}`);
  return uniq;
}

/** ffprobe HLS / MP4 duration (seconds); null on failure. */
function probeHlsDurationSeconds(hlsUrl) {
  return new Promise((resolve) => {
    try {
      execFile(
        ffprobePath(),
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          hlsUrl,
        ],
        { timeout: 35000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const d = parseFloat(String(stdout || '').trim(), 10);
          resolve(Number.isFinite(d) ? d : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** ffprobe HLS / MP4 stream dimensions; returns {width,height} or null on failure. */
/**
 * Brightcove master playlists list multiple RESOLUTION=WxH variants; the in-page embed
 * is often 16:9 while a 9:16 rendition exists. Pick the highest-area portrait variant URL.
 * @returns {Promise<{ hlsUrl: string, orientation: 'portrait'|'landscape', sourceWidth: number, sourceHeight: number }|null>}
 */
async function pickPortraitOrLargestVariantFromHlsMaster(masterHlsUrl) {
  if (!masterHlsUrl || typeof masterHlsUrl !== 'string') return null;
  try {
    const resp = await axios.get(masterHlsUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' },
    });
    const text = String(resp.data || '');
    if (!text.includes('#EXTM3U')) return null;
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const variants = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const resM = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwM = line.match(/BANDWIDTH=(\d+)/i);
      const uriLine = lines[i + 1];
      if (!resM || !uriLine || uriLine.startsWith('#')) continue;
      const w = parseInt(resM[1], 10);
      const h = parseInt(resM[2], 10);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
      let variantUrl = uriLine;
      if (!/^https?:\/\//i.test(variantUrl)) {
        try {
          variantUrl = new URL(variantUrl, masterHlsUrl).href;
        } catch {
          continue;
        }
      }
      variants.push({
        w,
        h,
        bandwidth: bwM ? parseInt(bwM[1], 10) : 0,
        url: variantUrl,
      });
    }
    if (variants.length === 0) return null;
    const portrait = variants.filter((v) => v.h > v.w);
    if (portrait.length > 0) {
      portrait.sort((a, b) => b.w * b.h - a.w * a.h);
      const best = portrait[0];
      return {
        hlsUrl: best.url,
        orientation: 'portrait',
        sourceWidth: best.w,
        sourceHeight: best.h,
      };
    }
    variants.sort((a, b) => b.w * b.h - a.w * a.h);
    const best = variants[0];
    return {
      hlsUrl: masterHlsUrl,
      orientation: 'landscape',
      sourceWidth: best.w,
      sourceHeight: best.h,
    };
  } catch {
    return null;
  }
}

function probeHlsDimensions(hlsUrl) {
  return new Promise((resolve) => {
    try {
      execFile(
        ffprobePath(),
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          hlsUrl,
        ],
        { timeout: 35000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const lines = String(stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (lines.length < 2) return resolve(null);
          const width = parseInt(lines[0], 10);
          const height = parseInt(lines[1], 10);
          if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            return resolve(null);
          }
          resolve({ width, height });
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/** Strip #fragment so Puppeteer navigates to a stable document URL. */
function stripAjPageFragment(url) {
  if (!url || typeof url !== 'string') return url;
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * Extra AJ pages to try first in scrapeAjNewsVideos (sitemap excludes /video/… paths).
 * Set NEWS_AJ_PINNED_URLS= (empty) or "off" to disable built-in example.
 * @returns {string[]}
 */
function getPinnedAjUrlsForScraper() {
  const raw = process.env.NEWS_AJ_PINNED_URLS;
  if (raw !== undefined) {
    const t = String(raw).trim();
    if (t === '' || t === '0' || t.toLowerCase() === 'off' || t.toLowerCase() === 'false')
      return [];
    return t
      .split(/[\n,]+/)
      .map((s) => stripAjPageFragment(s.trim()))
      .filter(Boolean);
  }
  // Default: no pinned URLs — discovery is US-Canada hub + /us-canada/ sitemap paths first.
  return [];
}

// ── AJ Puppeteer video scraper ────────────────────────────────────────────────
// Opens a Puppeteer browser, walks sitemap articles in order (today first, then
// yesterday as fallback), intercepts Brightcove API network responses to capture
// HLS URLs directly, checks manifest dimensions.
// Stops as soon as targetCount confirmed videos are found (no hard article cap).
// Returns array of { articleUrl, videoId, hlsUrl, orientation, pillarboxFilter }
// orientation: 'landscape' (16:9) | 'portrait' (9:16)
// pillarboxFilter: null for landscape, FFmpeg filter string for portrait
//
// Brightcove account: 665003303001
// HLS served at manifest.prod.boltdns.net
// forcedCandidates: optional URL list (e.g. Gemini recovery) — merged after pinned URLs
async function scrapeAjNewsVideos(targetCount = 5, forcedCandidates = null) {
  const puppeteer = require('puppeteer');
  const results = [];

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  let candidateUrls = [];
  if (Array.isArray(forcedCandidates) && forcedCandidates.length > 0) {
    candidateUrls = forcedCandidates.map((u) => stripAjPageFragment(String(u))).filter(Boolean);
    console.log(`[scrapeAjNewsVideos] Using ${candidateUrls.length} forced candidate URL(s)`);
  } else {
    try {
      const [todayUrls, yestUrls] = await Promise.all([
        fetchAjSitemapUrls(today),
        fetchAjSitemapUrls(yesterday),
      ]);
      const mergedSitemap = [...todayUrls, ...yestUrls];
      const sitemapWhereUs = mergedSitemap.filter((u) => /\/where\/united-states\//i.test(u));
      const sitemapUsCanada = mergedSitemap.filter((u) => /\/us-canada\//i.test(u));
      const sitemapAllowed = mergedSitemap.filter(
        (u) =>
          AJ_ALLOWED_SECTION_PATH_RE.test(u) &&
          !/\/features\//i.test(u) &&
          !/\/opinion\//i.test(u) &&
          !/\/longform\//i.test(u)
      );
      const primaryHubUrl =
        process.env.NEWS_US_PRIMARY_HUB_URL || 'https://www.aljazeera.com/where/united-states/';
      const fallbackHubUrl =
        process.env.NEWS_US_CANADA_HUB_URL || 'https://www.aljazeera.com/us-canada/';
      let primaryHubUrls = [];
      let fallbackHubUrls = [];
      try {
        primaryHubUrls = await fetchAjHubArticleUrls(primaryHubUrl, 50);
      } catch (e) {
        console.warn(
          `[scrapeAjNewsVideos] Primary hub fetch failed (${primaryHubUrl}): ${e.message}`
        );
      }
      try {
        fallbackHubUrls = await fetchAjHubArticleUrls(fallbackHubUrl, 50);
      } catch (e) {
        console.warn(
          `[scrapeAjNewsVideos] Fallback hub fetch failed (${fallbackHubUrl}): ${e.message}`
        );
      }
      const seen = new Set();
      const pushOrder = (arr) => {
        for (const u of arr) {
          if (!seen.has(u)) {
            seen.add(u);
            candidateUrls.push(u);
          }
        }
      };
      candidateUrls = [];
      pushOrder(primaryHubUrls);
      pushOrder(fallbackHubUrls);
      pushOrder(sitemapWhereUs);
      pushOrder(sitemapUsCanada);
      pushOrder(
        sitemapAllowed.filter(
          (u) => !/\/where\/united-states\//i.test(u) && !/\/us-canada\//i.test(u)
        )
      );
      const hubUrlSet = new Set(
        [...primaryHubUrls, ...fallbackHubUrls].map((u) => stripAjPageFragment(String(u)))
      );
      candidateUrls = candidateUrls
        .map((u) => stripAjPageFragment(String(u)))
        .filter((u) => {
          if (!u) return false;
          if (hubUrlSet.has(u)) return ajArticlePathFromHubQueues(u);
          return ajArticlePathFromSitemapStrict(u);
        });
      console.log(
        `[scrapeAjNewsVideos] Candidate order: primaryHub=${primaryHubUrls.length}, fallbackHub=${fallbackHubUrls.length}, ` +
          `sitemap where/united-states=${sitemapWhereUs.length}, sitemap /us-canada/=${sitemapUsCanada.length}, ` +
          `US-first filter (hub=/news|section, sitemap=section only) → ${candidateUrls.length} URL(s)`
      );
    } catch (e) {
      console.warn(`[scrapeAjNewsVideos] Sitemap fetch error: ${e.message}`);
      return [];
    }
  }

  const pinned = getPinnedAjUrlsForScraper();
  if (pinned.length) {
    const seen = new Set(pinned);
    const tail = candidateUrls.filter((u) => !seen.has(u));
    candidateUrls = [...pinned, ...tail];
    console.log(
      `[scrapeAjNewsVideos] Prepended ${pinned.length} pinned URL(s) (NEWS_AJ_PINNED_URLS)`
    );
  }

  if (candidateUrls.length === 0) {
    console.warn('[scrapeAjNewsVideos] No candidate URLs (sitemap + pinned empty)');
    return [];
  }

  console.log(`[scrapeAjNewsVideos] Scanning for ${targetCount} videos (no article cap)...`);

  const browser = await puppeteer.launch(
    withPuppeteerExecutable({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
  );

  try {
    for (const articleUrl of candidateUrls) {
      // Stop as soon as we have enough confirmed videos
      if (results.length >= targetCount) break;

      let capturedHls = null;
      let capturedVideoId = null;

      const page = await browser.newPage();
      try {
        // Spoof a real browser UA so AJ doesn't serve a bot-detection page
        await page.setUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
        // Pre-accept GDPR/consent so the wall doesn't stall the page load
        await page.setCookie(
          {
            name: 'OptanonAlertBoxClosed',
            value: new Date().toISOString(),
            domain: '.aljazeera.com',
            path: '/',
          },
          {
            name: 'OptanonConsent',
            value:
              'isGpcEnabled=0&datestamp=' +
              encodeURIComponent(new Date().toISOString()) +
              '&version=202209.1.0&isIABGlobal=false&hosts=&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&AwaitingReconsent=false',
            domain: '.aljazeera.com',
            path: '/',
          }
        );
        // Intercept requests: block heavy assets to speed up load, let Brightcove API through
        await page.setRequestInterception(true);
        const BLOCK_TYPES = new Set(['image', 'font', 'media']);
        const BLOCK_DOMAINS = [
          'googlesyndication.com',
          'doubleclick.net',
          'googletagmanager.com',
          'google-analytics.com',
          'facebook.net',
          'scorecardresearch.com',
          'quantserve.com',
        ];
        page.on('request', (req) => {
          const url = req.url();
          if (BLOCK_TYPES.has(req.resourceType()) || BLOCK_DOMAINS.some((d) => url.includes(d))) {
            req.abort();
          } else {
            req.continue();
          }
        });

        page.on('response', async (resp) => {
          const url = resp.url();
          // Brightcove playback API returns JSON with HLS sources
          if (
            url.includes('edge.api.brightcove.com') ||
            url.includes('/accounts/665003303001/videos/')
          ) {
            try {
              const json = await resp.json();
              const sources = json.sources || [];
              // Prefer HLS manifest (application/x-mpegURL or .m3u8)
              const hls = sources.find(
                (s) =>
                  (s.type === 'application/x-mpegURL' || (s.src && s.src.includes('.m3u8'))) &&
                  s.src &&
                  s.src.includes('manifest.prod.boltdns.net')
              );
              if (hls && hls.src && !capturedHls) {
                capturedHls = hls.src;
                capturedVideoId = json.id || url.match(/videos\/(\d+)/)?.[1] || null;
                console.log(
                  `[scrapeAjNewsVideos] Captured HLS for ${articleUrl.slice(-60)}: ${hls.src.slice(0, 80)}`
                );
              }
            } catch (_) {}
          }
        });

        await page.goto(stripAjPageFragment(articleUrl), {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        // Scroll to trigger lazy-loaded players
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Page error on ${articleUrl.slice(-60)}: ${e.message}`);
      } finally {
        await page.close();
      }

      if (!capturedHls) continue;

      // In-page Video.js is often 16:9 chrome while Brightcove master lists a 9:16 rendition — pick that variant URL.
      let orientation = 'landscape';
      let pillarboxFilter = null;
      let manifestWidth = 1920;
      let manifestHeight = 1080;
      let effectiveHls = capturedHls;
      try {
        const variantPick = await pickPortraitOrLargestVariantFromHlsMaster(capturedHls);
        if (variantPick && variantPick.orientation === 'portrait') {
          effectiveHls = variantPick.hlsUrl;
          orientation = 'portrait';
          manifestWidth = variantPick.sourceWidth;
          manifestHeight = variantPick.sourceHeight;
          pillarboxFilter = buildAjPillarboxFilter(manifestWidth, manifestHeight);
          console.log(
            `[scrapeAjNewsVideos] Portrait variant from master ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
          );
        } else {
          const probed = await probeHlsDimensions(capturedHls);
          if (probed && probed.width > 0 && probed.height > 0) {
            manifestWidth = probed.width;
            manifestHeight = probed.height;
          } else {
            const manifestResp = await axios.get(capturedHls, { timeout: 10000 });
            const manifestText = manifestResp.data || '';
            const resMatches = [...manifestText.matchAll(/RESOLUTION=(\d+)x(\d+)/g)];
            if (resMatches.length > 0) {
              const dims = resMatches.map((m) => ({
                w: parseInt(m[1], 10),
                h: parseInt(m[2], 10),
              }));
              dims.sort((a, b) => b.w * b.h - a.w * a.h);
              manifestWidth = dims[0].w;
              manifestHeight = dims[0].h;
            }
          }
          if (manifestHeight > manifestWidth) {
            orientation = 'portrait';
            pillarboxFilter = buildAjPillarboxFilter(manifestWidth, manifestHeight);
          }
        }
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Manifest check failed: ${e.message}`);
      }

      // Accept both landscape and portrait — clips go into the split-screen bottom half
      // and are cropped/scaled by FFmpeg regardless of source orientation.
      console.log(
        `[scrapeAjNewsVideos] ✅ ${orientation.toUpperCase()} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
      );

      const maxClipSec = parseFloat(process.env.NEWS_AJ_MAX_CLIP_SEC || '180', 10);
      if (Number.isFinite(maxClipSec) && maxClipSec > 0) {
        const dur = await probeHlsDurationSeconds(effectiveHls);
        if (dur != null && dur > maxClipSec + 0.25) {
          console.log(
            `[scrapeAjNewsVideos] ⏭  duration ${dur.toFixed(1)}s > ${maxClipSec}s (NEWS_AJ_MAX_CLIP_SEC): ${articleUrl.slice(-60)}`
          );
          continue;
        }
      }

      results.push({
        articleUrl: stripAjPageFragment(articleUrl),
        videoId: capturedVideoId,
        hlsUrl: effectiveHls,
        orientation,
        pillarboxFilter,
        sourceWidth: manifestWidth,
        sourceHeight: manifestHeight,
      });

      console.log(
        `[scrapeAjNewsVideos] ✅ added ${orientation} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`
      );
    }
  } finally {
    await browser.close();
  }

  const landscape = results.filter((r) => r.orientation === 'landscape').length;
  const portrait = results.filter((r) => r.orientation === 'portrait').length;
  console.log(
    `[scrapeAjNewsVideos] Done: ${results.length} with video (${landscape} landscape, ${portrait} portrait)`
  );
  return results;
}

// ── AJ pillarbox filter builder ───────────────────────────────────────────────
// Builds an FFmpeg complex filter string that:
//   1. Scale-pads a 9:16 portrait clip to 1920x1080 16:9 frame
//   2. Fills side bars with Navy #22304b
//   3. Draws 4px Gold #c7af4f seam borders between content and bars
// w/h = source clip dimensions (e.g. 1080x1920)
// Output: ready to pass as -vf value in ffmpeg call
function buildAjPillarboxFilter(w, h) {
  // Target output: 1920x1080 16:9
  const targetW = 1920;
  const targetH = 1080;

  // Scale to fit height, then pad width with navy sides
  // scale height to 1080, compute scaled width, center in 1920
  const filter = [
    // Step 1: scale to target height, preserve aspect
    `scale=-2:${targetH}`,
    // Step 2: pad to target width with navy background
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:color=0x22304b`,
    // Step 3: gold seam left border (4px, full height)
    `drawbox=x='(${targetW}-iw)/2-4':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`,
    // Step 4: gold seam right border (4px, full height)
    `drawbox=x='(${targetW}+iw)/2':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`,
  ].join(',');

  return filter;
}

app.get('/news/us-canada-videos', async (req, res) => {
  try {
    // ── Puppeteer-confirmed AJ video pool ────────────────────────────────────
    // Runs scrapeAjNewsVideos(): sitemap discovery → Puppeteer → Brightcove intercept.
    // Returns ONLY articles with confirmed HLS video URLs.
    // The dashboard shows these to the operator — text-only articles are excluded.
    // Typical results: 6-12 confirmed videos from today+yesterday's sitemap.
    console.log('[news/us-canada-videos] Running Puppeteer AJ scraper...');
    let ajVideos = await scrapeAjNewsVideos(5);
    console.log(`[news/us-canada-videos] Scraped ${ajVideos.length} confirmed video articles`);

    // ── Gate 0: Gemini recovery when scraper returns 0 videos ────────────────
    // If Puppeteer found nothing (timeouts, Brightcove not firing), ask Gemini to
    // pick the most video-likely articles from the sitemap and retry once.
    if (ajVideos.length === 0) {
      console.log(
        '[news/us-canada-videos] Gate 0: 0 videos — asking Gemini to select best candidates for retry...'
      );
      try {
        const [todayUrls, yestUrls] = await Promise.all([
          fetchAjSitemapUrls(new Date()),
          fetchAjSitemapUrls(new Date(Date.now() - 86400000)),
        ]);
        const merged = [...todayUrls, ...yestUrls].filter((u) =>
          ajArticlePathFromSitemapStrict(String(u))
        );
        const usFirst = merged.filter((u) => /\/where\/united-states\//i.test(u));
        const usCanadaNext = merged.filter((u) => /\/us-canada\//i.test(u));
        const allowedTail = merged.filter(
          (u) =>
            !/\/features\//i.test(u) &&
            !/\/opinion\//i.test(u) &&
            !/\/longform\//i.test(u) &&
            !/\/where\/united-states\//i.test(u) &&
            !/\/us-canada\//i.test(u)
        );
        const seenG = new Set();
        const ordered = [];
        for (const u of [...usFirst, ...usCanadaNext, ...allowedTail]) {
          if (!seenG.has(u)) {
            seenG.add(u);
            ordered.push(u);
          }
        }
        const allUrls = ordered.slice(0, 60);
        if (allUrls.length > 0) {
          const slugList = allUrls
            .map((u, i) => `${i + 1}. ${u.split('/').filter(Boolean).pop()}`)
            .join('\n');
          const geminiPrompt = `You are selecting news articles for a video show. From this list of Al Jazeera article slugs, pick the 8 most likely to have an embedded video (breaking news, conflict, politics, interviews tend to have video; opinion/analysis rarely do). Return ONLY a JSON array of the numbers you selected, e.g. [1,3,7,12,15,18,22,25]. No explanation.\n\n${slugList}`;
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: geminiPrompt }] }] },
            { timeout: 15000 }
          );
          const geminiText = (
            (geminiResp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('') ||
            ''
          ).trim();
          const match = geminiText.match(/\[[\d,\s]+\]/);
          if (match) {
            const indices = JSON.parse(match[0])
              .map((n) => n - 1)
              .filter((n) => n >= 0 && n < allUrls.length);
            const candidateUrls = indices.map((n) => allUrls[n]);
            console.log(
              `[news/us-canada-videos] Gate 0 Gemini picked ${candidateUrls.length} candidates — retrying scrape...`
            );
            ajVideos = await scrapeAjNewsVideos(5, candidateUrls);
            console.log(`[news/us-canada-videos] Gate 0 retry: ${ajVideos.length} videos found`);
          }
        }
      } catch (e) {
        console.warn(`[news/us-canada-videos] Gate 0 Gemini recovery failed: ${e.message}`);
      }
    }

    // Convert to the video object shape the dashboard expects
    const videos = ajVideos.map((v) => {
      const dateMatch = v.articleUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      let publishedAt = new Date().toISOString();
      if (dateMatch) {
        const [_, yyyy, mm, dd] = dateMatch;
        publishedAt = new Date(
          `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T23:59:59Z`
        ).toISOString();
      }
      const slug = v.articleUrl.split('/').filter(Boolean).pop() || '';
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

      return {
        url: v.articleUrl,
        href: v.articleUrl.replace('https://www.aljazeera.com', ''),
        title: title || '(untitled)',
        thumbnail: null,
        publishedAt,
        hlsUrl: v.hlsUrl,
        orientation: v.orientation, // 'landscape' | 'portrait'
        pillarboxFilter: v.pillarboxFilter, // null or FFmpeg filter string
      };
    });

    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const landscape = videos.filter((v) => v.orientation === 'landscape').length;
    const portrait = videos.filter((v) => v.orientation === 'portrait').length;

    const hint =
      videos.length === 0
        ? 'No clips with Brightcove HLS from US/Canada AJ paths. Causes: Puppeteer did not capture HLS, duration over NEWS_AJ_MAX_CLIP_SEC, or Gemini sitemap recovery failed (check GEMINI_API_KEY). Server logs tag [news/us-canada-videos] and [scrapeAjNewsVideos].'
        : null;

    return res.json({
      ok: true,
      videos,
      recentCount: videos.length,
      totalFound: videos.length,
      scrapedWithVideo: ajVideos.length,
      droppedNonPortrait: 0,
      hint,
      source:
        'AJ where/united-states first, fallback us-canada — Puppeteer Brightcove — landscape + portrait — duration ≤ NEWS_AJ_MAX_CLIP_SEC',
      landscape,
      portrait,
    });
  } catch (err) {
    console.error('[news/us-canada-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// ── POST /twitch-clip-url ────────────────────────────────────────
// Resolves a Twitch clip page URL or slug to a direct MP4 download URL.
// Uses Twitch's GQL API (same method used by yt-dlp, streamlink, etc.)
// Returns { ok, mp4Url, quality, slug }
//
// Body: { url } — e.g. "https://www.twitch.tv/clips/SomeClipSlug"
//            or { slug } — e.g. "SomeClipSlug"

// Use TwitchClient methods instead of standalone functions
function extractTwitchSlug(urlOrSlug) {
  return twitchClient.extractSlug(urlOrSlug);
}

async function resolveTwitchClipMp4(slug, preferQuality) {
  return twitchClient.resolveClipMp4(slug, preferQuality);
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
  } catch (err) {
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

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY; // Validated at startup

// CWN_VOICE_GUIDES moved to lib/script_gen.js (only consumer — getVoiceGuide() is in that module)

app.post('/analyze-clip', async (req, res) => {
  const { thumbnailUrl, clipTitle, streamer, game, contentType, clipUrl, viewCount } = req.body;

  if (!thumbnailUrl && !clipTitle) {
    return res.status(400).json({ error: 'thumbnailUrl or clipTitle required' });
  }
  if (!GEMINI_APIKEY) {
    return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });
  }

  const type = contentType || 'twitch';
  console.log(
    `[analyze] Starting analysis — type:${type} streamer:${streamer || '?'} clip:"${clipTitle || '?'}"`
  );

  try {
    // ── Step 1: Gemini visual analysis ──────────────────────────────
    let geminiAnalysis = '';

    if (thumbnailUrl) {
      // Download thumbnail
      let imageBase64 = '';
      let mimeType = 'image/jpeg';
      try {
        const imgResp = await axios.get(thumbnailUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
        });
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
Be factual. No editorializing.`,
        };

        const geminiPrompt = geminiPrompts[type] || geminiPrompts.twitch;

        const geminiBody = {
          contents: [
            {
              parts: [
                { text: geminiPrompt },
                { inline_data: { mime_type: mimeType, data: imageBase64 } },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
        };

        const geminiResp = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
          geminiBody,
          { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
        );

        const parts = geminiResp.data?.candidates?.[0]?.content?.parts || [];
        geminiAnalysis = parts
          .map((p) => p.text || '')
          .join('')
          .trim();
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

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: voiceGuide,
      messages: [{ role: 'user', content: claudePrompt }],
    });

    const cwnScript = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    console.log(`[analyze] CWN script generated (${cwnScript.length} chars)`);

    res.json({
      ok: true,
      geminiAnalysis,
      cwnScript,
      clipTitle,
      streamer,
      contentType: type,
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

// FULL_SCRIPT_SYSTEM moved to lib/script_gen.js (module split — only consumer)

// ── GEMINI VIDEO ANALYSIS (Files API) ────────────────────────────
// Upload video → Gemini watches full clip with audio → delete file
// Falls back to thumbnail analysis if video download/upload fails

const GEMINI_FILE_LIMIT = 34 * 1024 * 1024; // 34MB

// Use TwitchClient method
function twitchThumbToMp4(thumbnailUrl) {
  return twitchClient.thumbnailToMp4(thumbnailUrl);
}

/**
 * Scrape the Open Graph image URL from an article page.
 * Used for News TV card generation — each Al Jazeera article's og:image
 * becomes the hero image on that story's top-right TV card.
 * Fix 8B: axios + cheerio already in package.json, no new deps needed.
 *
 * @param {string} articleUrl - absolute URL to the article
 * @returns {Promise<string|null>} - the og:image URL, or null if scraping fails
 */
// ── Fix 9: Scrape real video clips from Al Jazeera articles ──────────────────
// Strategy: JSON-LD VideoObject → Brightcove embed URL → yt-dlp for HLS manifest URL.
// yt-dlp fails on article URLs directly (Unsupported URL) but succeeds on the
// Brightcove player embed URL extracted from the JSON-LD VideoObject block.
// YouTube embeds (rare, ~10% of video articles) also handled via yt-dlp's YT extractor.
// Live streams (is_live=true or duration=0) are filtered out — not usable as clips.
// Returns: absolute HLS/MP4 URL string ready for yt-dlp download, or null on failure.
// Per-article timeout: 15s. Non-fatal — story skips clip if scrape fails.

// Keep old name as alias (used in analyze-clip route)

app.post(
  '/generate-full-script',
  body('type').isString(),
  body('items').isArray(),
  body('formType').optional().isString(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  requireFields('type', 'items'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  validateArrayLength('items', 1),
  async (req, res) => {
    const { type, items } = req.body;
    // Build ajVideoPool directly from items the dashboard already scraped —
    // avoids a full second Puppeteer run that adds 3-5 minutes before Gemini starts.
    // Items from fetchCwnNewsVideos() already carry hlsUrl, orientation, pillarboxFilter.
    let ajVideoPool = [];
    if ((type === 'news' || type === 'news-short') && Array.isArray(items)) {
      ajVideoPool = items
        .filter((it) => it.hlsUrl || it.videoUrl)
        .map((it) => ({
          articleUrl: it.link || it.url || '',
          title: it.title || '',
          hlsUrl: it.hlsUrl || it.videoUrl || '',
          orientation: (it.sourceOrientation || it.orientation || 'landscape').toLowerCase(),
          pillarboxFilter: it.pillarboxFilter || null,
        }));
      console.log(
        `[/generate-full-script] ajVideoPool built from request items: ${ajVideoPool.length} videos (no re-scrape)`
      );
    }
    // Create Job Spec at job start — single document every stage reads
    try {
      const { type: contentType, formType, itemCount, title } = req.body;
      const sourceType =
        contentType === 'news' || contentType === 'news-short' ? 'site_scrape' : 'url_list';
      const sourceUrls = Array.isArray(items)
        ? items.map((it) => it.videoUrl || it.clipUrl || it.url || it.link || null).filter(Boolean)
        : [];
      req.jobSpec = await createJobSpec({
        customerId: req.body.customerId || 'c0',
        showId: req.body.showId || null,
        templateId: formType === 'short' ? 'short-form' : 'long-form',
        contentType,
        createdBy: 'dashboard',
        expectedSynth: !!req.body.expectedSynth,
        sourceType,
        sourceConfig:
          sourceType === 'site_scrape' ? { siteTarget: contentType } : { urls: sourceUrls },
        items: Array.isArray(items) ? items : [],
        title: title || null,
      });
    } catch (specErr) {
      console.warn(
        '[/generate-full-script] Job Spec creation failed (non-fatal):',
        specErr.message
      );
    }
    // Override deliverySpec platforms if caller specified them (e.g. platform selector modal)
    if (
      req.jobSpec &&
      req.body.platforms &&
      Array.isArray(req.body.platforms) &&
      req.body.platforms.length > 0
    ) {
      req.jobSpec.deliverySpec.platforms = req.body.platforms;
      console.log(
        `[/generate-full-script] deliverySpec.platforms overridden by request: ${req.body.platforms.join(', ')}`
      );
    }
    // Store the semantic jobSpecId on req so script_gen can cross-reference it into the job card
    let preGenerateAllReady = false;
    let preGenerateCommitments = {};
    if (req.jobSpec) {
      req.jobSpecId = req.jobSpec.jobId;

      // ── PRE-GENERATE GATE COMMITMENT CHECK ───────────────────────────────
      // Every gate worker runs canProduce() + commit() against this job spec
      // BEFORE production starts. All must confirm they can deliver.
      // Job ID is only confirmed after all gates sign off.
      // QA agents are also notified of the confirmed job ID and spec.
      const sep = '═'.repeat(60);
      console.log('\n' + sep);
      console.log(`[PRE-GENERATE] Job spec received — gate workers signing off`);
      console.log(`[PRE-GENERATE] Job ID:        ${req.jobSpec.jobId}`);
      console.log(`[PRE-GENERATE] Customer:      ${req.jobSpec.customerId}`);
      console.log(`[PRE-GENERATE] Template:      ${req.jobSpec.templateId}`);
      console.log(`[PRE-GENERATE] Content type:  ${req.jobSpec.contentType}`);
      console.log(
        `[PRE-GENERATE] Form factor:   ${req.jobSpec.order?.output?.formFactor} (${req.jobSpec.order?.output?.aspectRatio})`
      );
      console.log(
        `[PRE-GENERATE] Resolution:    ${req.jobSpec.order?.output?.resolution?.width}×${req.jobSpec.order?.output?.resolution?.height}`
      );
      console.log(
        `[PRE-GENERATE] Platforms:     ${req.jobSpec.deliverySpec?.platforms?.join(', ') || 'none'}`
      );
      console.log(
        `[PRE-GENERATE] Avatar ID:     ${req.jobSpec.designSpec?.avatarId?.slice(0, 8) || 'n/a'}...`
      );
      console.log(
        `[PRE-GENERATE] Expected clips:${req.jobSpec.designSpec?.expectedClipCount ?? 'n/a'}`
      );
      console.log(`[PRE-GENERATE] Chrome skin:   ${req.jobSpec.designSpec?.chrome?.skin || 'n/a'}`);
      console.log(
        `[PRE-GENERATE] Outro line:    ${req.jobSpec.designSpec?.voice?.outroLine || 'from customerConfig'}`
      );
      console.log(sep);

      // Run canProduce + commit on all gate workers
      try {
        const gates = {
          gate0: require('./lib/gates/gate0'),
          gate1: require('./lib/gates/gate1'),
          gate2: require('./lib/gates/gate2'),
          gate3a: require('./lib/gates/gate3a'),
          gate3b: require('./lib/gates/gate3b'),
          gate4: require('./lib/gates/gate4'),
          gate5: require('./lib/gates/gate5'),
        };

        let allReady = true;
        const commitments = {};

        for (const [name, gate] of Object.entries(gates)) {
          try {
            // canProduce check
            const readiness =
              typeof gate.canProduce === 'function'
                ? await Promise.resolve(gate.canProduce(req.jobSpec))
                : { ready: true, missing: [] };

            // commit declaration
            const commitment =
              typeof gate.commit === 'function'
                ? await Promise.resolve(gate.commit(req.jobSpec))
                : { committed: 'no commit() defined' };

            const ready = readiness.ready !== false;
            commitments[name] = { ready, commitment };

            if (!ready) {
              allReady = false;
              console.log(
                `[${name.toUpperCase()}] ❌ NOT READY: ${(readiness.missing || readiness.reasons || []).map((m) => m.item || m).join(', ')}`
              );
            } else {
              const summary = commitment?.summary || commitment?.committed || 'ready';
              console.log(`[${name.toUpperCase()}] ✅ SIGNED OFF: ${summary}`);
            }
          } catch (gErr) {
            console.log(`[${name.toUpperCase()}] ⚠️  Sign-off error (non-fatal): ${gErr.message}`);
          }
        }

        console.log(sep);
        if (allReady) {
          console.log(
            `[PRE-GENERATE] ✅ ALL GATES SIGNED OFF — Job confirmed: ${req.jobSpec.jobId}`
          );
          console.log(`[PRE-GENERATE] 🚀 Production starting — notifying all QA agents`);
          console.log(`[PRE-GENERATE] QA agents briefed on job: ${req.jobSpec.jobId}`);
          console.log(
            `[PRE-GENERATE] Gate thresholds: G1≥${req.jobSpec.designSpec?.qaThresholds?.gate1?.pass} G2≥${req.jobSpec.designSpec?.qaThresholds?.gate2?.pass} G3a≥${req.jobSpec.designSpec?.qaThresholds?.gate3a?.pass} G4≥${req.jobSpec.designSpec?.qaThresholds?.gate4?.pass}`
          );
        } else {
          console.log(`[PRE-GENERATE] ⚠️  Some gates not ready — job proceeding with warnings`);
          console.log(`[PRE-GENERATE] Kill this job if critical gates failed`);
        }
        console.log(sep + '\n');

        // Emit job confirmed event on pipeline bus for monitoring
        pipelineBus.emit('job:confirmed', {
          jobId: req.jobSpec.jobId,
          contentType: req.jobSpec.contentType,
          templateId: req.jobSpec.templateId,
          jobSpec: req.jobSpec, // full jobSpec for gate prepare() pre-work
          commitments,
          allReady,
        });

        // NR: job confirmed event — queryable per customer/content type
        nrJobConfirmed(req.jobSpec, allReady);

        preGenerateAllReady = allReady;
        preGenerateCommitments = commitments;
        try {
          persistJobSpecGateContracts(req.jobSpec, commitments);
        } catch (contractErr) {
          console.warn(
            '[PRE-GENERATE] Failed to persist gate contracts (non-fatal):',
            contractErr.message
          );
        }
      } catch (commitErr) {
        console.warn('[PRE-GENERATE] Gate sign-off check failed (non-fatal):', commitErr.message);
      }

      // ── QA generate confirm (monitor + optional enforce) ─────────────────
      // Gate workers sign off above; this tracks whether QA should also ack before generate (policy).
      try {
        const qaGen = require('./lib/qa_generate_confirm');
        qaGen.persistAfterPreGenerate(req.jobSpec.jobId, {
          allReady: preGenerateAllReady,
          commitments: preGenerateCommitments,
        });
        const policyOn = qaGen.isPolicyEnabled();
        pipelineBus.emit('qa:generate_confirm_policy', {
          jobId: req.jobSpec.jobId,
          contentType: req.jobSpec.contentType,
          templateId: req.jobSpec.templateId,
          policyEnabled: policyOn,
          gateWorkersAllReady: preGenerateAllReady,
          monitorNote: policyOn
            ? 'QA_CONFIRM_ON_GENERATE: require qaGenerateConfirmed on this POST or POST /job/:id/qa-confirm-generate'
            : 'QA generate confirm not required — set QA_CONFIRM_ON_GENERATE=true to enforce QA ack like gate sign-off',
        });
        nrQaGenerateConfirmPolicy(req.jobSpec, {
          policyEnabled: policyOn,
          gateWorkersAllReady: preGenerateAllReady,
        });
        if (policyOn) {
          // Same POST must include qaGenerateConfirmed (each generate creates a new jobId — no separate round-trip yet).
          if (!qaGen.requestSaysConfirmed(req.body)) {
            return res.status(422).json({
              error:
                'QA_CONFIRM_ON_GENERATE is enabled: include qaGenerateConfirmed: true on this POST after QA agents agree (same request as gate sign-off). Optional: POST /job/:jobId/qa-confirm-generate for manual DB ack when reusing a job id.',
              needsQaGenerateConfirm: true,
              jobId: req.jobSpec.jobId,
              gateWorkersAllReady: preGenerateAllReady,
            });
          }
          qaGen.markConfirmed(req.jobSpec.jobId, { source: 'request_body' });
        }
      } catch (qaErr) {
        console.warn(
          '[generate-full-script] QA generate confirm hook failed (non-fatal):',
          qaErr.message
        );
      }
    }
    handleGenerateFullScript(req, res, saveJobCard, startHeyGenPoller, ajVideoPool);
  }
);

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

  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
  let existingGuides = {};
  try {
    existingGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
  } catch (e) {}

  const results = {};
  const errors = {};

  for (const [contentType, urls] of Object.entries(library)) {
    if (!urls || !urls.length) continue;
    console.log(`[style-library] Analyzing ${urls.length} reference videos for: ${contentType}`);

    const videoAnalyses = [];
    for (const url of urls) {
      if (!url || !url.startsWith('http')) continue;
      try {
        // Download video sample (first 32MB) for Gemini analysis
        const tmpPath = path.join(
          TMP_DIR,
          `ref_${contentType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`
        );
        const MAX_BYTES = 32 * 1024 * 1024;

        console.log(`[style-library] Downloading: ${url.slice(0, 80)}...`);
        await new Promise((res, rej) => {
          const { execFile } = require('child_process');
          const args = [
            '--quiet',
            '--no-warnings',
            '-f',
            'best[ext=mp4][filesize<33M]/best[filesize<33M]/best',
            '--max-filesize',
            '33m',
            '-o',
            tmpPath,
            '--no-playlist',
            '--no-part',
          ];
          execFile('yt-dlp', args.concat([url]), { timeout: 90000 }, (err, stdout, stderr) => {
            if (err) rej(new Error(`yt-dlp: ${stderr || err.message}`));
            else res();
          });
        });

        if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) {
          console.warn(`[style-library] Download failed for ${url}`);
          try {
            fs.unlinkSync(tmpPath);
          } catch (e) {}
          continue;
        }

        // Cap at 32MB
        const stat = fs.statSync(tmpPath);
        if (stat.size > MAX_BYTES) {
          const buf = fs.readFileSync(tmpPath).slice(0, MAX_BYTES);
          fs.writeFileSync(tmpPath, buf);
        }

        console.log(
          `[style-library] Uploading ${(fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1)}MB to Gemini...`
        );
        const geminiFile = await waitForGeminiFile(await uploadToGeminiFiles(tmpPath));

        // 2x VIEWING: Watch each reference video 2 times for style learning
        console.log(`[style-library] Starting 2x viewing analysis for ${url.slice(0, 60)}...`);
        const multipleViewings = [];

        for (let viewNum = 1; viewNum <= 2; viewNum++) {
          const stylePrompt = `You are analyzing a reference video to extract a STYLE FINGERPRINT for Bobby G, the host of ClipzWorld News (CWN), a "${contentType}" show.

Bobby G's voice blend: Norm MacDonald (flat deadpan, never explains the joke) + Jon Stewart Daily Show (one alarming observation, controlled disbelief) + Stuart Scott ESPN (cultural authority, rhythm, cadence) + Space Ghost Coast to Coast (non-sequitur pivots are fine, chaos is fine).

Bobby G NEVER does: hype phrases ("What's up everyone!"), exclamation energy, "This is insane!", "You won't believe this", audience callouts ("Drop a comment below"), explaining the joke, or warm enthusiasm.

This is VIEWING #${viewNum} of 2. ${viewNum === 1 ? 'Watch this video carefully for the first time.' : 'Focus on details you may have missed in the first viewing — extract nuanced stylistic details and recurring patterns.'}

Extract ONLY what applies to Bobby G's voice. Focus on:
1. SENTENCE STRUCTURE: How short? How flat? State-the-fact pattern?
2. TIMING & PACING: Where does the host pause? How long after a clip before speaking?
3. OBSERVATION STYLE: Does the host make it MORE alarming or just note the absurdity?
4. TRANSITION STRUCTURE: How does it move between topics? One word? One sentence?
5. HUMOR TECHNIQUE: Understatement? Non-sequitur? Deadpan? What specifically?
6. WHAT THIS HOST DOES NOT DO: Explicit list of avoided behaviors
7. RHYTHM PATTERNS: Sentence length variation, [beat] placement, trailing off vs punchy endings

Do NOT extract: energy level, catchphrases, audience engagement tactics, hype language, or anything that conflicts with flat deadpan delivery. Those are surface features of the performer, not the voice Bobby G uses.`;

          // Retry up to 3 times on 503 with exponential backoff
          let genResp = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              genResp = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
                {
                  contents: [
                    {
                      parts: [
                        { text: stylePrompt },
                        { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } },
                      ],
                    },
                  ],
                  generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
              );
              break; // success
            } catch (retryErr) {
              const is503 = retryErr.response && retryErr.response.status === 503;
              if (is503 && attempt < 3) {
                const backoff = attempt * 15000; // 15s, 30s
                console.warn(
                  `[style-library]   ⚠️ 503 on viewing ${viewNum} attempt ${attempt} — retrying in ${backoff / 1000}s`
                );
                await new Promise((r) => setTimeout(r, backoff));
              } else {
                throw retryErr;
              }
            }
          }

          const observation = (genResp.data?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || '')
            .join('')
            .trim();
          if (observation.length > 100) {
            multipleViewings.push(`--- VIEWING #${viewNum} ---\n${observation}`);
            console.log(
              `[style-library]   ✓ Viewing ${viewNum}/2 complete (${observation.length} chars)`
            );
          }

          // Rate limit pause between viewings (shorter than between videos)
          if (viewNum < 2) await new Promise((r) => setTimeout(r, 2000));
        }

        // Synthesize all 2 viewings into a deep per-video analysis
        if (multipleViewings.length >= 1) {
          // Require at least 1 successful viewing
          const deepSynthesisPrompt = `You watched this "${contentType}" reference video ${multipleViewings.length} times and extracted style observations for Bobby G, host of ClipzWorld News.

Bobby G's voice: Norm MacDonald deadpan + Jon Stewart controlled disbelief + Stuart Scott cultural authority. Flat. Never explains the joke. State the fact, one observation, done.

Here are your ${multipleViewings.length} viewing observations:
${multipleViewings.join('\n\n')}

Synthesize these into ONE DEEP style analysis — but filter everything through Bobby G's voice constraints:
- Keep: sentence structure, timing patterns, observation technique, transition rhythm, deadpan moves
- Discard: hype energy, audience callouts, exclamation delivery, warm enthusiasm, catchphrase energy
- Identify patterns that appeared across multiple viewings
- Be specific and actionable — a Gemini model should read this and write flat deadpan scripts
Max 600 words.`;

          try {
            const { Anthropic } = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const msg = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 800,
              messages: [{ role: 'user', content: deepSynthesisPrompt }],
            });
            const deepAnalysis = msg.content[0]?.text || multipleViewings.join('\n\n');
            videoAnalyses.push(
              `--- Reference video (2x viewing): ${url.slice(0, 60)} ---\n${deepAnalysis}`
            );
            console.log(
              `[style-library] ✅ 2x analysis complete for ${url.slice(0, 60)} (${deepAnalysis.length} chars)`
            );
          } catch (e) {
            // Fallback: concatenate all viewings
            videoAnalyses.push(
              `--- Reference video (2 viewings): ${url.slice(0, 60)} ---\n${multipleViewings.join('\n\n')}`
            );
            console.log(
              `[style-library] ✅ 2x analysis complete (fallback) for ${url.slice(0, 60)}`
            );
          }
        } else {
          console.warn(
            `[style-library] Only ${multipleViewings.length}/2 viewings succeeded, skipping video`
          );
        }

        // Cleanup
        try {
          fs.unlinkSync(tmpPath);
        } catch (e) {}
        try {
          await axios.delete(
            `https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`
          );
        } catch (e) {}

        // Rate limit pause between videos — longer to avoid 503s on rapid succession
        await new Promise((r) => setTimeout(r, 5000));
      } catch (e) {
        console.warn(`[style-library] Failed for ${url}: ${e.message}`);
        errors[url] = e.message;
      }
    }

    if (videoAnalyses.length > 0) {
      // Synthesize all analyses into one coherent style guide
      const isShortForm = contentType.endsWith('-short');
      const shortConstraints = isShortForm
        ? `

SHORT-FORM SPECIFIC RULES (this is a 45-60 second vertical video):
- ONE clip, ONE observation, done — no callbacks, no multi-part builds
- Every sentence must earn its place — cut anything that doesn't land immediately
- No setup longer than 2 sentences before the clip
- Post-clip reaction: maximum 2 sentences
- [beat] used once maximum per script
- Must feel complete in under 60 seconds`
        : '';

      const synthesisPrompt = `You analyzed ${videoAnalyses.length} reference videos for Bobby G, host of ClipzWorld News (CWN) "${contentType}" show.

Bobby G's voice: Norm MacDonald deadpan + Jon Stewart controlled disbelief + Stuart Scott cultural authority + Space Ghost non-sequitur. Flat delivery. Never explains the joke. Never hypes. State the fact, one observation, done.${shortConstraints}

Here are the individual analyses:
${videoAnalyses.join('\n\n')}

Write a UNIFIED STYLE GUIDE for Bobby G's "${contentType}" scripts. Extract the structural, rhythmic, and comedic patterns from the reference videos that are COMPATIBLE with Bobby G's flat deadpan delivery.

INCLUDE:
- Sentence structure patterns (how short, how flat, state-fact-then-observation)
- Timing cues (where [beat] pauses belong, how long after a clip before speaking)
- Transition structure (one word? one sentence? non-sequitur pivot?)
- Observation technique (make it more alarming, not less — never explain)
- What this voice NEVER does (explicit do-not list)

DO NOT INCLUDE:
- Hype phrases, exclamation energy, audience callouts
- "What's up everyone", "This is insane", "You won't believe"
- Warm enthusiasm or cheerleader energy
- Anything that contradicts flat deadpan delivery

Format as clear bullet points under clear headings. Max 400 words. This will be injected into every "${contentType}" script generation prompt.`;

      try {
        const { Anthropic } = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{ role: 'user', content: synthesisPrompt }],
        });
        const styleGuide = msg.content[0]?.text || videoAnalyses.join('\n\n');
        existingGuides[contentType] = styleGuide;
        results[contentType] = {
          ok: true,
          videoCount: videoAnalyses.length,
          chars: styleGuide.length,
        };
        console.log(
          `[style-library] ✅ Style guide for ${contentType}: ${styleGuide.length} chars`
        );
      } catch (e) {
        // Fallback: just concatenate analyses
        existingGuides[contentType] = videoAnalyses.join('\n\n');
        results[contentType] = { ok: true, videoCount: videoAnalyses.length, fallback: true };
      }
    } else {
      results[contentType] = { ok: false, error: 'No videos could be analyzed' };
    }

    // Pause between content types to avoid Gemini 503 rate limits
    await new Promise((r) => setTimeout(r, 15000));
  }

  // Save style guides to disk
  fs.writeFileSync(STYLE_GUIDE_PATH, JSON.stringify(existingGuides, null, 2));
  console.log(`[style-library] Saved style guides to ${STYLE_GUIDE_PATH}`);

  res.json({ ok: true, results, errors, guidePath: STYLE_GUIDE_PATH });
});

// ── GET /style-library ────────────────────────────────────────────
// Returns currently stored style guides
app.get('/style-library', (req, res) => {
  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
  try {
    const guides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    res.json({ ok: true, guides, path: STYLE_GUIDE_PATH });
  } catch (e) {
    res.json({ ok: true, guides: {}, message: 'No style guides yet — run Teaching Pass first' });
  }
});

// ── Publishing Routes ─────────────────────────────────────────────

// /publish/*, /upload-status, /heygen/*, /log-heygen-metrics — now in lib/routes/publish.js + lib/routes/heygen.js
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
    timeout: 30000,
  });
  return resp.data;
}

// Active CapCut drafts: draftId → { segments: [], width, height, fps }
const capcutDrafts = {};

// GET /capcut/health — check if CapCut MCP server is running
app.get('/capcut/health', async (req, res) => {
  try {
    const resp = await axios.post(`${CAPCUT_URL}/health`, {}, { timeout: 5000 });
    res.json({ ok: true, capcut: 'online', url: CAPCUT_URL, data: resp.data });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: 'CapCut MCP server not running',
      url: CAPCUT_URL,
      hint: 'Start the CapCut MCP server on port 9001',
      details: e.message,
    });
  }
});

// POST /capcut/init — create a new CapCut draft for a job
app.post('/capcut/init', async (req, res) => {
  const { jobId, contentType = 'twitch', format = 'landscape' } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const width = format === 'portrait' ? 1080 : 1920;
  const height = format === 'portrait' ? 1920 : 1080;
  const fps = 30;

  try {
    const result = await capcut('/create_draft', { width, height, fps });
    const draftId = result?.result?.draft_id || result?.draft_id;
    if (!draftId)
      return res.status(500).json({ error: 'CapCut did not return draft_id', raw: result });

    capcutDrafts[jobId] = { draftId, segments: [], width, height, fps, contentType, format };
    console.log(`[capcut] ✅ Draft created for job ${jobId}: ${draftId}`);
    res.json({ ok: true, draftId, jobId });
  } catch (e) {
    console.error('[capcut] Init failed:', e.message);
    res.status(500).json({ error: e.message, hint: 'Is CapCut MCP server running on port 9001?' });
  }
});

// POST /capcut/add-segment — add a segment to the draft as it arrives
// Call this for each HeyGen avatar segment as it completes AND each source clip
app.post('/capcut/add-segment', async (req, res) => {
  const { jobId, segmentUrl, segmentType = 'avatar', label = '', localPath = '' } = req.body;
  if (!jobId || (!segmentUrl && !localPath))
    return res.status(400).json({ error: 'jobId + segmentUrl or localPath required' });

  const draft = capcutDrafts[jobId];
  if (!draft)
    return res
      .status(404)
      .json({ error: `No draft found for job ${jobId} — call /capcut/init first` });

  const position = draft.segments.length;
  const url = localPath || segmentUrl;

  try {
    // Get duration first
    const dur = await new Promise((resolve) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        url,
      ];
      execFile(ffprobePath(), args, (err, stdout) => {
        resolve(parseFloat(stdout) || 10);
      });
    });

    const result = await capcut('/add_video', {
      draft_id: draft.draftId,
      video_url: url,
      start: 0,
      end: dur,
      volume: segmentType === 'source_clip' ? 0.7 : 1.0, // source clips slightly quieter
      transition: position > 0 ? 'cut' : undefined,
    });

    draft.segments.push({ url, type: segmentType, label, duration: dur, position });
    console.log(`[capcut] ✅ Added segment ${position + 1} (${segmentType}): ${label}`);
    res.json({
      ok: true,
      position: position + 1,
      totalSegments: draft.segments.length,
      duration: dur,
    });
  } catch (e) {
    console.error(`[capcut] Add segment failed for ${label}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /capcut/ticker — add scrolling ticker text overlay to draft
app.post('/capcut/ticker', async (req, res) => {
  const {
    jobId,
    tickerText = 'CLIPZWORLD NEWS  •  THE DAILY UPDATE  •  @clipznashite  •  ',
    totalDuration,
  } = req.body;
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
      animation: 'scroll_left',
    });

    console.log(`[capcut] ✅ Ticker added to draft ${draft.draftId}`);
    res.json({ ok: true });
  } catch (e) {
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
      scale_y: 0.85,
    });

    console.log(`[capcut] ✅ Logo bug added`);
    res.json({ ok: true });
  } catch (e) {
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
    setTimeout(() => {
      delete capcutDrafts[jobId];
    }, 3600000);

    res.json({
      ok: true,
      draftId: draft.draftId,
      draftUrl,
      totalSegments: draft.segments.length,
      instructions: 'Open CapCut → File → Open Project → select draft → Export',
    });
  } catch (e) {
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
    segments: draft.segments.map((s) => ({ label: s.label, type: s.type, duration: s.duration })),
  });
});

// ── Phase 2.2: Portrait Thumbnail Frame Extraction ────────────────
// POST /thumbnail-short
// Body: { videoPath, contentType, jobId }
// Finds highest-motion frame in assembled short-form video, applies
// "BECAUSE THE LIGHT WAS ON" tagline + episode number overlay.
// Output: thumbnail_short_{type}_ep{N}_{timestamp}.png in ./output/
app.post('/thumbnail-short', async (req, res) => {
  const { videoPath, contentType = 'twitch', jobId = '' } = req.body;
  if (!videoPath) return res.status(400).json({ error: 'videoPath required' });

  const localPath = videoPath.startsWith('http')
    ? path.join(TMP_DIR, `thumb_src_${Date.now()}.mp4`)
    : videoPath;

  try {
    // Download if remote URL
    if (videoPath.startsWith('http')) {
      console.log(`[thumbnail-short] Downloading video for frame extraction...`);
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(localPath);
        const protocol = videoPath.startsWith('https') ? require('https') : require('http');
        protocol
          .get(videoPath, (response) => {
            response.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve();
            });
          })
          .on('error', reject);
      });
    }

    // Get video duration
    const duration = await probeDuration(localPath);
    console.log(`[thumbnail-short] Video duration: ${duration.toFixed(2)}s`);

    // Find highest-motion frame using ffprobe scene detection
    // scene=0.3 threshold — picks frames with significant visual change
    let bestTimestamp = duration * 0.3; // fallback: 30% mark
    try {
      const sceneData = await new Promise((resolve, reject) => {
        const args = [
          '-i',
          localPath,
          '-vf',
          'select=gt(scene\\,0.3),showinfo',
          '-vsync',
          'vfr',
          '-f',
          'null',
          '-',
        ];
        execFile(
          ffprobePath(),
          [
            '-v',
            'quiet',
            '-show_frames',
            '-select_streams',
            'v',
            '-read_intervals',
            `%+${Math.min(duration, 60)}`,
            '-show_entries',
            'frame=pkt_pts_time,pict_type',
            '-of',
            'csv=p=0',
            localPath,
          ],
          { maxBuffer: 10 * 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            // Parse frame timestamps — find I-frames (scene changes)
            const lines = stdout.trim().split('\n').filter(Boolean);
            const iFrames = lines
              .map((l) => {
                const parts = l.split(',');
                return { t: parseFloat(parts[0]), type: parts[1] };
              })
              .filter((f) => f.type === 'I' && f.t > 3 && f.t < duration - 3); // skip first/last 3s
            if (iFrames.length > 0) {
              // Pick the I-frame closest to 40% mark (usually peak action)
              const target = duration * 0.4;
              iFrames.sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target));
              resolve(iFrames[0].t);
            } else {
              resolve(null);
            }
          }
        );
      });
      if (sceneData !== null) {
        bestTimestamp = sceneData;
        console.log(
          `[thumbnail-short] Best frame at ${bestTimestamp.toFixed(2)}s (scene detection)`
        );
      } else {
        console.log(
          `[thumbnail-short] Scene detection found no I-frames — using 30% mark (${bestTimestamp.toFixed(2)}s)`
        );
      }
    } catch (e) {
      console.warn(`[thumbnail-short] Scene detection failed: ${e.message} — using fallback`);
    }

    // Get episode counter for this content type
    const epCounters = (() => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(__dirname, 'data/episode_counters.json'), 'utf8')
        );
      } catch (e) {
        return {};
      }
    })();
    const epKey = `${contentType}_short`;
    const epNum = (epCounters[epKey] || 0) + 1;
    epCounters[epKey] = epNum;
    try {
      fs.writeFileSync(
        path.join(__dirname, 'data/episode_counters.json'),
        JSON.stringify(epCounters, null, 2)
      );
    } catch (e) {}

    // Build output path
    const outDir = OUTPUT_DIR;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = Date.now();
    const outFile = `thumbnail_short_${contentType}_ep${epNum}_${ts}.png`;
    const outPath = path.join(outDir, outFile);

    // Extract frame + apply overlays in one FFmpeg pass
    // Overlays: "BECAUSE THE LIGHT WAS ON" tagline (bottom) + "EP N" badge (top-left)
    const tagline = 'BECAUSE THE LIGHT WAS ON';
    const epLabel = `EP ${epNum}`;

    // Check if we have a font available
    const fontPath = '/System/Library/Fonts/Supplemental/BebasNeue-Regular.ttf';
    const fallbackFont = '/System/Library/Fonts/Helvetica.ttc';
    const useFont = fs.existsSync(fontPath) ? fontPath : fallbackFont;

    const drawTextFilters = [
      // Dark gradient overlay at bottom for tagline readability
      `drawbox=x=0:y=1560:w=1080:h=360:color=black@0.55:t=fill`,
      // Tagline: "BECAUSE THE LIGHT WAS ON" — centered, bottom area
      `drawtext=fontfile='${useFont}':text='${tagline}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=1680:shadowcolor=black:shadowx=2:shadowy=2`,
      // Episode badge: "EP N" — top-left, gold
      `drawtext=fontfile='${useFont}':text='${epLabel}':fontsize=36:fontcolor=#c7af4f:x=20:y=20:shadowcolor=black:shadowx=1:shadowy=1`,
    ].join(',');

    await new Promise((resolve, reject) => {
      const args = [
        '-ss',
        bestTimestamp.toFixed(3),
        '-i',
        localPath,
        '-vframes',
        '1',
        '-vf',
        drawTextFilters,
        '-q:v',
        '2',
        '-y',
        outPath,
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`))
      );
      proc.on('error', reject);
    });

    console.log(`[thumbnail-short] ✅ Thumbnail saved: ${outPath}`);

    // Clean up downloaded temp file
    if (videoPath.startsWith('http')) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) {}
    }

    res.json({
      ok: true,
      thumbnailPath: outPath,
      thumbnailUrl: `/download/${outFile}`,
      episode: epNum,
      frameTimestamp: bestTimestamp,
      contentType,
    });
  } catch (e) {
    console.error(`[thumbnail-short] Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Phase 2.3: TikTok / Reels Safety Zone Validation ─────────────
// POST /safety-zone-check
// Body: { jobId, contentType, avatarFaceX, avatarFaceY }
// Validates Bobby G avatar face position doesn't overlap platform UI buttons.
// Returns: { safe: true/false, warnings: [], zones: { tiktok, reels } }
//
// Safe zones per VISUAL_DESIGN_SPEC.md:
//   TikTok: avoid bottom-right 200×400px (x=880, y=1520)
//   Reels:  avoid bottom 150px (y=1770)
app.post('/safety-zone-check', (req, res) => {
  const {
    jobId = '',
    contentType = 'twitch',
    // Avatar face center — defaults to center of AVATAR_ZONE (540, 1200)
    avatarFaceX = 540,
    avatarFaceY = 1200,
    // Avatar face radius for overlap detection (pixels)
    avatarFaceRadius = 120,
  } = req.body;

  const SAFETY_ZONES = {
    tiktok: { x: 880, y: 1520, w: 200, h: 400, label: 'TikTok like/share/comment buttons' },
    reels: { x: 0, y: 1770, w: 1080, h: 150, label: 'Instagram Reels caption area' },
  };

  const warnings = [];
  const results = {};

  for (const [platform, zone] of Object.entries(SAFETY_ZONES)) {
    // Check if avatar face circle overlaps the UI zone rectangle
    // Simple AABB + circle overlap: closest point on rect to circle center
    const closestX = Math.max(zone.x, Math.min(avatarFaceX, zone.x + zone.w));
    const closestY = Math.max(zone.y, Math.min(avatarFaceY, zone.y + zone.h));
    const distX = avatarFaceX - closestX;
    const distY = avatarFaceY - closestY;
    const distance = Math.sqrt(distX * distX + distY * distY);
    const overlaps = distance < avatarFaceRadius;

    results[platform] = {
      safe: !overlaps,
      zone,
      avatarFace: { x: avatarFaceX, y: avatarFaceY, radius: avatarFaceRadius },
      distance: Math.round(distance),
      margin: Math.round(distance - avatarFaceRadius),
    };

    if (overlaps) {
      const msg = `⚠️ [safety-zone] ${platform.toUpperCase()} OVERLAP DETECTED — avatar face at (${avatarFaceX}, ${avatarFaceY}) overlaps ${zone.label} (${zone.x},${zone.y} ${zone.w}×${zone.h}). Distance: ${Math.round(distance)}px, radius: ${avatarFaceRadius}px`;
      warnings.push(msg);
      console.warn(msg);
    } else {
      console.log(
        `[safety-zone] ✅ ${platform.toUpperCase()} safe — avatar face ${Math.round(distance)}px from UI zone (margin: ${Math.round(distance - avatarFaceRadius)}px)`
      );
    }
  }

  const allSafe = warnings.length === 0;
  res.json({
    ok: true,
    safe: allSafe,
    jobId,
    contentType,
    warnings,
    zones: results,
    recommendation: allSafe
      ? '✅ Avatar position is safe for all platforms'
      : '⚠️ Avatar overlaps platform UI — flag for Rob review before publishing',
  });
});

// ── Phase 2: CapCut Thumbnail Extraction ──────────────────────────
// POST /capcut/thumbnail
// Body: { jobId, videoPath, timestamp }
// Extracts a frame from the assembled video and adds it to the CapCut draft as cover
app.post('/capcut/thumbnail', async (req, res) => {
  const { jobId, videoPath, timestamp } = req.body;
  if (!jobId || !videoPath) return res.status(400).json({ error: 'jobId and videoPath required' });

  const draft = capcutDrafts[jobId];
  if (!draft)
    return res.status(404).json({ error: `No draft for ${jobId} — call /capcut/init first` });

  try {
    // Extract frame at given timestamp (or 30% mark)
    const duration = await probeDuration(videoPath);
    const ts = timestamp || duration * 0.3;
    const thumbPath = path.join(TMP_DIR, `capcut_thumb_${jobId}_${Date.now()}.png`);

    await new Promise((resolve, reject) => {
      const args = [
        '-ss',
        ts.toFixed(3),
        '-i',
        videoPath,
        '-vframes',
        '1',
        '-q:v',
        '2',
        '-y',
        thumbPath,
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`))
      );
      proc.on('error', reject);
    });

    // Send thumbnail to CapCut draft as cover image
    const thumbUrl = `http://localhost:3000/download/${path.basename(thumbPath)}`;
    // Copy to output dir so it's accessible via /download/
    const outThumbPath = path.join(OUTPUT_DIR, path.basename(thumbPath));
    fs.copyFileSync(thumbPath, outThumbPath);

    await capcut('/add_image', {
      draft_id: draft.draftId,
      image_url: thumbUrl,
      start: 0,
      end: 1,
      transform_x: 0,
      transform_y: 0,
      scale_x: 1.0,
      scale_y: 1.0,
      is_cover: true,
    });

    try {
      fs.unlinkSync(thumbPath);
    } catch (e) {}
    console.log(`[capcut/thumbnail] ✅ Cover frame set at ${ts.toFixed(2)}s`);
    res.json({ ok: true, timestamp: ts, thumbUrl });
  } catch (e) {
    console.error('[capcut/thumbnail] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Phase 2: Short-Form Assembly Status ───────────────────────────
// GET /short-form-status/:jobId
// Returns current status of a short-form assembly job
app.get('/short-form-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const asmJob = assemblyJobs[jobId];
  if (!asmJob) return res.status(404).json({ error: 'No assembly job found', jobId });
  res.json({
    ok: true,
    jobId,
    status: asmJob.status || 'unknown',
    pct: asmJob.pct || 0,
    outputPath: asmJob.outputPath || null,
    format: asmJob.format || 'portrait',
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
      const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${streamer}`, {
        headers: {
          'Client-Id': process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${process.env.TWITCH_TOKEN}`,
        },
      });
      const userId = userResp.data?.data?.[0]?.id;
      if (userId) {
        const clipsResp = await axios.get(
          `https://api.twitch.tv/helix/clips?broadcaster_id=${userId}&first=10`,
          {
            headers: {
              'Client-Id': process.env.TWITCH_CLIENT_ID,
              Authorization: `Bearer ${process.env.TWITCH_TOKEN}`,
            },
          }
        );
        const clips = clipsResp.data?.data || [];
        clipsToAnalyze = clips
          .filter((c) => c.thumbnail_url)
          .map((c) => ({ thumbnailUrl: c.thumbnail_url, title: c.title, pageUrl: c.url }));
        console.log(
          `[streamer-language] Auto-fetched ${clipsToAnalyze.length} clips for ${streamer}`
        );
      }
    } catch (e) {
      console.warn(`[streamer-language] Auto-fetch failed: ${e.message}`);
    }
  }

  if (!clipsToAnalyze.length) {
    return res
      .status(400)
      .json({ error: 'No clips to analyze — provide vodUrls or set autoFetch:true' });
  }

  // Send to client immediately — analysis runs in background
  res.json({
    ok: true,
    message: `Analyzing ${clipsToAnalyze.length} clips for ${streamer}...`,
    streamer,
  });

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
          const url = typeof clip === 'string' ? clip : clip.thumbnailUrl || '';
          if (!url) continue;
          const analysis = await geminiAnalyzeClip('', url, 'twitch', {
            streamer,
            title: clip.title || '',
            pageUrl: clip.pageUrl || '',
          });
          if (analysis && analysis.length > 20) analyses.push(analysis);
          await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          console.warn(`[streamer-language] Clip analysis failed: ${e.message}`);
        }
      }

      // Final synthesis call
      const synthesisResp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [
            { parts: [{ text: `${prompt}\n\nCLIP ANALYSES:\n${analyses.join('\n---\n')}` }] },
          ],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.2 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );

      const fingerprint = (synthesisResp.data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      // Save to cwn_style_guides.json under streamer key
      const guidePath = path.join(__dirname, 'data/cwn_style_guides.json');
      let guides = {};
      try {
        guides = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
      } catch (e) {}
      if (!guides.streamers) guides.streamers = {};
      guides.streamers[streamer.toLowerCase()] = {
        fingerprint,
        clipsAnalyzed: analyses.length,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(guidePath, JSON.stringify(guides, null, 2));
      console.log(
        `[streamer-language] ✅ ${streamer} language fingerprint saved (${fingerprint.length} chars)`
      );
    } catch (e) {
      console.error(`[streamer-language] Background analysis failed for ${streamer}:`, e.message);
    }
  })();
});

// GET /teach-streamer-language/status — check which streamers have been taught
app.get('/teach-streamer-language/status', (req, res) => {
  const guidePath = path.join(__dirname, 'data/cwn_style_guides.json');
  let guides = {};
  try {
    guides = JSON.parse(fs.readFileSync(guidePath, 'utf8'));
  } catch (e) {}
  const streamers = guides.streamers || {};
  res.json({
    ok: true,
    taught: Object.entries(streamers).map(([name, data]) => ({
      streamer: name,
      clipsAnalyzed: data.clipsAnalyzed,
      updatedAt: data.updatedAt,
      fingerprintLength: data.fingerprint?.length || 0,
    })),
  });
});
// POST /publish/setup-queue — now in lib/routes/publish.js

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
  if (!inputPath || !streamer)
    return res.status(400).json({ error: 'inputPath + streamer required' });

  // Load streamer data
  const streamersPath = path.join(__dirname, 'data/streamers.json');
  let streamerData = null;
  try {
    const data = JSON.parse(fs.readFileSync(streamersPath, 'utf8'));
    streamerData = data.roster?.find(
      (s) =>
        s.displayName?.toLowerCase() === streamer.toLowerCase() ||
        s.twitchUsername?.toLowerCase() === streamer.toLowerCase()
    );
  } catch (e) {
    return res.status(400).json({ error: 'streamers.json not found — copy to ~/Downloads/' });
  }

  if (!streamerData)
    return res.status(404).json({ error: `Streamer "${streamer}" not found in streamers.json` });

  const out = outputPath || inputPath.replace('.mp4', '_intro.mp4');
  const profileImgUrl = streamerData.profileImage || '';
  const origin = streamerData.origin || '';
  const fact = streamerData.fact || '';
  const name = streamerData.displayName || streamer;

  // Download profile image to tmp
  const profileImgPath = path.join(TMP_DIR, `profile_${name.replace(/\s/g, '_')}.png`);
  let hasProfileImg = false;
  if (profileImgUrl && !fs.existsSync(profileImgPath)) {
    try {
      await downloadFile(profileImgUrl, profileImgPath);
      hasProfileImg = fs.existsSync(profileImgPath) && fs.statSync(profileImgPath).size > 100;
    } catch (e) {
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
        `[bg][circle]overlay=x=75:y=75:enable='lte(t,${introDur})'[out]`,
      ].join(';');

      await new Promise((resolve, reject) => {
        const args = [
          '-i',
          inputPath,
          '-i',
          profileImgPath,
          '-filter_complex',
          filterComplex,
          '-map',
          '[out]',
          '-map',
          '0:a',
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
          '-y',
          out,
        ];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
        );
        proc.on('error', reject);
      });
    } else {
      // Text-only version (no profile image)
      const textFilter = [
        `drawbox=x=60:y=60:w=380:h=180:color=0x22304b@0.92:t=fill:enable='lte(t,${introDur})'`,
        `drawbox=x=60:y=60:w=380:h=180:color=0xc7af4f@1:t=3:enable='lte(t,${introDur})'`,
        `drawtext=text='${name.toUpperCase()}':x=70:y=80:fontsize=22:fontcolor=0xc7af4f:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='Origin\\: ${origin}':x=70:y=110:fontsize=15:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
        `drawtext=text='${fact}':x=70:y=135:fontsize=14:fontcolor=0xf0ede6:fontfile=/Users/robertgregory/cwn-production/tmp/cwn_font.ttf:enable='lte(t,${introDur})'`,
      ].join(',');

      await new Promise((resolve, reject) => {
        const args = [
          '-i',
          inputPath,
          '-vf',
          textFilter,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-y',
          out,
        ];
        const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
        proc.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
        );
        proc.on('error', reject);
      });
    }

    console.log(`[burn-intro] ✅ Intro card burned for ${name}: ${path.basename(out)}`);
    res.json({ ok: true, outputPath: out, streamer: name, hasProfileImg });
  } catch (e) {
    console.error(`[burn-intro] Failed for ${name}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /capcut/split-screen ────────────────────────────────────
// Creates split-screen short form video with CapCut API
// Requirements: 9:16, 1080p, masking, keyframes, auto-captions, 60fps
// Generates 3 platform-optimized variants (YouTube Shorts, TikTok, Instagram Reels)
app.post('/capcut/split-screen', async (req, res) => {
  const {
    sourceVideoPath, // Left side: news source video
    bobbyGVideoPath, // Right side: Bobby G reaction
    caption, // Gemini-generated caption
    contentType = 'news', // news, nba, or twitch
    platforms = ['youtube', 'tiktok', 'instagram'],
  } = req.body;

  if (!sourceVideoPath || !bobbyGVideoPath) {
    return res.status(400).json({ error: 'sourceVideoPath and bobbyGVideoPath required' });
  }

  const CAPCUT_API = 'http://localhost:9001';

  try {
    const platformVariants = {};

    // Create a variant for each platform
    for (const platform of platforms) {
      console.log(`[capcut-split] Creating ${platform} variant...`);

      // Step 1: Create draft (9:16, 1080p)
      const draftResp = await axios.post(`${CAPCUT_API}/create_draft`, {
        width: 1080,
        height: 1920,
        fps: 60,
      });

      if (!draftResp.data.ok) {
        throw new Error(`CapCut create_draft failed: ${draftResp.data.error || 'unknown error'}`);
      }

      const draftId = draftResp.data.draft_id;
      console.log(`[capcut-split] Draft created: ${draftId}`);

      // Step 2: Add source video (left 50%)
      await axios.post(`${CAPCUT_API}/add_video`, {
        draft_id: draftId,
        video_path: sourceVideoPath,
        track_index: 0,
        x: 0,
        y: 0,
        width: 540, // 50% of 1080
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle', // Optional: can add mask for rounded corners
      });

      // Step 3: Add Bobby G reaction (right 50%)
      await axios.post(`${CAPCUT_API}/add_video`, {
        draft_id: draftId,
        video_path: bobbyGVideoPath,
        track_index: 1,
        x: 540, // Right half
        y: 0,
        width: 540,
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle',
      });

      // Step 4: Add keyframes for dynamic zooms (platform-specific)
      const zoomKeyframes = getZoomKeyframes(platform);
      for (const kf of zoomKeyframes) {
        await axios.post(`${CAPCUT_API}/add_video_keyframe`, {
          draft_id: draftId,
          track_index: kf.track,
          time: kf.time,
          scale: kf.scale,
          x: kf.x,
          y: kf.y,
        });
      }

      // Step 5: Add auto-captions (platform-specific style)
      if (caption) {
        const captionStyle = getCaptionStyle(platform);
        await axios.post(`${CAPCUT_API}/add_subtitle`, {
          draft_id: draftId,
          text: caption,
          font_size: captionStyle.fontSize,
          font_color: captionStyle.color,
          position: captionStyle.position,
          animation: captionStyle.animation,
        });
      }

      // Step 6: Add platform-specific effects
      const effects = getPlatformEffects(platform, contentType);
      for (const effect of effects) {
        await axios.post(`${CAPCUT_API}/add_effect`, {
          draft_id: draftId,
          effect_type: effect.type,
          start_time: effect.start,
          duration: effect.duration,
        });
      }

      // Step 7: Save draft and export (1080p/60fps)
      const saveResp = await axios.post(`${CAPCUT_API}/save_draft`, {
        draft_id: draftId,
        output_path: path.join(OUTPUT_DIR, `split_screen_${platform}_${Date.now()}.mp4`),
        resolution: '1080p',
        fps: 60,
        quality: 'high',
      });

      if (!saveResp.data.ok) {
        throw new Error(
          `CapCut save_draft failed for ${platform}: ${saveResp.data.error || 'unknown error'}`
        );
      }

      platformVariants[platform] = {
        draftId,
        outputPath: saveResp.data.output_path,
        status: saveResp.data.status,
      };

      console.log(`[capcut-split] ✅ ${platform} variant saved: ${saveResp.data.output_path}`);
    }

    res.json({
      ok: true,
      platforms: platformVariants,
      caption,
    });
  } catch (err) {
    console.error('[capcut-split] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Get platform-specific zoom keyframes
function getZoomKeyframes(platform) {
  const keyframes = {
    youtube: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 2, scale: 1.1, x: -20, y: -30 }, // Subtle zoom on source
      { track: 1, time: 1, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 3, scale: 1.05, x: 540, y: -20 }, // Subtle zoom on Bobby G
    ],
    tiktok: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 1.5, scale: 1.15, x: -30, y: -40 }, // More aggressive zoom
      { track: 1, time: 0.5, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 2.5, scale: 1.1, x: 540, y: -30 },
    ],
    instagram: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 2, scale: 1.08, x: -15, y: -20 }, // Gentle zoom
      { track: 1, time: 1, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 3, scale: 1.06, x: 540, y: -15 },
    ],
  };
  return keyframes[platform] || keyframes.youtube;
}

// Helper: Get platform-specific caption style
function getCaptionStyle(platform) {
  const styles = {
    youtube: {
      fontSize: 48,
      color: '#FFFFFF',
      position: 'bottom',
      animation: 'fade_in',
    },
    tiktok: {
      fontSize: 52,
      color: '#FFFFFF',
      position: 'center_bottom',
      animation: 'pop',
    },
    instagram: {
      fontSize: 44,
      color: '#FFFFFF',
      position: 'bottom',
      animation: 'slide_up',
    },
  };
  return styles[platform] || styles.youtube;
}

// Helper: Get platform-specific effects
function getPlatformEffects(platform, contentType) {
  const effects = {
    youtube: [
      { type: 'color_correction', start: 0, duration: -1 }, // Apply to entire video
    ],
    tiktok: [
      { type: 'fast_zoom', start: 0, duration: 0.5 },
      { type: 'shake', start: 2, duration: 0.3 },
    ],
    instagram: [{ type: 'soft_glow', start: 0, duration: -1 }],
  };
  return effects[platform] || [];
}

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
      avatarId: process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829',
      dimensions: '1920x1080',
      format: 'landscape',
      useFor: 'YouTube long form compilations',
    },
    portrait: {
      avatarId: process.env.HEYGEN_AVATAR_SHORT_ID || 'ed57439c9c3d4a398f3b247b75714b13',
      dimensions: '1080x1920',
      format: 'portrait',
      useFor: 'TikTok, Instagram Reels, YouTube Shorts',
    },
    voiceId: '2e598f1a6022448cb6710e5d44665325',
    baseSpeed: 0.85,
    reactionSpeed: 0.95,
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
        '-ss',
        startTime.toString(),
        '-i',
        inPath,
        '-t',
        duration.toString(),
        '-vf',
        'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
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
        '-movflags',
        '+faststart',
        '-y',
        outPath,
      ];
      const proc = execFile(ffmpegPath(), args);
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`))
      );
      proc.on('error', reject);
    });

    const size = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`[shorts] ✅ Cut from ${startTime}s-${endTime}s → ${outFile} (${size}MB)`);
    res.json({
      ok: true,
      outputPath: outPath,
      filename: outFile,
      duration,
      sizeMB: parseFloat(size),
    });
  } catch (e) {
    console.error('[shorts] Cut failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /gate-fix-log — append Gate 2 fix attempt to logs/gate_fixes.jsonl
// Called by client-side handleGate2Failure after each fix strategy attempt.
app.post('/gate-fix-log', (req, res) => {
  const entry = req.body;
  if (!entry) return res.json({ ok: false, error: 'No body' });
  const logPath = path.join(__dirname, 'logs', 'gate_fixes.jsonl');
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
app.post('/gate2-segment-qa', async (req, res) => {
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
    const gate2Worker = require('./lib/gates/gate2');
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
app.post('/remediate-video', async (req, res) => {
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
app.get('/thumbnail-status/:jobId', (req, res) => {
  const result = (global._thumbnailJobs || {})[req.params.jobId];
  if (!result) return res.json({ status: 'pending', message: 'Still generating...' });
  res.json({ status: result.ok ? 'done' : 'failed', ...result });
});

// POST /cleanup — remove old output files, keep only the N most recent
// Body: { keepCount: 2, cleanTmp: true, cleanQaLogs: false }
app.post('/cleanup', async (req, res) => {
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
app.post('/nba/generate-intro-card', async (req, res) => {
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

  const templatePath = path.join(__dirname, 'templates', 'nba_intro_card.html');
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

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
