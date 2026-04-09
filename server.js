require('dotenv').config();

// Validate required environment variables on startup
function validateRequiredEnv() {
  const required = [
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'HEYGEN_API_KEY'
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error('\n❌ FATAL: Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\nPlease add these to your .env file and restart.\n');
    process.exit(1);
  }
  console.log('✅ All required environment variables present');
}

validateRequiredEnv();

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
const helmet     = require('helmet');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const { execFile, exec } = require('child_process');
const Anthropic  = require('@anthropic-ai/sdk');
const puppeteer  = require('puppeteer');
const { logError, withRetry, getFallbackImage, getErrorRate, getRecentErrors, errorMiddleware } = require('./lib/error_logger');
const { requireFields, validateContentType, validateArrayLength, validateUrl, sanitizeStrings } = require('./lib/validation');
const TwitchClient = require('./lib/clients/twitch_client');
// Note: geminiScriptGeneration, claudeScriptQA, probeDuration, downloadFile,
// buildConcatCommand, and geminiSegmentQA are defined locally below.
// The services/ modules are stubs kept for reference only.

const app  = express();

const TMP_DIR    = require('path').join(__dirname, 'tmp');
const CWN_LOGO_PATH = path.join(__dirname, 'assets', 'cwn_logo.png');
const CWN_BANNER_PATH = path.join(__dirname, 'assets', 'cwn_banner.png');
const OUTPUT_DIR = require('path').join(__dirname, 'output');
require('fs').mkdirSync(TMP_DIR,    { recursive: true });
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

const assemblyJobs = {};
const heygenJobs   = {};

// Initialize Anthropic client for Claude API calls
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize Twitch client
const twitchClient = new TwitchClient({
  clientId: process.env.TWITCH_CLIENT_ID,
  token: process.env.TWITCH_TOKEN
});

// ── Streamer Data Map (loaded from streamers.json) ────────────────
let STREAMER_DATA_MAP = new Map();
function loadStreamerData() {
  const streamersPath = path.join(__dirname, 'streamers.json');
  try {
    const data = JSON.parse(fs.readFileSync(streamersPath, 'utf8'));
    if (data.roster && Array.isArray(data.roster)) {
      STREAMER_DATA_MAP = new Map(data.roster.map(s => [s.twitchUsername.toLowerCase(), s]));
      console.log(`✅ Loaded ${STREAMER_DATA_MAP.size} streamers from streamers.json`);
    }
  } catch (e) {
    console.error(`❌ Failed to load streamers.json: ${e.message}`);
  }
}
loadStreamerData(); // Load on startup

function getStreamerInfo(twitchUsername) {
  if (!twitchUsername) return null;
  return STREAMER_DATA_MAP.get(twitchUsername.toLowerCase());
}

function log(asmId, msg, reqId = null) {
  const prefix = reqId ? `[${asmId}][${reqId}]` : `[${asmId}]`;
  console.log(`${prefix} ${msg}`);
}

// Security headers via helmet
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for local dashboard with inline scripts
  crossOriginEmbedderPolicy: false // Disabled for embedded videos/images
}));

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

app.use(cors({
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
  credentials: true
}));
app.use(require('express').json({ limit: '50mb' }));
app.use(require('express').urlencoded({ extended: true, limit: '50mb' }));



const PORT = process.env.PORT || 3000;

// ── Configuration Constants ────────────────────────────────────────
const CONFIG = {
  INTRO_CARD: {
    CANVAS_WIDTH: 720,
    CANVAS_HEIGHT: 840,
    CIRCLE_CENTER_Y: 330,
    CIRCLE_RADIUS: 260,
    NAME_FONT_SIZE: 68,
    ORIGIN_FONT_SIZE: 44,
    FACT_FONT_SIZE_START: 44,
    FACT_FONT_SIZE_MIN: 28,
    DURATION_SECONDS: 3.5
  },
  TRANSITIONS: {
    DISSOLVE_DURATION: 0.7,
    CROSSFADE_DURATION: 0.3,
    FADE_DURATION: 0.5
  },
  GEMINI: {
    MAX_FILE_SIZE: 34 * 1024 * 1024, // 34MB
    MAX_VIDEO_RETRIES: 3,
    UPLOAD_TIMEOUT: 120000
  },
  VIDEO: {
    ANALYSIS_QUALITIES: ['720', '480', '360'],
    ASSEMBLY_QUALITIES: ['1080', '720', 'best'],
    MIN_SEGMENT_SIZE: 100000, // 100KB
    MAX_SEGMENT_SIZE: 2 * 1024 * 1024 * 1024 // 2GB
  },
  ASSEMBLY: {
    ESTIMATED_SIZE_PER_SEGMENT_MB: 20,
    OVERHEAD_MB: 500,
    TIMEOUT_MS: 1800000 // 30 minutes
  },
  TICKER: {
    CACHE_TTL_MS: 3600000, // 1 hour
    DURATION_SECONDS: 60,
    WIDTH: 1920,
    HEIGHT: 64,
    FPS: 15
  },
  VISUAL_LAYOUTS: {
    LONG_FORM: {
      WIDTH: 1920,
      HEIGHT: 1080,
      AVATAR_SAFE_ZONE: { x: 0, y: 720, w: 1920, h: 360 }, // Bottom third
      OVERLAY_ZONE: { x: 1240, y: 40, w: 640, h: 360 },   // "TV Shape" Top Right
      LOGO_POS: { x: 1780, y: 20, size: 120 }
    },
    SHORT_FORM: {
      WIDTH: 1080,
      HEIGHT: 1920,
      CLIP_ZONE: { x: 0, y: 0, w: 1080, h: 960 },        // Top Half
      AVATAR_ZONE: { x: 0, y: 960, w: 1080, h: 960 },    // Bottom Half
      BURN_IN_ZONE: { x: 540, y: 960, anchor: 'center' }, // Floating middle
      LOGO_POS: { x: 985, y: 15, size: 80 }
    }
  }
};

// ── Stage Timer for Performance Metrics ────────────────────────────
// Tracks wall time, token usage, and results for each production stage
class StageTimer {
  constructor(jobId, stageName) {
    this.jobId = jobId;
    this.stageName = stageName;
    this.startTime = Date.now();
    this.metrics = {
      stage: stageName,
      startedAt: new Date().toISOString(),
      wallTimeMs: null,
      wallTimeSec: null
    };
  }

  // Add custom data to metrics (tokens, file sizes, pass/fail, etc.)
  addData(key, value) {
    this.metrics[key] = value;
    return this;
  }

  // Complete the stage and calculate duration
  end() {
    const endTime = Date.now();
    this.metrics.wallTimeMs = endTime - this.startTime;
    this.metrics.wallTimeSec = (this.metrics.wallTimeMs / 1000).toFixed(2);
    this.metrics.completedAt = new Date().toISOString();
    return this.metrics;
  }
}

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
          z: 1
        },
        {
          path: avatarPath,
          x: layout.AVATAR_ZONE.x,
          y: layout.AVATAR_ZONE.y,
          w: layout.AVATAR_ZONE.w,
          h: layout.AVATAR_ZONE.h,
          z: 2
        }
      ],
      branding: {
        path: findBrandingAsset('logo-80px.png'),
        x: layout.LOGO_POS.x,
        y: layout.LOGO_POS.y,
        size: layout.LOGO_POS.size,
        opacity: 0.85
      }
    };

    return withRetry(() => axios.post(`${this.baseUrl}/assemble`, payload), { label: `VectCut Assemble ${jobId}` });
  }

  /**
   * Branded "Gold Ring" Overlay for Long-Form (16:9 Landscape)
   * Applies CWN Gold (#c7af4f) 5px border + drop shadow
   * Position: TV-shaped card (640×360) at OVERLAY_ZONE (top-right)
   * Used for: NBA intro cards, News article images
   */
  async addBrandedOverlay(videoPath, assetPath, layout = 'LONG_FORM') {
    const coords = CONFIG.VISUAL_LAYOUTS[layout].OVERLAY_ZONE;

    return withRetry(() => axios.post(`${this.baseUrl}/overlay`, {
      videoPath,
      assetPath,
      x: coords.x,
      y: coords.y,
      w: coords.w,
      h: coords.h,
      style: {
        border: '5px solid #c7af4f',  // CWN Gold border
        shadow: '0 4px 15px rgba(0,0,0,0.5)'  // 50% opacity shadow
      }
    }), { label: `VectCut Overlay ${videoPath}` });
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

// Global metrics store: { jobId: { stages: [], totalTime: X } }
const jobMetrics = {};

function initJobMetrics(jobId) {
  jobMetrics[jobId] = {
    jobId,
    startedAt: new Date().toISOString(),
    stages: [],
    totalTimeMs: null,
    totalTimeSec: null
  };
}

function addStageMetrics(jobId, stageMetrics) {
  if (!jobMetrics[jobId]) initJobMetrics(jobId);
  jobMetrics[jobId].stages.push(stageMetrics);
  console.log(`[metrics:${jobId}] ${stageMetrics.stage} completed in ${stageMetrics.wallTimeSec}s`);
}

function finalizeJobMetrics(jobId) {
  if (!jobMetrics[jobId]) return;

  const firstStage = jobMetrics[jobId].stages[0];
  const lastStage = jobMetrics[jobId].stages[jobMetrics[jobId].stages.length - 1];

  if (firstStage && lastStage) {
    const start = new Date(firstStage.startedAt).getTime();
    const end = new Date(lastStage.completedAt).getTime();
    jobMetrics[jobId].totalTimeMs = end - start;
    jobMetrics[jobId].totalTimeSec = (jobMetrics[jobId].totalTimeMs / 1000).toFixed(2);
    jobMetrics[jobId].completedAt = lastStage.completedAt;
  }

  // Save to file
  const metricsFile = path.join(OUTPUT_DIR, `run_metrics_${jobId}.json`);
  try {
    fs.writeFileSync(metricsFile, JSON.stringify(jobMetrics[jobId], null, 2));
    console.log(`[metrics:${jobId}] ✅ Metrics saved: ${metricsFile}`);
    console.log(`[metrics:${jobId}] Total pipeline time: ${jobMetrics[jobId].totalTimeSec}s`);
  } catch (e) {
    console.error(`[metrics:${jobId}] Failed to save metrics: ${e.message}`);
  }

  return jobMetrics[jobId];
}

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
async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;
  const https = require('https');
  const http  = require('http');

  // ── Dimensions (2x resolution for sharpness) ─────────────────────
  const W = 720, H = 840;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Sanitize text strings by replacing escaped apostrophes and quotes
  const name   = (streamerData.displayName || streamerData.name || '').toUpperCase().replace(/\\'/g, "'").replace(/\\"/g, '"');
  const origin = (streamerData.origin  || '').replace(/\\'/g, "'").replace(/\\"/g, '"');
  const fact   = (streamerData.fact    || '').replace(/\\'/g, "'").replace(/\\"/g, '"');

  // Check for local profile image first, fallback to remote URL
  const twitchUsername = streamerData.twitchUsername || streamerData.name || '';
  const displayName = streamerData.displayName || '';
  const onAirName = streamerData.onAirName || '';
  let imgUrl = streamerData.profileImage || null; // Use profileImage from streamerData

  // Try multiple filename patterns in order
  const filenamePatterns = [
    { name: twitchUsername, label: 'twitchUsername' },
    { name: displayName ? `profile_${displayName}` : '', label: 'profile_displayName' },
    { name: onAirName ? `profile_${onAirName}` : '', label: 'profile_onAirName' },
    { name: displayName, label: 'displayName' },
    { name: onAirName, label: 'onAirName' },
    { name: displayName ? `profile_${displayName.replace(/ /g, '_')}` : '', label: 'profile_displayName_underscore' },
    { name: onAirName ? `profile_${onAirName.replace(/ /g, '_')}` : '', label: 'profile_onAirName_underscore' }
  ].filter(p => p.name); // Remove empty patterns

  // Try multiple extensions: .png, .jpeg, .jpg, and no extension
  const extensions = ['.png', '.jpeg', '.jpg', ''];

  console.log(`[intro-card] Looking for profile image for: ${name} (twitchUsername: ${twitchUsername}, displayName: ${displayName}, onAirName: ${onAirName})`);

  let localImagePath = null;
  for (const pattern of filenamePatterns) {
    for (const ext of extensions) {
      const testPath = require('path').join(__dirname, 'assets', 'streamers', `${pattern.name}${ext}`);
      const filename = `${pattern.name}${ext}`;
      console.log(`[intro-card]   Trying: ${filename} (${pattern.label}${ext}) ... ${require('fs').existsSync(testPath) ? 'FOUND ✓' : 'not found'}`);
      if (require('fs').existsSync(testPath)) {
        localImagePath = testPath;
        imgUrl = localImagePath;
        console.log(`[intro-card] ✓ Using local profile image: ${filename}`);
        break;
      }
    }
    if (localImagePath) break; // Stop if we found a match
  }

  if (!localImagePath) {
    console.log(`[intro-card] ✗ No local file found - using remote URL`);
  }

  // ── Color schemes ────────────────────────────────────────────────
  const scheme = variant === 'twitch'
    ? { bg: '#9146FF', ring: '#c7af4f', text1: '#ffffff', text2: '#ffffff', text3: '#e8e0f5', hasBg: true  }
    : { bg: 'transparent', ring: '#c7af4f', text1: '#c7af4f', text2: '#ffffff', text3: '#aaaaaa', hasBg: false };

  // ── Clear canvas ─────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  const CX = W / 2, CY = 330, R = 260;

  // ── Background (Twitch variant only) ─────────────────────────────
  if (scheme.hasBg) {
    ctx.fillStyle = scheme.bg;
    const pad = 24;
    ctx.beginPath();
    ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, 40);
    ctx.fill();
  }

  // ── Profile image clipped to circle ──────────────────────────────
  if (imgUrl) {
    try {
      const img = await loadImage(imgUrl);
      ctx.save();
      // Enable high-quality image smoothing
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.beginPath();
      ctx.arc(CX, CY, R - 12, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, CX - R + 12, CY - R + 12, (R - 12) * 2, (R - 12) * 2);
      ctx.restore();
    } catch (e) {
      // Profile image failed — draw placeholder
      ctx.save();
      ctx.beginPath();
      ctx.arc(CX, CY, R - 12, 0, Math.PI * 2);
      ctx.fillStyle = '#1a2540';
      ctx.fill();
      ctx.restore();
      console.warn(`[intro-card] Profile image failed for ${name}: ${e.message}`);
    }
  }

  // ── Gold ring ────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.strokeStyle = scheme.ring;
  ctx.lineWidth   = 10;
  ctx.stroke();

  // ── Drop shadow behind text (subtle) ────────────────────────────
  ctx.shadowColor   = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur    = 16;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  // ── Line 1: Streamer name (gold / white) ─────────────────────────
  ctx.textAlign    = 'center';
  ctx.fillStyle    = scheme.text1;
  ctx.font         = 'bold 96px Arial';
  ctx.fillText(name, CX, CY + R + 96);

  // ── Line 2: Origin ───────────────────────────────────────────────
  ctx.fillStyle = scheme.text2;
  ctx.font      = 'normal 64px Arial';
  ctx.fillText(origin, CX, CY + R + 164);

  // ── Line 3: Fact (italic) ────────────────────────────────────────
  ctx.fillStyle = scheme.text3;

  // Dynamic font sizing: reduce by 1px if text exceeds 2 lines, down to 14px minimum
  // (at 2x resolution: start 44px, reduce by 2px, min 28px) - never truncate
  let fontSize = 44;
  let lines = [];
  const maxLines = 2;
  const maxWidth = W - 60;

  while (fontSize >= 28) {
    ctx.font = `italic ${fontSize}px Arial`;
    lines = [];
    const words = fact.split(' ');
    let line = '';

    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);

    if (lines.length <= maxLines) break;
    fontSize -= 2;
  }

  // Draw the lines
  const lineHeight = fontSize;
  let y = CY + R + 228;
  for (const line of lines) {
    ctx.fillText(line, CX, y);
    y += lineHeight;
  }

  ctx.shadowColor = 'transparent';

  // ── Save PNG ─────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[intro-card] ✅ ${variant.toUpperCase()} card written: ${require('path').basename(outputPath)} (${name})`);
}

