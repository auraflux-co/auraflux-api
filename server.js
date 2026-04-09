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
        opacity: 0.