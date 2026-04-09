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