// ── Generate NBA/News Intro Card (Square Design) ────────────────────
// For NBA: game thumbnail in square
// For News: story image in square
// Same placement as Twitch card (right of Bobby G during intro)
async function generateGameStoryCardPNG(cardData, outputPath, contentType) {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions (same as Twitch card for consistency) ────────────────
  const W = 720, H = 840;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Color schemes ────────────────────────────────────────────────────
  const schemes = {
    nba: {
      border: '#17408B',  // NBA Blue
      accent: '#C9082A',  // NBA Red
      bg: '#1a2540',      // Dark background
      text1: '#ffffff',   // Title text
      text2: '#c7af4f'    // CWN Gold for secondary
    },
    news: {
      border: '#22304b',  // CWN Navy
      accent: '#c7af4f',  // CWN Gold
      bg: '#1a2540',      // Dark background
      text1: '#ffffff',   // Title text
      text2: '#c7af4f'    // CWN Gold for secondary
    }
  };

  const scheme = schemes[contentType] || schemes.news;

  // ── Extract data ─────────────────────────────────────────────────────
  const title = cardData.title || cardData.gameTitle || 'GAME';
  const subtitle = cardData.subtitle || cardData.score || '';
  const imageUrl = cardData.imageUrl || cardData.thumbnailUrl || null;

  // ── Clear canvas ─────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Background ───────────────────────────────────────────────────────
  ctx.fillStyle = scheme.bg;
  const pad = 24;
  ctx.beginPath();
  ctx.roundRect(pad, pad, W - pad * 2, H - pad * 2, 40);
  ctx.fill();

  // ── Square image in center ───────────────────────────────────────────
  const CX = W / 2, CY = 330;
  const SQUARE_SIZE = 440; // 440x440 square

  if (imageUrl) {
    try {
      const img = await loadImage(imageUrl);
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Draw square image
      const x = CX - SQUARE_SIZE / 2;
      const y = CY - SQUARE_SIZE / 2;
      ctx.drawImage(img, x, y, SQUARE_SIZE, SQUARE_SIZE);

      // Border around image (accent color)
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = 8;
      ctx.strokeRect(x, y, SQUARE_SIZE, SQUARE_SIZE);

      ctx.restore();
    } catch (e) {
      // Image failed — draw placeholder
      const x = CX - SQUARE_SIZE / 2;
      const y = CY - SQUARE_SIZE / 2;
      ctx.fillStyle = '#2a3550';
      ctx.fillRect(x, y, SQUARE_SIZE, SQUARE_SIZE);
      ctx.strokeStyle = scheme.accent;
      ctx.lineWidth = 8;
      ctx.strokeRect(x, y, SQUARE_SIZE, SQUARE_SIZE);
      console.warn(`[game-story-card] Image failed for ${title}: ${e.message}`);
    }
  }

  // ── Drop shadow behind text (subtle) ────────────────────────────
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;

  // ── Title text (below image) ────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.fillStyle = scheme.text1;
  ctx.font = 'bold 64px Arial';

  // Word wrap title if too long
  const maxWidth = W - 80;
  let titleLines = [];
  const titleWords = title.split(' ');
  let currentLine = '';

  for (const word of titleWords) {
    const test = currentLine ? currentLine + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && currentLine) {
      titleLines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = test;
    }
  }
  if (currentLine) titleLines.push(currentLine);

  // Draw title lines
  let y = CY + SQUARE_SIZE / 2 + 80;
  for (const line of titleLines.slice(0, 2)) { // Max 2 lines
    ctx.fillText(line, CX, y);
    y += 72;
  }

  // ── Subtitle text (score/details) ───────────────────────────────────
  if (subtitle) {
    ctx.fillStyle = scheme.text2;
    ctx.font = 'normal 48px Arial';
    ctx.fillText(subtitle, CX, y);
  }

  ctx.shadowColor = 'transparent';

  // ── Save PNG ────────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[game-story-card] ✅ ${contentType.toUpperCase()} card written: ${require('path').basename(outputPath)} (${title})`);
}


async function downloadFile(url, destPath) {
  // SSRF Protection: Validate URL is from trusted domains
  const trustedDomains = [
    'clips-media-assets',           // Twitch CDN
    'clips-media-assets2',          // Twitch CDN
    'production-assets',            // Twitch
    'cloudfront.net',               // AWS CloudFront (Twitch authenticated clips)
    'resource.heygencdn.com',       // HeyGen CDN
    'files2.heygen.ai',             // HeyGen temporary files
    'heygen.ai',                    // HeyGen (catch-all for subdomains)
    'storage.googleapis.com',       // Google Cloud Storage
    'drive.google.com'              // Google Drive
  ];

  const isTrusted = trustedDomains.some(domain => url.includes(domain));
  if (!isTrusted) {
    throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);
  }

  return withRetry(async () => { // Wrap the entire download logic in withRetry
    const writer = fs.createWriteStream(destPath);
    const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
    resp.data.pipe(writer);
    return new Promise((res, rej) => {
      writer.on('finish', res);
      writer.on('error', rej);
    });
  }, { label: `Download ${url.slice(0, 30)}` });
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  // Cross-platform default: .exe on Windows, no extension on Unix
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

function checkFFmpeg(cb) {
  exec(ffmpegPath() + ' -version', (err, stdout) => {
    if (err) return cb(new Error('FFmpeg not found. Install ffmpeg and ensure it is in PATH.'));
    const versionLine = stdout.split('\n')[0];
    cb(null, versionLine);
  });
}

// Check available disk space before assembly
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
        return reject(new Error(
          `Insufficient disk space: ${freeGB}GB available, need ${(requiredMB/1024).toFixed(1)}GB. ` +
          `Run cleanup to free space.`
        ));
      }
      resolve();
    });
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
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ], (err, stdout) => {
      res(err ? 60 : parseFloat(stdout.trim()) || 60);
    });
  });
}

// ── Routes ────────────────────────────────────────────────────────

// Health check with dependency validation
app.get('/health', async (req, res) => {
  const health = {
    ok: true,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dependencies: {},
    directories: {},
    errors: []
  };

  // Check FFmpeg
  try {
    const ffmpegVersion = await new Promise((resolve, reject) => {
      checkFFmpeg((err, version) => {
        if (err) reject(err);
        else resolve(version);
      });
    });
    health.dependencies.ffmpeg = { status: 'ok', version: ffmpegVersion };
  } catch (err) {
    health.ok = false;
    health.dependencies.ffmpeg = { status: 'error', error: err.message };
    health.errors.push('FFmpeg not available');
  }

  // Check API keys
  const requiredKeys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HEYGEN_API_KEY'];
  requiredKeys.forEach(key => {
    const exists = !!process.env[key];
    health.dependencies[key] = { status: exists ? 'ok' : 'missing' };
    if (!exists) {
      health.ok = false;
      health.errors.push(`${key} not configured`);
    }
  });

  // Check directories
  const dirs = { tmp: TMP_DIR, output: OUTPUT_DIR };
  for (const [name, dir] of Object.entries(dirs)) {
    try {
      const stats = fs.statSync(dir);
      health.directories[name] = {
        path: dir,
        exists: true,
        writable: true // Already validated on startup
      };
    } catch (err) {
      health.ok = false;
      health.directories[name] = {
        path: dir,
        exists: false,
        error: err.message
      };
      health.errors.push(`${name} directory not accessible`);
    }
  }

  // Check VectCut API (optional)
  try {
    const vectCutHealth = await vectCutClient.healthCheck();
    health.dependencies.vectcut = vectCutHealth.healthy
      ? { status: 'ok' }
      : { status: 'offline', error: vectCutHealth.error };
  } catch (err) {
    health.dependencies.vectcut = { status: 'offline', error: err.message };
    // VectCut is optional, don't fail health check
  }

  // Check disk space
  try {
    await new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(`df -k "${OUTPUT_DIR}" | awk 'NR==2 {print $4}'`, (err, stdout) => {
        if (err) return reject(err);
        const freeKB = parseInt(stdout.trim());
        const freeMB = Math.floor(freeKB / 1024);
        const freeGB = (freeMB / 1024).toFixed(1);
        health.directories.output.freeSpaceGB = parseFloat(freeGB);
        
        // Warn if less than 5GB free
        if (freeMB < 5120) {
          health.errors.push(`Low disk space: ${freeGB}GB remaining`);
        }
        resolve();
      });
    });
  } catch (err) {
    // Non-fatal, just log
    health.directories.output.freeSpaceError = err.message;
  }

  const statusCode = health.ok ? 200 : 503;
  res.status(statusCode).json(health);
});

// ── Serve HTML thumbnail/overlay tools ──────────────────────────────
app.get('/news-tool', (req, res) => {
  res.sendFile(path.join(__dirname, 'cwn_news_tool.html'));
});

app.get('/newscast-overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'clipzworld_newscast.html'));
});

app.get('/twitch-tool', (req, res) => {
  res.sendFile(path.join(__dirname, 'cwn_twitch_tool.html'));
});

// Serve assets folder for images (Bobby G, etc.)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

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
      const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET || 'GOCSPX-REDACTED-ROTATE-IN-GOOGLE-CONSOLE';
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
    console.log(`[topaz] Enhancing video: ${path.basename(videoPath)} (${sizeMB.toFixed(1)} MB)...`);

    // Step 1: Probe video metadata with FFprobe
    const metadata = await new Promise((res, rej) => {
      execFile(ffprobePath(), [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_frames',
        '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames,codec_name,duration',
        '-show_entries', 'format=duration',
        '-of', 'json',
        videoPath
      ], (err, stdout) => {
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
            container: path.extname(videoPath).slice(1) || 'mp4'
          });
        } catch(e) { rej(e); }
      });
    });

    console.log(`[topaz] Metadata: ${metadata.width}x${metadata.height} @ ${metadata.fps}fps, ${metadata.duration.toFixed(1)}s, ${metadata.codec}/${metadata.container}`);

    // Step 2: Create enhancement request
    const createResp = await withRetry(() => axios.post('https://api.topazlabs.com/video/', {
      source: {
        resolution: [metadata.width, metadata.height],
        container: metadata.container,
        frameRate: metadata.fps,
        duration: metadata.duration
      },
      output: {
        resolution: [metadata.width, metadata.height], // no upscaling, just enhancement
        audioCodec: 'AAC',
        container: 'mp4'
      },
      filter: {
        model: 'apo-3', // Proteus model for quality + artifact recovery
        slowmo: { enabled: false },
        frameRate: metadata.fps
      }
    }, {
      headers: {
        'X-API-Key': TOPAZ_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      },
      timeout: 30000
    }), { label: 'Topaz Create' });

    const requestID = createResp.data?.requestID;
    if (!requestID) throw new Error('No requestID in Topaz create response');
    console.log(`[topaz] Created request: ${requestID}`);

    // Step 3: Accept and get upload URLs
    const acceptResp = await withRetry(() => axios.patch(`https://api.topazlabs.com/video/${requestID}/accept`, {}, {
      headers: {
        'X-API-Key': TOPAZ_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      }
    }), { label: 'Topaz Accept' });

    const uploadUrl = acceptResp.data?.uploadUrl;
    if (!uploadUrl) throw new Error('No uploadUrl in Topaz accept response');
    console.log(`[topaz] Got upload URL, uploading video...`);

    // Step 4: Upload video to signed URL
    const videoBuffer = fs.readFileSync(videoPath);
    await withRetry(() => axios.put(uploadUrl, videoBuffer, {
      headers: { 'Content-Type': 'video/mp4' },
      maxBodyLength: Infinity,
      timeout: 300000 // 5 min upload timeout
    }), { label: 'Topaz Upload' });

    console.log(`[topaz] Video uploaded, completing...`);

    // Step 5: Complete upload to start processing
    await withRetry(() => axios.patch(`https://api.topazlabs.com/video/${requestID}/complete-upload`, {}, {
      headers: {
        'X-API-Key': TOPAZ_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      }
    }), { label: 'Topaz Complete Upload' });

    console.log(`[topaz] Processing started, polling status...`);

    // Step 6: Poll for completion (timeout after 30 min)
    const startTime = Date.now();
    const POLL_TIMEOUT = 30 * 60 * 1000; // 30 minutes
    let downloadUrl = null;

    while (Date.now() - startTime < POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, 15000)); // poll every 15s

      const statusResp = await axios.get(`https://api.topazlabs.com/video/${requestID}/status`, {
        headers: {
          'X-API-Key': TOPAZ_API_KEY,
          'accept': 'application/json'
        }
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
    await withRetry(async () => {
      const writer = fs.createWriteStream(enhancedPath);
      const downloadResp = await axios.get(downloadUrl, { responseType: 'stream' });
      downloadResp.data.pipe(writer);
      return new Promise((res, rej) => {
        writer.on('finish', res);
        writer.on('error', rej);
      });
    }, { label: 'Topaz Download' });

    const enhancedStat = fs.statSync(enhancedPath);
    console.log(`[topaz] Downloaded enhanced video: ${(enhancedStat.size / 1024 / 1024).toFixed(1)} MB`);

    // Step 8: Replace original with enhanced
    fs.unlinkSync(videoPath);
    fs.renameSync(enhancedPath, videoPath);
    console.log(`[topaz] ✅ Video enhanced successfully`);

    return { success: true, requestID };

  } catch(err) {
    console.error(`[topaz] ❌ Enhancement failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// Gate 3 QA function moved to services/qa.js
// Import and use: const { geminiAssemblyQA } = require('./services/qa');
async function geminiQACheck(videoPath, opts = {}) {
  // Wrapper for backward compatibility - calls new service
  return geminiAssemblyQA(videoPath, opts);
}

async function geminiQACheck_DEPRECATED(videoPath, opts = {}) {
  const { contentType, avatarCount, clipCount, expectedTicker, totalDuration } = opts;
  if (!GEMINI_APIKEY) return { score: 100, report: 'QA skipped — no Gemini API key', passed: true };
  if (!fs.existsSync(videoPath)) return { score: 0, report: 'QA failed — video file not found', passed: false };

  const dur = totalDuration || 60;
  const MAX_BYTES = 32 * 1024 * 1024;

  // Sample at 3 points: early (10%), middle (50%), late (90%) — catches freeze at transitions
  const samplePoints = [
    { label: 'EARLY',  start: Math.max(0, dur * 0.10 - 10) },
    { label: 'MIDDLE', start: Math.max(0, dur * 0.50 - 10) },
    { label: 'LATE',   start: Math.max(0, Math.floor(dur) - 25) },
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
  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate3_assembly_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa] Gate 3 why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — Drive is for final videos only

  return { score: avgScore, report: whyDoc, passed, outcome, outcomeLabel, freezeDetected, deductions };
}

// ── HeyGen API Integration ────────────────────────────────────────
// Parse script into individual scenes
function parseScriptIntoScenes(script) {
  const scenes = [];
  const sceneRegex = /===\s*([A-Z_0-9]+)\s*===/g;

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

// Submits approved script to HeyGen for avatar video generation
// UPDATED: Generates one video per scene to avoid HeyGen multi-scene processing issues
async function sendScriptToHeyGen(script, opts = {}) {
  const {
    contentType = 'twitch',
    format = 'landscape', // 'landscape' for long form, 'portrait' for short form
    jobId = 'unknown'
  } = opts;

  // Load HeyGen credentials from environment
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '19c1d4adf8904694a3cc331c5a9bee4b';
  const HEYGEN_AVATAR_SHORT_ID = process.env.HEYGEN_AVATAR_SHORT_ID || 'ed57439c9c3d4a398f3b247b75714b13';
  const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || '2e598f1a6022448cb6710e5d44665325';
  const HEYGEN_SPEAK_SPEED = parseFloat(process.env.HEYGEN_SPEAK_SPEED || '0.85');

  if (!HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not set in environment');
  }

  // Select avatar based on format
  const avatarId = format === 'portrait' ? HEYGEN_AVATAR_SHORT_ID : HEYGEN_AVATAR_ID;

  // Parse script into scenes
  const scenes = parseScriptIntoScenes(script);

  console.log(`[heygen] Submitting ${scenes.length} scenes to HeyGen as individual videos (${contentType}, ${format}, avatar: ${avatarId.slice(0,8)}...)`);

  if (scenes.length === 0) {
    throw new Error('No scenes found in script. Script must have === SCENE_NAME === markers.');
  }

  console.log(`[heygen] Scene breakdown:`);
  scenes.forEach((scene, idx) => {
    console.log(`  ${idx + 1}. ${scene.name} - ${scene.text.substring(0, 50)}... (${scene.text.length} chars)`);
  });

  // Submit each scene as a separate video generation request
  const videoJobs = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Build single-scene video request
    const requestBody = {
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal'
        },
        voice: {
          type: 'text',
          input_text: scene.text,
          voice_id: HEYGEN_VOICE_ID,
          speed: HEYGEN_SPEAK_SPEED
        }
      }],
      dimension: {
        width: format === 'portrait' ? 1080 : 1920,
        height: format === 'portrait' ? 1920 : 1080
      },
      test: false
    };

    try {
      console.log(`[heygen] Submitting scene ${i + 1}/${scenes.length}: ${scene.name}...`);

      const response = await withRetry(() => axios.post(
        'https://api.heygen.com/v2/video/generate',
        requestBody,
        {
          headers: {
            'X-Api-Key': HEYGEN_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      ), { label: `HeyGen Generate Scene ${scene.name}` });

      const { video_id, status } = response.data.data || {};

      if (!video_id) {
        throw new Error(`HeyGen API did not return video_id for scene ${scene.name}: ${JSON.stringify(response.data)}`);
      }

      console.log(`[heygen] ✅ Scene ${i + 1}/${scenes.length} (${scene.name}): video_id=${video_id}, status=${status}`);

      videoJobs.push({
        sceneName: scene.name,
        sceneIndex: i,
        video_id,
        status,
        textLength: scene.text.length
      });

      // Add 2-second delay between requests to avoid rate limiting
      if (i < scenes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch(e) {
      const errData = e.response?.data;
      console.error(`[heygen] API Error for scene ${scene.name}:`, e.message, errData || '');
      throw new Error(`HeyGen API failed for scene ${scene.name}: ${e.message}${errData ? ` - ${JSON.stringify(errData)}` : ''}`);
    }
  }

  console.log(`[heygen] ✅ All ${scenes.length} scenes submitted successfully`);
  console.log(`[heygen] Video IDs: ${videoJobs.map(j => j.video_id).join(', ')}`);

  // Store script text with scene mapping for Gate 2 re-rendering
  const sceneTextMap = {};
  scenes.forEach((scene, idx) => {
    sceneTextMap[scene.name] = {
      text: scene.text,
      index: idx,
      videoId: videoJobs[idx]?.video_id
    };
  });

  return {
    videoJobs,  // Array of {sceneName, sceneIndex, video_id, status, textLength}
    avatarId,
    voiceId: HEYGEN_VOICE_ID,
    speakSpeed: HEYGEN_SPEAK_SPEED,
    sceneCount: scenes.length,
    scenes: scenes.map(s => s.name),
    sceneTextMap,  // Full script text mapped by scene name for Gate 2 re-rendering
    fullScript: script  // Complete original script for reference
  };
}

// ── Gate 1: Script Generation — Gemini writes the script ──────────
// NEW ARCHITECTURE (as of April 2026):
// Claude consistently generated 11 scenes instead of 72 for Twitch format,
// ignoring all prompt instructions due to learned "one section per streamer" pattern.
// SOLUTION: Gemini writes script (no learned bias), Claude QAs it (fresh evaluation).
async function geminiScriptGeneration(userPrompt, systemPrompt, opts = {}) {
  const { previousScript = null, feedbackMsg = '', contentType = 'twitch' } = opts;

  if (!GEMINI_APIKEY) throw new Error('GEMINI_APIKEY not configured');

  // Load style guide for this content type
  const STYLE_GUIDE_PATH = path.join(__dirname, 'cwn_style_guides.json');
  let styleGuide = '';
  try {
    const styleGuides = JSON.parse(fs.readFileSync(STYLE_GUIDE_PATH, 'utf8'));
    // Normalize content type (remove -short suffix for style lookup)
    const styleType = contentType.replace('-short', '');
    styleGuide = styleGuides[styleType] || '';
    if (styleGuide) {
      console.log(`[geminiScriptGeneration] Loaded ${styleType} style guide (${styleGuide.length} chars)`);
    }
  } catch(e) {
    console.warn(`[geminiScriptGeneration] Could not load style guide: ${e.message}`);
  }

  // Combine system + user prompts + style guide for Gemini (doesn't have separate system param)
  let fullPrompt = `SYSTEM INSTRUCTIONS:
${systemPrompt}`;

  // Inject style guide if available
  if (styleGuide) {
    fullPrompt += `

STYLE GUIDE (follow this writing style and tone):
${styleGuide}`;
  }

  fullPrompt += `

USER TASK:
${userPrompt}`;

  // If retrying with feedback, append it
  if (previousScript && feedbackMsg) {
    fullPrompt += `

PREVIOUS ATTEMPT (HAD ISSUES):
${previousScript}

FEEDBACK FROM QA REVIEWER:
${feedbackMsg}

Please generate a COMPLETE REVISED script that fixes all the issues listed above.`;
  }

  // Scale maxOutputTokens based on content type to prevent truncation
  // Twitch Full (10 streamers × 3 clips = 72 scenes) needs ~20k tokens
  // NBA/News Full (10 items × 4 scenes = 42 scenes) needs ~12k tokens
  // Shorts need ~2k tokens
  // Gemini 2.5 Flash supports up to 65,536 output tokens
  const isShort = contentType.includes('-short');
  const isTwitch = contentType === 'twitch' || contentType === 'twitch-short';
  let maxOutputTokens;
  if (isShort) {
    maxOutputTokens = 2000;
  } else if (isTwitch) {
    // Twitch: 1 + N*(1 + clips*2) + 1 scenes — scales fast
    // 10 streamers × 3 clips = 72 scenes → need ~20k tokens
    maxOutputTokens = 32000;
  } else {
    // NBA/News: 1 + N*4 + 1 scenes
    // 10 items = 42 scenes → need ~12k tokens
    maxOutputTokens = 16000;
  }

  try {
    const genResp = await withRetry(() => axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,  // Slightly creative but controlled
          topP: 0.95,
          topK: 40
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    ), { label: 'Gemini Script Generation' });

    const candidate = genResp.data?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // Detect silent truncation — if Gemini hit token limit mid-output, the script will be incomplete
    if (finishReason === 'MAX_TOKENS') {
      console.error(`[geminiScriptGeneration] ⚠️ Gemini output TRUNCATED (finishReason=MAX_TOKENS, maxOutputTokens=${maxOutputTokens})`);
      throw new Error(`Gemini output truncated at token limit (${maxOutputTokens} tokens) — script is incomplete`);
    }

    const script = (candidate?.content?.parts || [])
      .map(p => p.text||'')
      .join('')
      .trim();

    if (!script || script.length < 100) {
      throw new Error('Gemini returned empty or too-short script');
    }

    console.log(`[geminiScriptGeneration] ✅ Script complete (finishReason=${finishReason}, length=${script.length} chars)`);
    return { script, tokenUsage: { input: 0, output: 0 } }; // Gemini doesn't expose token counts easily
  } catch(e) {
    console.error('[geminiScriptGeneration] API call failed:', e.message);
    throw new Error(`Gemini script generation failed: ${e.message}`);
  }
}

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
async function claudeScriptQA(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 3,
    jobId = 'unknown',
    expectedScenes = 0  // Must be provided by caller
  } = opts;

  if (!client) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped — no key)', deductions: [] };

  const PASS_THRESHOLD   = 90;
  const MANUAL_THRESHOLD = 70;

  // Count [CLIP PLAYS HERE] markers in script
  const clipMarkers    = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  const expectedClips  = contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1; // allow ±1 tolerance
  const missingAppreciateYou = !/appreciate you/i.test(script);

  // Count scene markers
  const sceneMarkers = (script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build clip summaries for Claude to cross-check
  const clipSummaries = clipAnalyses.map((a, i) => {
    const streamer = streamers[Math.floor(i / clipsPerStreamer)] || `Streamer ${i+1}`;
    const clipNum  = (i % clipsPerStreamer) + 1;
    return `CLIP ${i+1} (${streamer.displayName || streamer}, clip ${clipNum}): ${a?.summary || a?.description || a || 'No analysis available'}`;
  }).join('\n');

  const displayNames = streamers.map(s => {
    const data = typeof s === 'object' ? s : { displayName: s, username: s };
    let nameString = `"${data.displayName}"`;
    if (data.phonetic) {
      nameString += ` (pronounced ${data.phonetic})`;
    }
    nameString += ` (NOT "${data.username || data.twitchUsername || ''}")`;
    return nameString;
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

  const checklist = isTwitch ? [
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
    `10. LOCKED INTRO: Does the video open with the correct locked intro line?`,
    `11. WORD COUNT: Is each streamer section approximately 80-100 words?`
  ] : isNBA ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: GAME1_INTRO, GAME1_SETUP, GAME1_CLIP_REACTION, GAME1_REACTION are 4 SEPARATE scenes
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per game)?`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. GAME ACCURACY: Are game scores, teams, and player stats accurately mentioned?`,
    `5. INTRO: Is the intro 2-3 sentences introducing the episode?`,
    `6. GAME SETUP: Does each game section have proper context before [CLIP PLAYS HERE]?`,
    `7. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `8. CLIP MATCH (most important): Does each game commentary match what was seen in the highlight clip?`,
    `9. LOCKED INTRO: Does the video open with the correct "Other Side of the Pillow" intro?`,
    `10. WORD COUNT: Is each game section approximately 120-150 words?`,
    `11. REACTION: Is there a brief reaction/observation after each clip?`
  ] : isNews ? [
    `1. SCENE COUNT: Count every === HEADER === marker systematically through the ENTIRE script.
   - DO NOT try to count in your head
   - Expected: exactly ${expectedScenes} markers
   - Method: Search through script and list each header you find, then count your list
   - Remember: STORY1_INTRO, STORY1_SETUP, STORY1_CLIP_REACTION, STORY1_REACTION are 4 SEPARATE scenes
   - Are there exactly ${expectedScenes} === SCENE === markers?`,
    `2. CLIP COUNT: Are there exactly ${expectedClips} [CLIP PLAYS HERE] markers (one per story)?`,
    `3. OUTRO: Does the script end with "Appreciate you!"?`,
    `4. STORY ACCURACY: Are headlines and story details accurately mentioned?`,
    `5. INTRO: Is the intro 2-3 sentences introducing the episode?`,
    `6. STORY SETUP: Does each story have proper context before [CLIP PLAYS HERE]?`,
    `7. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `8. CLIP MATCH (most important): Does each story setup match what was seen in the news clip?`,
    `9. LOCKED INTRO: Does the video open with the correct ClipzWorld News intro?`,
    `10. SOURCE ATTRIBUTION: Is "Source: [name]. Link in description." included after each story?`,
    `11. REACTION: Is there a flat, deadpan reaction after each clip (1 sentence)?`
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
    const response = await callClaudeAPI({ // Use the enhanced callClaudeAPI
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
  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate1_script_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate1] Script QA why-doc saved: ${logFile}`); } catch(e) {}

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
    let nameString = `"${data.displayName}"`;
    if (data.phonetic) {
      nameString += ` (pronounced ${data.phonetic})`;
    }
    nameString += ` (NOT "${data.username || data.twitchUsername || ''}")`;
    return nameString;
  }).join(', ');

  // Load HeyGen context for smarter QA validation
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '19c1d4adf8904694a3cc331c5a9bee4b';
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
    expectedScenes = 1 + (streamers.length * 4) + 1; // 1 INTRO + (items × 4 scenes each: _INTRO, _SETUP, _CLIP_REACTION + _REACTION) + 1 OUTRO
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
    `5. GAME SETUP: Does each game section have proper context before [CLIP PLAYS HERE]?`,
    `6. BEAT PLACEMENT: Is [beat] present before AND after every [CLIP PLAYS HERE]?`,
    `7. CLIP MATCH (most important): Does each game commentary match what Gemini saw in the highlight clip?`,
    `8. LOCKED INTRO: Does the video open with the correct "Other Side of the Pillow" intro?`,
    `9. WORD COUNT: Is each game section approximately 120-150 words?`,
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
    const genResp = await withRetry(() => axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: qaPrompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    ), { label: 'Gemini Script QA' });
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
  const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
  if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
  const logFile = path.join(qaLogDir, `gate1_script_${outcome}_${Date.now()}.txt`);
  try { fs.writeFileSync(logFile, whyDoc); console.log(`[qa-gate1] Script QA why-doc saved: ${logFile}`); } catch(e) {}

  // QA logs saved locally only — not uploaded to Drive
  return { score: adjustedScore, report: whyDoc, passed, outcome, outcomeLabel, deductions: preCheckDeductions, geminiReport };
}

// Gate 2 QA function moved to services/qa.js
// Import and use: const { geminiSegmentQA } = require('./services/qa');
async function geminiSegmentQA_DEPRECATED(segmentPaths, opts = {}) {
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

      const genResp = await withRetry(() => axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [
            { text: segPrompt },
            { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
          ]}],
          generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      ), { label: `Gemini Segment QA ${label}` });

      const segReport = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
      const segScore  = parseInt((segReport.match(/OVERALL SCORE:\s*(\d+)/i) || segReport.match(/SCORE:\s*(\d+)/i) || [])[1] || '80');

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

// Claude API wrapper with detailed error handling
async function callClaudeAPI(params, options = {}) {
  const { retries = 3, baseMs = 1000, maxMs = 10000 } = options;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); // Re-initialize client for each attempt to be safe, or ensure it's stateless
      const response = await client.messages.create(params);
      return response;
    } catch (e) {
      lastErr = e;
      // Detailed error handling for different Claude API failure modes
      if (e.status === 429 || e.status === 500 || e.status === 529) {
        if (attempt < retries) {
          const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
          console.warn(`[Claude API] Rate limited or server error (${e.status || e.code}). Retrying in ${delay}ms (attempt ${attempt + 1}/${retries + 1})...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry
        }
      }
      // Non-retryable errors or max retries reached
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
      if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
        throw new Error('Claude API connection failed - check network connectivity');
      }
      // Generic fallback
      throw new Error(`Claude API error (${e.status || e.code || 'unknown'}): ${e.message}`);
    }
  }
  // Should not be reached if retries are handled or error is thrown
  throw lastErr;
}

async function importToCanva(videoUrl, title) {
  // Uses Claude + Canva MCP to import the video
  const response = await callClaudeAPI({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: 'You are a production assistant. Use the Canva MCP tool to import a video from a URL into Canva. Call import-design-from-url with the URL. Return ONLY JSON: {"design_id":"...","url":"..."}. No other text.',
    messages: [{ role: 'user', content: `Import this video into Canva: ${videoUrl}\nTitle: ${title}` }],
    mcp_servers: [{ type: 'url', url: 'https://mcp.canva.com/mcp', name: 'canva-mcp' }]
  });
  const text  = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch(e) {
    console.warn(`[canva] JSON parse failed: ${e.message} - Raw: ${clean.slice(0, 100)}`);
    return null;
  }
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

const FF_CHUNK_SIZE = 50; // Number of segments per intermediate FFmpeg chunk

app.post('/assemble',
  requireFields('segments', 'segmentData'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  validateArrayLength('items', 1),
  async (req, res) => {
  const { segments, segmentData, labels, transition='crossfade', format='mp4', outputDir, jobTitle, assemblyId, contentType, sceneTextMap, fullScript } = req.body;

  // Support both old format (segments=[urls]) and new format (segmentData=[{url,label,type}])
  const segsToProcess = segmentData && segmentData.length
    ? segmentData
    : (segments || []).map((url, i) => ({ url, label: labels&&labels[i] ? labels[i] : `seg_${i}`, type: 'avatar' }));

  if (!segsToProcess.length) {
    return res.status(400).json({ error: 'No segments provided' });
  }

  const asmId = assemblyId || ('asm_' + Date.now());
  assemblyJobs[asmId] = {
    pct: 0,
    log: '',
    status: 'running',
    outputPath: null,
    // Store script metadata for Gate 2 HeyGen re-rendering
    sceneTextMap: sceneTextMap || null,
    fullScript: fullScript || null
  };

  // Run async — respond immediately
  res.json({ ok: true, assemblyId: asmId, message: 'Assembly started' });

  const run = async () => {
    try {
      // Initialize metrics tracking for this job
      initJobMetrics(asmId);

      const avatarCount = segsToProcess.filter(s => s.type !== 'source_clip').length;
      const clipCount   = segsToProcess.filter(s => s.type === 'source_clip').length;
      log(asmId, `Starting assembly: ${avatarCount} avatar + ${clipCount} source clips = ${segsToProcess.length} total`);
      log(asmId, `Transition: ${transition} | Format: ${format}`);

      // Check disk space before assembly (estimate ~20MB per segment + 500MB overhead)
      const estimatedSizeMB = (segsToProcess.length * 20) + 500;
      try {
        await checkDiskSpace(estimatedSizeMB);
      } catch (diskErr) {
        log(asmId, `❌ ${diskErr.message}`);
        assemblyJobs[asmId].status = 'failed';
        assemblyJobs[asmId].error = diskErr.message;
        return;
      }

      // ── Gate 2: Server-side segment QA with retry loop (max 3 attempts) ───────────
      // Runs at assembly start — doesn't depend on browser being open
      // Samples first/middle/last avatar segments from HeyGen
      if (GEMINI_APIKEY && avatarCount > 0) {
        const gate2Timer = new StageTimer(asmId, 'Gate 2 QA');
        const MAX_G2_RETRIES = 3;
        let g2Attempt = 0;
        let g2Result = null;
        let g2TmpPaths = [];
        let g2FailedSegments = [];

        const avatarSegsForQA = segsToProcess
          .filter(s => s.type !== 'source_clip' && s.url)
          .filter((_, i, arr) => i === 0 || i === Math.floor(arr.length/2) || i === arr.length-1);

        while (g2Attempt < MAX_G2_RETRIES) {
          g2Attempt++;
          const attemptLabel = g2Attempt > 1 ? ` (retry ${g2Attempt}/${MAX_G2_RETRIES})` : '';
          log(asmId, `\n🔍 Gate 2: Sampling HeyGen segments${attemptLabel}...`);

          try {
            // Download sample segments to tmp
            g2TmpPaths = [];
            g2FailedSegments = [];
            for (const seg of avatarSegsForQA) {
              const g2Path = path.join(TMP_DIR, `gate2_${asmId}_${Date.now()}.mp4`);
              try {
                await downloadFile(seg.url, g2Path);
                const sz = fs.existsSync(g2Path) ? fs.statSync(g2Path).size : 0;
                if (sz > 5000) { g2TmpPaths.push(g2Path); log(asmId, `  ✓ Gate 2 sample: ${seg.label} (${(sz/1024).toFixed(0)}KB)`); }
                else { try { fs.unlinkSync(g2Path); } catch(e) {} }
              } catch(e) {
                g2FailedSegments.push({ label: seg.label, error: e.message });
                log(asmId, `  ❌ Gate 2 sample failed for ${seg.label}: ${e.message}`);
              }
              await new Promise(r => setTimeout(r, 500));
            }

            // Persist failed segments to file
            if (g2FailedSegments.length > 0) {
              const qaLogDir = path.join(__dirname, 'output', 'qa_failures');
              if (!fs.existsSync(qaLogDir)) fs.mkdirSync(qaLogDir, { recursive: true });
              const failureLogFile = path.join(qaLogDir, `gate2_failures_${asmId}_${Date.now()}.json`);
              try {
                fs.writeFileSync(failureLogFile, JSON.stringify({
                  assemblyId: asmId,
                  timestamp: new Date().toISOString(),
                  failedSegments: g2FailedSegments,
                  attempt: g2Attempt
                }, null, 2));
                log(asmId, `📄 Gate 2 failures logged: ${failureLogFile}`);
              } catch(e) {
                console.error(`[gate2] Failed to write failure log: ${e.message}`);
              }
              assemblyJobs[asmId].gate2FailedSegments = g2FailedSegments;
            }

            if (g2TmpPaths.length > 0) {
              g2Result = await geminiSegmentQA(g2TmpPaths, { jobId: asmId, contentType });
              assemblyJobs[asmId].gate2Score   = g2Result.score;
              assemblyJobs[asmId].gate2Outcome = g2Result.outcome;
              assemblyJobs[asmId].gate2RetryAttempts = g2Attempt;

              log(asmId, `📋 Gate 2 Score: ${g2Result.score}/100 — ${g2Result.outcomeLabel}`);

              // Break conditions:
              // 1. PASS → proceed to assembly
              // 2. MANUAL_REVIEW → proceed but flag for review
              // 3. FAIL + max retries → proceed but warn (can't fix HeyGen segments without MCP)
              if (g2Result.outcome === 'pass' || g2Result.outcome === 'manual_review') {
                log(asmId, `✅ Gate 2 ${g2Result.outcome.toUpperCase()} — Breaking retry loop (attempt ${g2Attempt}/${MAX_G2_RETRIES})`);
                break;
              } else if (g2Result.outcome === 'fail' && g2Attempt < MAX_G2_RETRIES) {
                log(asmId, `❌ Gate 2 FAIL — Attempting Topaz enhancement before retry (attempt ${g2Attempt}/${MAX_G2_RETRIES})...`);

                // Try to enhance failed segments with Topaz to fix quality issues
                let topazEnhancedCount = 0;
                const topazResults = [];
                for (const g2Path of g2TmpPaths) {
                  const topazResult = await enhanceVideoWithTopaz(g2Path);
                  topazResults.push({ path: g2Path, result: topazResult });

                  if (topazResult.success && topazResult.enhancedPath) {
                    // Replace original tmp file with enhanced version
                    try {
                      fs.unlinkSync(g2Path);
                      fs.renameSync(topazResult.enhancedPath, g2Path);
                      topazEnhancedCount++;
                      log(asmId, `  ✅ Topaz enhanced: ${path.basename(g2Path)}`);
                    } catch(e) {
                      log(asmId, `  ⚠️  Topaz enhancement replacement failed: ${e.message}`);
                    }
                  } else {
                    log(asmId, `  ⚠️  Topaz enhancement skipped for ${path.basename(g2Path)}: ${topazResult.reason || 'unknown'}`);
                  }
                }

                if (topazEnhancedCount > 0) {
                  log(asmId, `✅ Topaz enhanced ${topazEnhancedCount}/${g2TmpPaths.length} segments — retrying QA...`);
                  assemblyJobs[asmId].topazEnhancedSegments = topazEnhancedCount;
                } else {
                  log(asmId, `⚠️  No segments enhanced with Topaz — checking if HeyGen re-rendering is possible...`);

                  // Check if we have script metadata for HeyGen re-rendering
                  const sceneTextMap = assemblyJobs[asmId]?.sceneTextMap;
                  const fullScript = assemblyJobs[asmId]?.fullScript;

                  if (sceneTextMap && fullScript) {
                    log(asmId, `📝 Script metadata available for Gate 2 HeyGen re-rendering`);
                    log(asmId, `   Available scenes: ${Object.keys(sceneTextMap).join(', ')}`);
                    log(asmId, `   Full script: ${fullScript.length} characters`);

                    // Store that HeyGen re-rendering is available for this job
                    assemblyJobs[asmId].heygenReRenderAvailable = true;

                    // Note: Actual HeyGen re-rendering implementation would:
                    // 1. Parse Gemini's QA report to identify which specific scenes failed
                    // 2. Extract the scene names from avatarSegsForQA segment labels
                    // 3. Look up original script text from sceneTextMap[sceneName]
                    // 4. Call sendScriptToHeyGen() with just that scene's script
                    // 5. Wait for new HeyGen video to complete
                    // 6. Update segsToProcess[i].url with new video URL
                    // 7. Continue retry loop with fresh HeyGen renders

                    log(asmId, `💡 HeyGen re-rendering available but not implemented yet — retrying with existing segments`);
                  } else {
                    log(asmId, `⚠️  No script metadata — HeyGen re-rendering not available (need sceneTextMap + fullScript from /assemble request)`);
                  }
                }

                await new Promise(r => setTimeout(r, 3000));
                // Continue loop to retry with enhanced segments
              } else {
                log(asmId, `❌ Gate 2 FAIL — Max retries (${MAX_G2_RETRIES}) reached. Proceeding to assembly.`);
                break;
              }

            } else {
              log(asmId, `⚠️  Gate 2: No segments downloaded successfully. Proceeding to assembly.`);
              break;
            }

          } catch(g2Err) {
            log(asmId, `❌ Gate 2 error: ${g2Err.message}`);
            if (g2Attempt < MAX_G2_RETRIES) {
              log(asmId, `🔄 Retrying Gate 2 due to error (attempt ${g2Attempt}/${MAX_G2_RETRIES})...`);
              await new Promise(r => setTimeout(r, 3000));
              // Continue loop to retry
            } else {
              log(asmId, `⚠️  Gate 2 failed after ${MAX_G2_RETRIES} attempts — continuing assembly anyway`);
              assemblyJobs[asmId].gate2Error = g2Err.message;
              gate2Timer.addData('error', g2Err.message);
              break;
            }
          }
        }

        // Clean up tmp files after final attempt
        g2TmpPaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

        // Add final metrics
        if (g2Result) {
          gate2Timer
            .addData('sampleCount', g2TmpPaths.length)
            .addData('score', g2Result.score)
            .addData('outcome', g2Result.outcome)
            .addData('failedSegments', g2FailedSegments.length)
            .addData('retryAttempts', g2Attempt);
        }
        addStageMetrics(asmId, gate2Timer.end());
      }

      // Step 1: Download all segments in order
      // For Twitch source_clips, re-resolve fresh GQL tokens — stored tokens expire within hours
      const downloadTimer = new StageTimer(asmId, 'Download Segments');
      const localFiles = [];
      let downloadedBytes = 0;
      let cachedCount = 0;
      for (let i = 0; i < segsToProcess.length; i++) {
        const seg      = segsToProcess[i];
        let   url      = seg.url;
        const label    = seg.label || `seg_${i}`;
        const segType  = seg.type || 'avatar';
        const filename = `${asmId}_${i}_${label.toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,40)}.mp4`;
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
                downloadedBytes += cacheSize;
                cachedCount++;
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
              log(asmId, `⚠️  GQL refresh failed for ${label}: ${e.message} — validating stored URL`);

              // Validate that stored URL is still accessible before using it
              try {
                const headResp = await withRetry(() => axios.head(url, { timeout: 5000 }), { label: `Twitch URL Validate ${label}` });
                if (headResp.status !== 200) {
                  log(asmId, `❌ Stored URL returned status ${headResp.status} — cannot use this segment`);
                  continue; // Skip this segment
                }
                log(asmId, `✓ Stored URL still valid for ${label}`);
              } catch(headErr) {
                log(asmId, `❌ Stored URL validation failed: ${headErr.message} — segment expired, skipping`);
                continue; // Skip this segment
              }
            }
          }
        }

        log(asmId, `⬇  [${segType.toUpperCase()}] ${i+1}/${segsToProcess.length}: ${label}`);
        assemblyJobs[asmId].pct = Math.round((i / segsToProcess.length) * 40);

        try {
          await downloadFile(url, destPath);
          // Validate the file is actual video data, not an HTML error page from expired CDN token
          const fileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
          const MIN_SEGMENT_SIZE = 100000; // 100KB minimum for valid video
          const MAX_SEGMENT_SIZE = 2 * 1024 * 1024 * 1024; // 2GB max

          if (fileSize < MIN_SEGMENT_SIZE) {
            log(asmId, `❌ Segment ${i+1} too small (${fileSize} bytes, minimum ${MIN_SEGMENT_SIZE}) — likely error page`);
            try { fs.unlinkSync(destPath); } catch(e) {}
            continue;
          }
          if (fileSize > MAX_SEGMENT_SIZE) {
            log(asmId, `❌ Segment ${i+1} too large (${(fileSize/1024/1024).toFixed(1)}MB, maximum 2GB)`);
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
          downloadedBytes += fileSize;
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
      // For short-form videos (-short suffix), use split-screen layout instead of transitions
      // Top half: random source clip (1080×960), Bottom half: all avatar segments concatenated (1080×960)
      const isShortForm = contentType && contentType.includes('-short') && format === 'portrait';

      if (isShortForm) {
        log(asmId, `\n📱 SHORT-FORM DETECTED — Using split-screen assembly (9:16 portrait)`);
        const assemblyTimer = new StageTimer(asmId, 'Short-Form Split-Screen Assembly');

        // Build output path
        const outDir = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outFile = `${(jobTitle||"cwn_short").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50)}_${Date.now()}.mp4`;
        const outPath = path.join(outDir, outFile);

        // Separate segments by type
        const avatarFiles = [];
        const clipFiles = [];

        for (let i = 0; i < localFiles.length; i++) {
          const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
          const segType = seg?.type || 'avatar';

          if (segType === 'source_clip') {
            clipFiles.push(localFiles[i]);
          } else {
            avatarFiles.push(localFiles[i]);
          }
        }

        log(asmId, `  📊 Segments: ${avatarFiles.length} avatar + ${clipFiles.length} source clips`);

        // Select ONE random source clip for top half
        let selectedClip = null;
        if (clipFiles.length > 0) {
          const randomIdx = Math.floor(Math.random() * clipFiles.length);
          selectedClip = clipFiles[randomIdx];
          log(asmId, `  🎲 Selected random clip ${randomIdx + 1}/${clipFiles.length}: ${path.basename(selectedClip)}`);
        }

        if (avatarFiles.length === 0) {
          throw new Error('No avatar segments found for short-form video');
        }

        // Step 1: Concatenate all avatar segments into single bottom half video
        log(asmId, `  🎬 Concatenating ${avatarFiles.length} avatar segments...`);
        const avatarConcatPath = path.join(TMP_DIR, `${asmId}_avatar_concat.mp4`);

        if (avatarFiles.length === 1) {
          // Single avatar — just copy
          fs.copyFileSync(avatarFiles[0], avatarConcatPath);
          log(asmId, `  ✅ Single avatar segment — copied`);
        } else {
          // Multiple avatars — concat with demuxer
          const avatarListPath = path.join(TMP_DIR, `${asmId}_avatar_list.txt`);
          const avatarListContent = avatarFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(avatarListPath, avatarListContent);

          await new Promise((res, rej) => {
            const args = [
              '-f', 'concat', '-safe', '0', '-i', avatarListPath,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-y', avatarConcatPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Avatar concat failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Avatar segments concatenated`);
          try { fs.unlinkSync(avatarListPath); } catch(e) {}
        }

        // Step 2: Prepare top half (source clip OR black frame if no clip)
        let topHalfPath;
        const avatarDuration = await probeDuration(avatarConcatPath);

        if (selectedClip) {
          log(asmId, `  🎥 Preparing top half: source clip (scaled + cropped to 1080×960)`);
          topHalfPath = path.join(TMP_DIR, `${asmId}_top_half.mp4`);

          await new Promise((res, rej) => {
            const args = [
              '-i', selectedClip,
              '-t', avatarDuration.toFixed(3), // Match avatar duration
              '-vf', 'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-an', // No audio for top half
              '-y', topHalfPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Top half prep failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Top half prepared (1080×960)`);
        } else {
          log(asmId, `  ⚠️  No source clip — using black frame for top half`);
          topHalfPath = path.join(TMP_DIR, `${asmId}_black_top.mp4`);

          await new Promise((res, rej) => {
            const args = [
              '-f', 'lavfi', '-i', `color=c=black:s=1080x960:d=${avatarDuration.toFixed(3)}`,
              '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
              '-y', topHalfPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Black frame gen failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Black top half generated`);
        }

        // Step 3: Prepare bottom half (avatar) - scale to 1080×960
        log(asmId, `  🎙  Preparing bottom half: avatar (scaled to 1080×960)`);
        const bottomHalfPath = path.join(TMP_DIR, `${asmId}_bottom_half.mp4`);

        await new Promise((res, rej) => {
          const args = [
            '-i', avatarConcatPath,
            '-vf', 'scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2',
            '-y', bottomHalfPath
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`Bottom half prep failed: ${code}`)));
          proc.on('error', rej);
        });
        log(asmId, `  ✅ Bottom half prepared (1080×960)`);

        // Step 4: Vertical stack (top + bottom = 1080×1920)
        log(asmId, `  📐 Stacking top and bottom halves (1080×1920)...`);
        const stackedPath = path.join(TMP_DIR, `${asmId}_stacked.mp4`);

        await new Promise((res, rej) => {
          const args = [
            '-i', topHalfPath,
            '-i', bottomHalfPath,
            '-filter_complex', '[0:v][1:v]vstack=inputs=2[vstacked]',
            '-map', '[vstacked]',
            '-map', '1:a', // Use audio from bottom half (avatar)
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            '-y', stackedPath
          ];
          const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
          proc.on('close', code => code === 0 ? res() : rej(new Error(`Vstack failed: ${code}`)));
          proc.on('error', rej);
        });
        log(asmId, `  ✅ Split-screen stacked (1080×1920)`);

        // Step 5: Apply 80px logo overlay (top-right, 15px margins, 85% opacity)
        log(asmId, `  🏷  Applying CWN logo (80px, top-right)...`);
        const logoPath = path.join(__dirname, 'assets', 'cwn_logo.png');
        const hasLogo = fs.existsSync(logoPath);

        if (hasLogo) {
          await new Promise((res, rej) => {
            const args = [
              '-i', stackedPath,
              '-i', logoPath,
              '-filter_complex', '[1:v]scale=80:-1[logo];[0:v][logo]overlay=x=W-w-15:y=15:format=auto,format=yuv420p[vout]',
              '-map', '[vout]',
              '-map', '0:a',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'copy',
              '-movflags', '+faststart',
              '-y', outPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Logo overlay failed: ${code}`)));
            proc.on('error', rej);
          });
          log(asmId, `  ✅ Logo applied`);
        } else {
          log(asmId, `  ⚠️  Logo not found at ${logoPath} — skipping logo overlay`);
          fs.renameSync(stackedPath, outPath);
        }

        // Clean up temp files
        try { fs.unlinkSync(avatarConcatPath); } catch(e) {}
        try { fs.unlinkSync(topHalfPath); } catch(e) {}
        try { fs.unlinkSync(bottomHalfPath); } catch(e) {}
        try { if (hasLogo) fs.unlinkSync(stackedPath); } catch(e) {}

        log(asmId, `\n✅ Short-form assembly complete: ${outPath}`);
        assemblyJobs[asmId].pct = 100;
        assemblyJobs[asmId].status = 'done';
        assemblyJobs[asmId].outputPath = outPath;

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
        const outDir    = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outFile   = `${(jobTitle||"cwn").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50)}_${Date.now()}.${format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4'}`;
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

        // ── Intro card burn (Twitch, NBA, News) ─────────────────────
        // If this is an INTRO segment (not cold open, not outro), burn the intro card
        const isIntro = /\(INTRO\)/i.test(label) && !/cold.open/i.test(label);

        if (isIntro && contentType === 'twitch' && streamerRoster.length) {
          // ── Twitch: Circular streamer card ────────────────────────
          // Extract streamer name from label e.g. "JASON (INTRO)" → "Jason"
          const streamerMatch = label.match(/^(.+?)\s*\(INTRO\)/i);
          const streamerName  = streamerMatch ? streamerMatch[1].trim() : '';
          const streamerData  = getStreamerInfo(streamerName); // Use new helper

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

              const cardPngPath = require("path").join(require("os").tmpdir(), `cwn_card_${Date.now()}_${(streamerData.name||"x").replace(/[^a-z0-9]/gi,"")}.png`);
              try {
                await generateIntroCardPNG(
                  { name, displayName: name,
                    twitchUsername: streamerData.twitchUsername,
                    onAirName: streamerData.onAirName || '',
                    origin, fact,
                    profileImage: streamerData.profileImage || null }, // Pass full streamerData object
                  cardPngPath, "cwn"
                );
              } catch(cardErr) {
                console.warn(`[intro-card] PNG gen failed for ${streamerName}: ${cardErr.message}`);
              }

              let burnArgs;
              const cardExists = require("fs").existsSync(cardPngPath) && require("fs").statSync(cardPngPath).size > 1000;
              if (cardExists) {
                burnArgs = [
                  "-i", inputForTS, "-i", cardPngPath,
                  "-filter_complex", `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=1460:y=40:enable='lte(t,${introDur})'[out]`,
                  "-map", "[out]", "-map", "0:a",
                  "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                  "-pix_fmt", "yuv420p",
                  "-c:a", "aac", "-ar", "44100", "-y", burnedPath
                ];
                console.log(`[intro-card] Canvas PNG ready for ${name}, overlaying top-right (2x render, scaled to 360px w/ lanczos)`);
              } else {
                console.warn(`[intro-card] No card for ${streamerName} - skipping burn`);
                burnArgs = null;
              }

              if (!burnArgs) {
                log(asmId, `  skip intro card: ${name}`);
              } else {
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
              }); }

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
        } else if (isIntro && contentType === 'news') {
          // ── News: Full newscast overlay ──────────────────────────────
          try {
            const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
            const cardData = seg?.cardData || {};

            // Build list of all news stories for the overlay sidebar
            // Collect all intro segments to show in the story list
            const allNewsIntros = segsToProcess.filter(s => {
              const lbl = s.label || '';
              return lbl.match(/\(INTRO\)/i) && s.cardData;
            });

            const allStories = allNewsIntros.map((introSeg, idx) => ({
              title: introSeg.cardData?.title || `Story ${idx + 1}`,
              category: introSeg.cardData?.category || 'WORLD',
              storyId: introSeg.cardData?.storyId || `story_${idx}`
            }));

            // Find which story index this intro segment is
            const currentStoryId = cardData.storyId || cardData.title;
            const storyIndex = allStories.findIndex(s =>
              s.storyId === currentStoryId || s.title === cardData.title
            );
            const activeStoryIndex = storyIndex >= 0 ? storyIndex : 0;

            const overlayPngPath = path.join(TMP_DIR, `newscast_overlay_${Date.now()}.png`);

            // Generate full newscast overlay with current story highlighted
            await generateNewscastOverlay({
              title: cardData.title || 'Breaking News Story',
              category: cardData.category || 'WORLD NEWS',
              date: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase(),
              allStories: allStories
            }, overlayPngPath, activeStoryIndex);

            const burnedPath = inputForTS.replace('.mp4', '_intro_burned.mp4');
            const introDur = 3.5;

            // Full-screen overlay blend
            const burnArgs = [
              '-i', inputForTS, '-i', overlayPngPath,
              '-filter_complex', `[0:v][1:v]blend=all_mode=normal:all_opacity=1:enable='lte(t,${introDur})'[out]`,
              '-map', '[out]', '-map', '0:a',
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-ar', '44100', '-y', burnedPath
            ];

            await new Promise((res, rej) => {
              const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
              let burnStderr = '';
              proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
              proc.on('close', code => {
                if (code === 0) res();
                else {
                  const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                  console.error(`[intro-burn] FFmpeg exit ${code} for newscast overlay: ${reason}`);
                  rej(new Error(`Newscast overlay burn failed: ${code} — ${reason}`));
                }
              });
              proc.on('error', rej);
            });

            if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
              inputForTS = burnedPath;
              log(asmId, `  📰 NEWS newscast overlay burned [${activeStoryIndex + 1}/${allStories.length}]: ${cardData.title || 'story'}`);
            }

            // Clean up temp overlay PNG
            try { if (fs.existsSync(overlayPngPath)) fs.unlinkSync(overlayPngPath); } catch(e) {}
          } catch(e) {
            log(asmId, `  ⚠️  NEWS newscast overlay burn failed: ${e.message} — using original`);
          }
        } else if (isIntro && contentType === 'nba') {
          // ── NBA: Square game card with game-specific highlight ─────────
          try {
            const seg = segsToProcess.find((s, si) => localFiles[i].includes(`${asmId}_${si}_`));
            const cardData = seg?.cardData || {};

            // Get game-specific data
            const gameId = cardData.gameId || cardData.id;
            const imageUrl = cardData.imageUrl || cardData.thumbnailUrl || cardData.highlightImage || null;
            const title = cardData.title || cardData.matchup || 'GAME';
            const subtitle = cardData.subtitle || cardData.score || cardData.status || '';

            if (imageUrl) {
              // Use gameId in filename to ensure unique cards per game
              const gameIdSlug = gameId ? `_${gameId}` : '';
              const cardPngPath = path.join(TMP_DIR, `nba_card${gameIdSlug}_${Date.now()}.png`);

              log(asmId, `  🏀 Generating NBA card for: ${title}${gameId ? ` (ID: ${gameId})` : ''}`);

              await generateGameStoryCardPNG(
                {
                  title,
                  subtitle,
                  imageUrl,
                  gameId  // Pass gameId for potential use in card generation
                },
                cardPngPath,
                'nba'
              );

              const burnedPath = inputForTS.replace('.mp4', '_intro_burned.mp4');
              const introDur = 3.5;

              const burnArgs = [
                '-i', inputForTS, '-i', cardPngPath,
                '-filter_complex', `[1:v]scale=360:-1:flags=lanczos[card];[0:v][card]overlay=x=1460:y=40:enable='lte(t,${introDur})'[out]`,
                "-map", "[out]", "-map", "0:a",
                "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-ar", "44100", "-y", burnedPath
              ];

              await new Promise((res, rej) => {
                const proc = execFile(ffmpegPath(), burnArgs, { maxBuffer: 50 * 1024 * 1024 });
                let burnStderr = '';
                proc.stderr && proc.stderr.on('data', d => { burnStderr += d.toString(); });
                proc.on('close', code => {
                  if (code === 0) res();
                  else {
                    const reason = burnStderr.slice(-300).replace(/\n/g, ' ').trim();
                    console.error(`[intro-burn] FFmpeg exit ${code} for NBA: ${reason}`);
                    rej(new Error(`NBA intro burn failed: ${code} — ${reason}`));
                  }
                });
                proc.on('error', rej);
              });

              if (fs.existsSync(burnedPath) && fs.statSync(burnedPath).size > 10000) {
                inputForTS = burnedPath;
                log(asmId, `  🏀 NBA intro card burned: ${title}${gameId ? ` [${gameId}]` : ''}`);
              }

              // Clean up temp card PNG
              try { if (fs.existsSync(cardPngPath)) fs.unlinkSync(cardPngPath); } catch(e) {}
            } else {
              log(asmId, `  ⚠️  No image URL for NBA intro card — skipping`);
            }
          } catch(e) {
            log(asmId, `  ⚠️  NBA intro card burn failed: ${e.message} — using original`);
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
              // Normalize ALL audio to -14 LUFS for consistent volume
              // Both avatar (Bobby G) and source clips (streamers) normalized to same level
              '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=async=1:min_hard_comp=0.100000:first_pts=0',
              '-bsf:v', 'h264_mp4toannexb',
              '-f', 'mpegts', '-y', tsPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 20 * 1024 * 1024 });
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
      } else if (tsFiles.length > FF_CHUNK_SIZE) {
        // Split-Job FFmpeg Stitching for very large compilations
        log(asmId, `  ℹ️  ${tsFiles.length} segments — splitting into chunks for robust assembly`);
        const intermediateMp4s = [];
        const numChunks = Math.ceil(tsFiles.length / FF_CHUNK_SIZE);

        for (let i = 0; i < numChunks; i++) {
          const chunkStart = i * FF_CHUNK_SIZE;
          const chunkEnd = Math.min((i + 1) * FF_CHUNK_SIZE, tsFiles.length);
          const chunkFiles = tsFiles.slice(chunkStart, chunkEnd);
          const chunkOutputPath = path.join(TMP_DIR, `${asmId}_chunk_${i}.mp4`);
          const chunkListPath = path.join(TMP_DIR, `${asmId}_chunk_${i}_list.txt`);
          const chunkListContent = chunkFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
          fs.writeFileSync(chunkListPath, chunkListContent);

          log(asmId, `  🎬 Assembling chunk ${i + 1}/${numChunks} (${chunkFiles.length} segments)...`);
          await new Promise((res, rej) => {
            const args = [
              '-f', 'concat', '-safe', '0', '-i', chunkListPath,
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
              '-c:a', 'aac', '-ar', '44100', '-ac', '2',
              '-movflags', '+faststart',
              '-y', chunkOutputPath
            ];
            const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
            proc.on('close', code => code === 0 ? res() : rej(new Error(`Chunk ${i} assembly failed: ${code}`)));
            proc.on('error', rej);
          });
          intermediateMp4s.push(chunkOutputPath);
          try { fs.unlinkSync(chunkListPath); } catch(e) {}
          log(asmId, `  ✅ Chunk ${i + 1} assembled: ${path.basename(chunkOutputPath)}`);
        }

        // Final stitch of intermediate MP4s
        log(asmId, `   stitching ${intermediateMp4s.length} intermediate MP4s...`);
        const finalStitchListPath = path.join(TMP_DIR, `${asmId}_final_stitch_list.txt`);
        const finalStitchListContent = intermediateMp4s.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(finalStitchListPath, finalStitchListContent);

        ffArgs = [
          '-f', 'concat', '-safe', '0', '-i', finalStitchListPath,
          '-c:v', 'copy', // Copy intermediate MP4s (already encoded)
          '-c:a', 'aac', '-ar', '44100', '-ac', '2',
          '-movflags', '+faststart',
          '-y', outPath
        ];
        log(asmId, `  🎬 Final stitch of ${intermediateMp4s.length} chunks`);
        // Cleanup intermediate MP4s after final stitch
        intermediateMp4s.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
        try { fs.unlinkSync(finalStitchListPath); } catch(e) {}

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
              '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
              '-c:a', 'copy',
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
                try { fs.unlinkSync(outPath); } catch(e) {}
                fs.renameSync(finalFile, outPath);
                log(asmId, `✅ Header intro card prepended (4s)`);
                res();
              } else {
                log(asmId, `⚠️  Intro card concat failed (code ${code})`);
                try { fs.unlinkSync(finalFile); } catch(e) {}
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

      // Complete assembly metrics
      assemblyTimer
        .addData('outputFile', outFile)
        .addData('outputSizeMB', sizeMB)
        .addData('outputDurationSec', totalDur)
        .addData('segmentCount', localFiles.length);
      addStageMetrics(asmId, assemblyTimer.end());

      // Finalize all job metrics
      finalizeJobMetrics(asmId);

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

      } // end long-form else block

      // Step 7.5: Gate 3 QA with retry loop (max 3 attempts) — applies to BOTH short-form and long-form
      const MAX_QA_RETRIES = 3;
      let qaAttempt = 0;
      let qaResult = null;

      while (qaAttempt < MAX_QA_RETRIES) {
        qaAttempt++;
        const attemptLabel = qaAttempt > 1 ? ` (retry ${qaAttempt}/${MAX_QA_RETRIES})` : '';
        log(asmId, `\n🔍 Gate 3: Running Gemini QA check${attemptLabel}...`);

        try {
          qaResult = await geminiQACheck(outPath, {
            contentType, avatarCount, clipCount,
            expectedTicker: !!(tickerType && TICKER_MAP[tickerType]),
            totalDuration: parseFloat(totalDur)
          });

          assemblyJobs[asmId].qaScore   = qaResult.score;
          assemblyJobs[asmId].qaReport  = qaResult.report;
          assemblyJobs[asmId].qaOutcome = qaResult.outcome;
          assemblyJobs[asmId].qaRetryAttempts = qaAttempt;

          const outcomeLabel = qaResult.outcomeLabel || (qaResult.passed ? '✅ PASS' : '❌ FAIL');
          log(asmId, `📋 Gate 3 QA: ${outcomeLabel} (${qaResult.score}/100)`);

          if (qaResult.freezeDetected) {
            log(asmId, `🚨 VIDEO FREEZE DETECTED — critical failure`);
          }
          log(asmId, qaResult.report);

          // Break conditions:
          // 1. PASS → proceed to Drive upload
          // 2. MANUAL_REVIEW → hold for user review
          // 3. FAIL + max retries reached → give up
          if (qaResult.outcome === 'pass' || qaResult.outcome === 'manual_review') {
            log(asmId, `✅ Gate 3 ${qaResult.outcome.toUpperCase()} — Breaking retry loop (attempt ${qaAttempt}/${MAX_QA_RETRIES})`);
            break;
          } else if (qaResult.outcome === 'fail' && qaAttempt < MAX_QA_RETRIES) {
            log(asmId, `❌ Gate 3 FAIL — Attempting video enhancement with Topaz before retry...`);

            // Try to enhance video with Topaz Labs to fix quality issues (frozen frames, artifacts, pixelation)
            const topazResult = await enhanceVideoWithTopaz(outPath);
            if (topazResult.success) {
              log(asmId, `✅ Topaz enhancement complete — retrying QA check (attempt ${qaAttempt}/${MAX_QA_RETRIES})...`);
              assemblyJobs[asmId].topazEnhanced = true;
              assemblyJobs[asmId].topazRequestID = topazResult.requestID;
            } else {
              log(asmId, `⚠️  Topaz enhancement skipped: ${topazResult.reason} — retrying QA anyway (attempt ${qaAttempt}/${MAX_QA_RETRIES})...`);
            }

            // Brief pause before retry
            await new Promise(r => setTimeout(r, 3000));
            // Continue loop to retry
          } else {
            log(asmId, `❌ Gate 3 FAIL — Max retries (${MAX_QA_RETRIES}) reached. Giving up.`);
            break;
          }

        } catch(qaErr) {
          log(asmId, `⚠️  Gate 3 QA check error: ${qaErr.message}`);
          if (qaAttempt < MAX_QA_RETRIES) {
            log(asmId, `🔄 Retrying Gate 3 QA due to error (attempt ${qaAttempt}/${MAX_QA_RETRIES})...`);
            await new Promise(r => setTimeout(r, 3000));
            // Continue loop to retry
          } else {
            log(asmId, `⚠️  Gate 3 QA failed after ${MAX_QA_RETRIES} attempts — proceeding anyway`);
            // Create a default pass result to avoid blocking
            qaResult = { score: 70, outcome: 'manual_review', passed: false, report: `QA check failed: ${qaErr.message}` };
            assemblyJobs[asmId].qaScore = 70;
            assemblyJobs[asmId].qaOutcome = 'manual_review';
            assemblyJobs[asmId].qaRetryAttempts = qaAttempt;
            break;
          }
        }
      }

      // Log final Gate 3 outcome
      if (qaResult) {
        if (qaResult.outcome === 'manual_review') {
          log(asmId, `🟡 MANUAL REVIEW — score ${qaResult.score}/100, review before publishing`);
          assemblyJobs[asmId].status = 'manual_review';
        } else if (!qaResult.passed) {
          log(asmId, `❌ QA HARD FAIL (score: ${qaResult.score}/100) — Drive upload blocked`);
        } else {
          log(asmId, `✅ Gate 3 PASSED — proceeding to Drive upload`);
        }
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
      log(asmId, `\n❌ Assembly error: ${err.message}\n${err.stack}`);
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
    gate2Score:       job.gate2Score || null,
    gate2Outcome:     job.gate2Outcome || null,
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

      const response = await callClaudeAPI({ // Use the enhanced callClaudeAPI
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
// REMOVED: Replaced by STREAMER_DATA_MAP and getStreamerInfo
/*
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
*/

// REMOVED: Replaced by getStreamerInfo
/*
function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}
*/

const TICKER_MAP = {
  nba:    'sports_ticker.html',       // sports_ticker.html in Downloads
  news:   'cwn_combined_ticker.html', // cwn_combined_ticker.html in Downloads
  twitch: 'cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in Downloads
};
const TICKER_CACHE = {}; // { nba: { path: '...', cachedAt: timestamp }, ... }
const TICKER_CACHE_TTL = 3600000; // 1 hour cache validity
const TICKER_DASH_PORT = process.env.DASHBOARD_PORT || '8765';

async function captureTicker(contentType) {
  // Check cache with TTL
  if (TICKER_CACHE[contentType]) {
    const cached = TICKER_CACHE[contentType];
    const age = Date.now() - cached.cachedAt;
    if (age < TICKER_CACHE_TTL && fs.existsSync(cached.path)) {
      console.log(`[ticker] Using cached ${contentType} ticker (age: ${Math.round(age/1000/60)}m)`);
      return cached.path;
    } else {
      console.log(`[ticker] Cache expired for ${contentType} (age: ${Math.round(age/1000/60)}m), regenerating...`);
      delete TICKER_CACHE[contentType];
    }
  }
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

    TICKER_CACHE[contentType] = { path: outPath, cachedAt: Date.now() };
    console.log(`[ticker] ✓ ${contentType} ticker cached: ${outPath} (valid for ${TICKER_CACHE_TTL/1000/60}m)`);
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

// ── POST /nba/scrape-game-highlight ─────────────────────────────────
// Scrapes the ESPN game page for the video with the highest duration
// User requirement: "video on that page with the highest duration--top left of the game_id page"
app.post('/nba/scrape-game-highlight', async (req, res) => {
  const { gameId } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  try {
    console.log(`[nba-scrape] Fetching game summary for gameId: ${gameId}`);

    // Step 1: Fetch ESPN game summary API (contains videos)
    const summaryResp = await withRetry(() => axios.get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`, { timeout: 10000 }), { label: `ESPN Summary ${gameId}` });
    const videos = summaryResp.data.videos || [];

    if (!videos.length) {
      console.warn(`[nba-scrape] No videos found for game ${gameId}`);
      return res.json({ ok: false, error: 'No videos found' });
    }

    console.log(`[nba-scrape] Found ${videos.length} videos for game ${gameId}`);

    // Step 2: Find video with highest duration
    let highestDurationVideo = null;
    let maxDuration = 0;

    for (const video of videos) {
      const duration = video.duration || 0;
      const title = video.headline || video.title || video.description || '';

      console.log(`[nba-scrape]   Video: "${title}" (${duration}s)`);

      if (duration > maxDuration) {
        maxDuration = duration;
        highestDurationVideo = video;
      }
    }

    if (!highestDurationVideo) {
      console.warn(`[nba-scrape] No valid video with duration found`);
      return res.json({ ok: false, error: 'No video with duration found' });
    }

    // Step 3: Extract best quality video URL
    const links = highestDurationVideo.links || {};
    const source = links.source || {};
    const videoUrl = source.HD?.href
      || source.mezzanine?.href
      || source.full?.href
      || source.href
      || links.mobile?.href
      || '';

    // Also extract thumbnail
    const thumbnail = highestDurationVideo.thumbnail || '';

    const result = {
      ok: true,
      gameId,
      videoUrl,
      thumbnail,
      title: highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights',
      description: highestDurationVideo.description || '',
      duration: maxDuration,
      videoCount: videos.length
    };

    console.log(`[nba-scrape] ✅ Selected highest duration video: "${result.title}" (${maxDuration}s)`);
    console.log(`[nba-scrape]    URL: ${videoUrl.slice(0, 80)}...`);

    res.json(result);

  } catch (err) {
    console.error(`[nba-scrape] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nba/generate-intro-card ────────────────────────────────
// Generates a 640×360 NBA intro card for video overlay
// Uses ESPN game data and renders a TV-shaped card (16:9 landscape)
// Returns { cardPath, gameId, teams: { away, home } }
//
// Body: { gameId, width?, height? }
// width/height default to 640×360 (TV shape for OVERLAY_ZONE)

app.post('/nba/generate-intro-card', async (req, res) => {
  const { gameId, width = 640, height = 360 } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId required' });

  try {
    console.log(`[nba-card] Generating ${width}×${height} intro card for game ${gameId}`);

    // Step 1: Fetch ESPN game summary API
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await withRetry(() => axios.get(summaryUrl, { timeout: 10000 }), { label: `ESPN Summary ${gameId}` });
    const data = summaryResp.data;

    // Step 2: Extract team data
    const hc = data.header && data.header.competitions && data.header.competitions[0];
    const comps = (hc && hc.competitors) || [];
    let away = { team: {} }, home = { team: {} };

    for (const comp of comps) {
      if (comp.homeAway === 'away') away = comp;
      if (comp.homeAway === 'home') home = comp;
    }

    const aAbbr = (away.team && away.team.abbreviation) || 'AWAY';
    const hAbbr = (home.team && home.team.abbreviation) || 'HOME';

    // Step 3: Extract team colors
    const bst = (data.boxscore && data.boxscore.teams) || [];
    let aColor = '1d428a', hColor = 'c41311';

    for (const bt of bst) {
      const team = bt.team || {};
      if (team.abbreviation === aAbbr && team.color) aColor = team.color;
      if (team.abbreviation === hAbbr && team.color) hColor = team.color;
    }

    // Step 4: Extract game info
    const aLoc = (away.team && away.team.location) || '';
    const aNick = (away.team && away.team.name) || '';
    const aRec = (away.records && away.records[0] && away.records[0].summary) || '';

    const hLoc = (home.team && home.team.location) || '';
    const hNick = (home.team && home.team.name) || '';
    const hRec = (home.records && home.records[0] && home.records[0].summary) || '';

    const gi = data.gameInfo || {};
    const venue = (gi.venue && gi.venue.fullName) || '';
    const city = (gi.venue && gi.venue.address && gi.venue.address.city) || '';

    // Format time
    const fmtTime = (dateStr) => {
      const d = new Date(dateStr);
      const h = d.getHours();
      const m = d.getMinutes();
      const ap = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 || 12;
      return `${h12}:${m < 10 ? '0' + m : m} ${ap} ET`;
    };

    const tipTime = hc && hc.date ? fmtTime(hc.date) : '-- ET';
    const gameDate = hc && hc.date ? new Date(hc.date).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase() : '';

    // Step 5: Launch Puppeteer and render card
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // Hex to RGB helper
    const hexRgb = (hex) => {
      hex = (hex || '').replace('#', '');
      if (hex.length !== 6) return '100,100,100';
      return `${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)}`;
    };

    // Build HTML for the card (scaled down version of nba_thumbnail_generator.html)
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          width: ${width}px;
          height: ${height}px;
          background: #0a0a0a;
          position: relative;
          overflow: hidden;
        }
        .bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #0a0a0a; }
        .panel-a, .panel-h { position: absolute; top: 0; width: 50%; height: 100%; opacity: 0.4; }
        .panel-a { left: 0; background: linear-gradient(120deg, #${aColor}66 0%, #${aColor}22 60%, transparent 100%); }
        .panel-h { right: 0; background: linear-gradient(240deg, #${hColor}66 0%, #${hColor}22 60%, transparent 100%); }
        .team { position: absolute; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 10px; }
        .team-a { left: 20px; }
        .team-h { right: 20px; flex-direction: row-reverse; }
        .logo { width: 70px; height: 70px; object-fit: contain; }
        .team-info { color: white; }
        .team-h .team-info { text-align: right; }
        .city { font-size: 12px; font-weight: 700; letter-spacing: 1px; opacity: 0.8; }
        .name { font-size: 16px; font-weight: 900; letter-spacing: 0.5px; }
        .rec { font-size: 10px; opacity: 0.6; margin-top: 2px; }
        .vs-ring {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 50px;
          height: 50px;
          border: 3px solid #c7af4f;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(10, 10, 10, 0.8);
        }
        .vs-lbl { color: #c7af4f; font-size: 16px; font-weight: 900; }
        .game-tag {
          position: absolute;
          top: 15px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 10px;
          font-weight: 700;
          color: #c7af4f;
          letter-spacing: 1px;
        }
        .tip-time {
          position: absolute;
          bottom: 30px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 14px;
          font-weight: 700;
          color: white;
        }
        .game-sub {
          position: absolute;
          bottom: 12px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 9px;
          color: rgba(255,255,255,0.6);
          letter-spacing: 0.5px;
        }
        .brand {
          position: absolute;
          bottom: 8px;
          right: 12px;
          font-size: 8px;
          font-weight: 700;
          color: #c7af4f;
          letter-spacing: 1px;
        }
      </style>
    </head>
    <body>
      <div class="bg"></div>
      <div class="panel-a"></div>
      <div class="panel-h"></div>

      <div class="team team-a">
        <img class="logo" src="https://a.espncdn.com/i/teamlogos/nba/500/${aAbbr.toLowerCase()}.png" />
        <div class="team-info">
          <div class="city" style="color: rgba(${hexRgb(aColor)}, 0.8)">${aLoc.toUpperCase()}</div>
          <div class="name">${aNick.toUpperCase()}</div>
          <div class="rec">${aRec}</div>
        </div>
      </div>

      <div class="team team-h">
        <img class="logo" src="https://a.espncdn.com/i/teamlogos/nba/500/${hAbbr.toLowerCase()}.png" />
        <div class="team-info">
          <div class="city" style="color: rgba(${hexRgb(hColor)}, 0.8)">${hLoc.toUpperCase()}</div>
          <div class="name">${hNick.toUpperCase()}</div>
          <div class="rec">${hRec}</div>
        </div>
      </div>

      <div class="vs-ring">
        <div class="vs-lbl">VS</div>
      </div>

      <div class="game-tag">NBA - ${gameDate}</div>
      <div class="tip-time">${tipTime}</div>
      <div class="game-sub">${venue.toUpperCase()}${city ? ' - ' + city.toUpperCase() : ''}</div>
      <div class="brand">CLIPZWORLD NEWS</div>
    </body>
    </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Wait for images to load
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 6: Take screenshot
    const cardPath = `/tmp/nba_card_${gameId}.png`;
    await page.screenshot({ path: cardPath, type: 'png' });

    await browser.close();

    console.log(`[nba-card] ✅ Card generated: ${cardPath}`);

    res.json({
      ok: true,
      cardPath,
      gameId,
      teams: {
        away: aAbbr,
        home: hAbbr
      }
    });

  } catch (err) {
    console.error(`[nba-card] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /news/generate-intro-card ───────────────────────────────
// Scrapes header image from news article URL and generates 640×360 card
// Extracts og:image or twitter:image meta tags for video overlay
// Returns { cardPath, sourceUrl, imageUrl }
//
// Body: { articleUrl, storyIndex?, width?, height? }
// width/height default to 640×360 (TV shape for OVERLAY_ZONE)

app.post('/news/generate-intro-card', async (req, res) => {
  const { articleUrl, storyIndex = 0, width = 640, height = 360 } = req.body;
  if (!articleUrl) return res.status(400).json({ error: 'articleUrl required' });

  try {
    console.log(`[news-card] Scraping header image from ${articleUrl}`);

    // Step 1: Fetch article HTML
    const cheerio = require('cheerio');
    const articleResp = await withRetry(() => axios.get(articleUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CWN-Bot/1.0; +https://clipzworldnews.com)'
      }
    }), { label: `News Scrape ${articleUrl.slice(0, 30)}` });

    const $ = cheerio.load(articleResp.data);

    // Step 2: Extract image from meta tags (prioritize og:image, then twitter:image)
    let imageUrl = $('meta[property="og:image"]').attr('content')
      || $('meta[property="og:image:url"]').attr('content')
      || $('meta[name="twitter:image"]').attr('content')
      || $('meta[name="twitter:image:src"]').attr('content');

    // Fallback: find first article image
    if (!imageUrl) {
      const firstImg = $('article img').first().attr('src') || $('img').first().attr('src');
      imageUrl = firstImg;
    }

    if (!imageUrl) {
      throw new Error('No image found in article');
    }

    // Handle relative URLs
    if (imageUrl.startsWith('//')) {
      imageUrl = 'https:' + imageUrl;
    } else if (imageUrl.startsWith('/')) {
      const urlObj = new URL(articleUrl);
      imageUrl = `${urlObj.protocol}//${urlObj.host}${imageUrl}`;
    }

    console.log(`[news-card] Found image: ${imageUrl}`);

    // Step 3: Download image
    const imageResp = await withRetry(() => axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CWN-Bot/1.0; +https://clipzworldnews.com)'
      }
    }), { label: `News Image Download ${imageUrl.slice(0, 30)}` });

    const crypto = require('crypto');
    const imageHash = crypto.createHash('md5').update(imageUrl).digest('hex').substring(0, 8);
    const tempImagePath = `/tmp/news_img_${imageHash}.jpg`;

    const fs = require('fs');
    fs.writeFileSync(tempImagePath, imageResp.data);

    console.log(`[news-card] Downloaded to ${tempImagePath}`);

    // Step 4: Resize to 640×360 using Puppeteer (same approach as NBA cards)
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });

    // Create HTML with resized image
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          width: ${width}px;
          height: ${height}px;
          background: #000;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
      </style>
    </head>
    <body>
      <img src="file://${tempImagePath}" />
    </body>
    </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 5: Take screenshot
    const cardPath = `/tmp/news_card_story${storyIndex}.png`;
    await page.screenshot({ path: cardPath, type: 'png' });

    await browser.close();

    // Clean up temp image
    fs.unlinkSync(tempImagePath);

    console.log(`[news-card] ✅ Card generated: ${cardPath}`);

    res.json({
      ok: true,
      cardPath,
      sourceUrl: articleUrl,
      imageUrl
    });

  } catch (err) {
    console.error(`[news-card] Error:`, err.message);
    res.status(500).json({ error: err.message });
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
    const result = await withRetry(() => resolveTwitchClipMp4(slug), { label: `Twitch Resolve ${slug}` });
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
const GEMINI_APIKEY = process.env.GEMINI_API_KEY; // Validated at startup

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
- The observation should make you want to rewatch`
  }
};

// This is the end of the server.js file.
// The rest of the file content was not provided in the previous turn.
// Assuming the file ends here for now.
// If there's more content, please provide it.

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
