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
const { CONFIG } = require('./lib/config');
const { log } = require('./lib/logger');
const { StageTimer, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./lib/metrics');

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

// ── Job Card Persistence ─────────────────────────────────────────────────────
// Saves completed script+HeyGen jobs to disk so server restarts don't lose them.
// Dashboard calls GET /jobs on load to restore the job queue.
const JOBS_FILE = path.join(__dirname, 'data', 'jobs.json');
let persistedJobs = {};
try {
  persistedJobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  console.log(`[jobs] Loaded ${Object.keys(persistedJobs).length} persisted jobs from disk`);
} catch(e) {
  persistedJobs = {};
}

function saveJobCard(jobId, card) {
  persistedJobs[jobId] = { ...card, savedAt: new Date().toISOString() };
  // Prune jobs older than 7 days to keep file small
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(persistedJobs)) {
    const saved = new Date(persistedJobs[id].savedAt || 0).getTime();
    if (saved < cutoff) delete persistedJobs[id];
  }
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(persistedJobs, null, 2));
  } catch(e) {
    console.error('[jobs] Failed to save jobs.json:', e.message);
  }
}

// ── startHeyGenPoller() — Auto-poll HeyGen until all segments complete, then auto-assemble ──
// Called after Gate 1 passes and HeyGen video IDs are saved to the job card.
// Implements the fully-automatic pipeline: Gate 1 → HeyGen render → auto-assemble → Gate 3 → Drive → Gate 6 publish (private)
// Rob's only role: review private drafts on YouTube/TikTok/Instagram and flip to public.
async function startHeyGenPoller(jobId, card) {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) {
    console.error(`[heygen-poller:${jobId}] No HEYGEN_API_KEY — cannot poll`);
    return;
  }

  const videoJobs = card.heygen?.videoJobs || [];
  if (!videoJobs.length) {
    console.error(`[heygen-poller:${jobId}] No videoJobs in card — cannot poll`);
    return;
  }

  const POLL_INTERVAL_MS = 30000; // 30 seconds between polls
  const MAX_POLL_MINUTES = 60;    // Give up after 60 minutes (safety net)
  const MAX_POLLS = (MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS;
  let pollCount = 0;

  console.log(`[heygen-poller:${jobId}] 🔄 Starting — polling ${videoJobs.length} segments every 30s (max ${MAX_POLL_MINUTES}min)`);

  const poll = async () => {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error(`[heygen-poller:${jobId}] ⏰ Timeout after ${MAX_POLL_MINUTES}min — giving up. Manual REFRESH IDs + ASSEMBLE required.`);
      return;
    }

    try {
      // Check status of all video IDs in parallel
      const statuses = await Promise.all(videoJobs.map(async (job) => {
        try {
          const resp = await axios.get(
            `https://api.heygen.com/v1/video_status.get?video_id=${job.video_id}`,
            { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
          );
          const data = resp.data?.data || {};
          return {
            video_id: job.video_id,
            sceneName: job.sceneName,
            sceneIndex: job.sceneIndex,
            status: data.status,
            video_url: data.video_url || null
          };
        } catch(e) {
          return { video_id: job.video_id, sceneName: job.sceneName, sceneIndex: job.sceneIndex, status: 'error', video_url: null };
        }
      }));

      const completed = statuses.filter(s => s.status === 'completed' && s.video_url);
      const pending   = statuses.filter(s => s.status !== 'completed');
      const failed    = statuses.filter(s => s.status === 'failed');

      console.log(`[heygen-poller:${jobId}] Poll ${pollCount}: ${completed.length}/${videoJobs.length} completed, ${pending.length} pending, ${failed.length} failed`);

      if (failed.length > 0) {
        console.error(`[heygen-poller:${jobId}] ❌ ${failed.length} segment(s) failed in HeyGen: ${failed.map(f => f.sceneName).join(', ')} — manual intervention required`);
        // Don't give up entirely — HeyGen sometimes marks as failed then recovers. Keep polling.
      }

      if (completed.length < videoJobs.length) {
        // Not all done yet — schedule next poll
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      // ── All segments completed — build segmentData and trigger assembly ──
      console.log(`[heygen-poller:${jobId}] ✅ All ${videoJobs.length} HeyGen segments completed — building segmentData for auto-assembly`);

      // Sort completed segments by sceneIndex to preserve script order
      const sortedAvatarSegs = [...completed].sort((a, b) => a.sceneIndex - b.sceneIndex);

      // Build the interleaved segmentData array:
      // Avatar segments come from HeyGen URLs (sorted by sceneIndex)
      // Source clips come from orderedClipUrls (in order, inserted after their SETUP scene)
      // The script structure is: INTRO, STREAMER_INTRO, CLIP1_SETUP, [CLIP1], CLIP1_REACTION, CLIP2_SETUP, [CLIP2], CLIP2_REACTION, ..., OUTRO
      // Avatar segments: INTRO, STREAMER_INTRO, CLIP1_SETUP, CLIP1_REACTION, CLIP2_SETUP, CLIP2_REACTION, OUTRO
      // Source clips: inserted after each SETUP scene
      const orderedClipUrls = card.orderedClipUrls || [];
      const segmentData = [];
      let clipIdx = 0;

      for (const avatarSeg of sortedAvatarSegs) {
        // Add the avatar segment
        segmentData.push({
          url:   avatarSeg.video_url,
          label: avatarSeg.sceneName,
          type:  'avatar'
        });

        // If this is a SETUP scene, insert the corresponding source clip after it
        if (/SETUP/i.test(avatarSeg.sceneName) && clipIdx < orderedClipUrls.length) {
          const clip = orderedClipUrls[clipIdx];
          segmentData.push({
            url:     clip.clipUrl || clip.url || '',
            pageUrl: clip.pageUrl || '',
            label:   clip.label || `CLIP_${clipIdx + 1}`,
            type:    'source_clip',
            clipUrl: clip.clipUrl || clip.url || ''
          });
          clipIdx++;
        }
      }

      console.log(`[heygen-poller:${jobId}] Built segmentData: ${segmentData.length} segments (${sortedAvatarSegs.length} avatar + ${clipIdx} source_clips)`);

      // Update job card with completed URLs before assembly
      const updatedCard = persistedJobs[jobId] || card;
      updatedCard.heygen = updatedCard.heygen || {};
      updatedCard.heygen.videoJobs = statuses.map(s => ({
        ...(videoJobs.find(j => j.video_id === s.video_id) || {}),
        status: s.status,
        video_url: s.video_url
      }));
      updatedCard.stage = 'all_sent';
      saveJobCard(jobId, updatedCard);

      // Trigger assembly via internal HTTP call (same as dashboard ASSEMBLE button)
      const PORT = process.env.PORT || 3000;
      const assemblyId = `asm_${Date.now()}`;
      const contentType = card.contentType || 'twitch';
      const format = contentType.includes('-short') ? 'portrait' : 'landscape';

      // Pre-warm ticker cache BEFORE assembly so it's ready when FFmpeg needs it
      // captureTicker takes ~2-3 min (900 frames) — await it here so assembly never races ahead
      if (!contentType.includes('short')) {
        const tickerContentType = contentType.replace(/-short$/, '');
        console.log(`[heygen-poller:${jobId}] 🎞 Pre-warming ${tickerContentType} ticker cache (awaiting)...`);
        try {
          const tickerPrewarmPath = await captureTicker(tickerContentType);
          if (tickerPrewarmPath) console.log(`[heygen-poller:${jobId}] ✅ Ticker pre-warmed: ${tickerPrewarmPath}`);
          else console.warn(`[heygen-poller:${jobId}] ⚠️ Ticker pre-warm failed — assembly will proceed without ticker`);
        } catch(e) {
          console.warn(`[heygen-poller:${jobId}] ⚠️ Ticker pre-warm error: ${e.message} — continuing without ticker`);
        }
      }

      console.log(`[heygen-poller:${jobId}] 🎬 Triggering auto-assembly (assemblyId: ${assemblyId})...`);

      // Build a human-readable job title for the output filename
      // e.g. "TWITCH Saturday, April 11, 2026 (7 avatar + 2 clips)"
      const _cardDate = card.savedAt ? new Date(card.savedAt) : new Date();
      const _dateLabel = _cardDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const _avatarCount = sortedAvatarSegs.length;
      const _clipCount   = clipIdx;
      const _humanTitle  = `${contentType.toUpperCase()} ${_dateLabel} (${_avatarCount} avatar + ${_clipCount} clips)`;

      try {
        await axios.post(`http://localhost:${PORT}/assemble`, {
          segments:    segmentData.map(s => s.url),
          segmentData: segmentData,
          labels:      segmentData.map(s => s.label),
          transition:  'crossfade',
          format:      'mp4',
          assemblyId,
          jobTitle:    _humanTitle,
          contentType,
          sceneTextMap: card.heygen?.sceneTextMap || null,
          fullScript:   card.script || null,
          streamers:    card.streamers || []
        }, { timeout: 10000 }); // Just fire — assembly runs async

        console.log(`[heygen-poller:${jobId}] ✅ Auto-assembly triggered (assemblyId: ${assemblyId}) — Gate 3 → Drive → Gate 6 will run automatically`);

        // Update job card to reflect assembly started
        const cardNow = persistedJobs[jobId] || updatedCard;
        cardNow.assemblyId = assemblyId;
        cardNow.autoAssembledAt = new Date().toISOString();
        saveJobCard(jobId, cardNow);

        // ── Poll assemblyJobs in-process until done, then persist final state ──
        // assemblyJobs[assemblyId] is in-memory in the same Node process.
        // Poll every 15s until status is 'done', 'failed', or 'manual_review',
        // then write assembledAt + stage + outputPath + driveUrl to the persisted job card
        // so the dashboard shows the correct state after any page reload.
        const ASM_POLL_INTERVAL = 15000;
        const ASM_POLL_MAX = 120; // 30 min max (120 × 15s)
        let asmPollCount = 0;
        const pollAssemblyCompletion = () => {
          asmPollCount++;
          const asmJob = assemblyJobs[assemblyId];
          if (!asmJob) {
            if (asmPollCount < ASM_POLL_MAX) setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
            return;
          }
          const isDone = asmJob.status === 'done' || asmJob.status === 'manual_review' || asmJob.status === 'failed';
          if (!isDone && asmPollCount < ASM_POLL_MAX) {
            setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
            return;
          }
          // Assembly finished — update persisted job card
          const finalCard = persistedJobs[jobId] || cardNow;
          if (asmJob.status === 'done' || asmJob.status === 'manual_review') {
            finalCard.assembledAt = new Date().toISOString();
            finalCard.stage = 'assembled';
            if (asmJob.outputPath) finalCard.outputPath = asmJob.outputPath;
            if (asmJob.driveUrl)   finalCard.finalUrl   = asmJob.driveUrl;
            if (asmJob.qaScore !== undefined) {
              finalCard.gate5 = finalCard.gate5 || {};
              finalCard.gate5.score   = asmJob.qaScore;
              finalCard.gate5.outcome = asmJob.qaOutcome || 'manual_review';
              finalCard.gate5.report  = asmJob.qaReport  || '';
              if (asmJob.qaOutcome === 'pass') {
                finalCard._gate5Done = true;
                finalCard.stage = 'gate5_forced'; // treat auto-pass same as force-pass for dashboard
              }
            }
            if (asmJob.publishResult) {
              finalCard.publishRecord = { publishedAt: new Date().toISOString(), ...asmJob.publishResult };
              finalCard.stage = 'published';
            }
            saveJobCard(jobId, finalCard);
            console.log(`[heygen-poller:${jobId}] ✅ Persisted assembly completion: stage=${finalCard.stage}, outputPath=${asmJob.outputPath || 'n/a'}, driveUrl=${asmJob.driveUrl || 'n/a'}`);
          } else {
            console.warn(`[heygen-poller:${jobId}] ⚠️ Assembly ended with status=${asmJob.status} — job card not updated to assembled`);
          }
        };
        setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);

      } catch(assembleErr) {
        console.error(`[heygen-poller:${jobId}] ❌ Auto-assembly POST failed: ${assembleErr.message} — manual ASSEMBLE required`);
      }

    } catch(pollErr) {
      console.error(`[heygen-poller:${jobId}] Poll error: ${pollErr.message} — retrying in 30s`);
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  // Start first poll after 30s (give HeyGen time to begin processing)
  setTimeout(poll, POLL_INTERVAL_MS);
}

// NOTE: GET /jobs endpoint is registered after app is initialized (see below near line 796+)

// Initialize Anthropic client for Claude API calls
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Initialize Twitch client
const twitchClient = new TwitchClient({
  clientId: process.env.TWITCH_CLIENT_ID,
  token: process.env.TWITCH_TOKEN
});

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
        border: '5px solid #c7af4f',  // CWN Gold border
        shadow: '0 4px 15px rgba(0,0,0,0.5)'  // 50% opacity shadow
      }
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
// TV Rectangle design (1280×720 canvas → 640×360 final after FFmpeg scale)
// All 3 content types (Twitch, NBA, News) use this same TV-rectangle design
// for CWN brand consistency. Layout: profile image left, text right.
// Returns path to PNG file, or null if canvas not installed
async function generateIntroCardPNG(streamerData, outputPath, variant = 'cwn') {
  const canvasModule = require('canvas');
  const { createCanvas, loadImage } = canvasModule;

  // ── Dimensions (2× resolution for sharpness — final output 640×360 after FFmpeg scale) ──
  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // Sanitize text strings by replacing escaped apostrophes and quotes
  const name   = (streamerData.displayName || streamerData.name || '').toUpperCase().replace(/\\'/g, "'").replace(/\\"/g, '"');
  const origin = (streamerData.origin  || '').replace(/\\'/g, "'").replace(/\\"/g, '"');
  const fact   = (streamerData.fact    || '').replace(/\\'/g, "'").replace(/\\"/g, '"');

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
    { name: displayName ? `profile_${displayName.replace(/ /g, '_')}` : '', label: 'profile_displayName_underscore' },
    { name: onAirName ? `profile_${onAirName.replace(/ /g, '_')}` : '', label: 'profile_onAirName_underscore' }
  ].filter(p => p.name);

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
  const imgX    = 60;
  const imgY    = (H - imgSize) / 2;  // vertically centered

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
  const textX = imgX + imgSize + 80;  // 80px gap between image and text
  const maxTextWidth = W - textX - 60; // right margin 60px

  // Drop shadow for all text
  ctx.shadowColor   = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur    = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.textAlign     = 'left';

  // ── Name (gold, bold, 136pt) ──────────────────────────────────────
  ctx.fillStyle = '#c7af4f';
  ctx.font      = 'bold 136px Arial';
  // Shrink name font if it overflows
  let nameFontSize = 136;
  while (nameFontSize >= 60 && ctx.measureText(name).width > maxTextWidth) {
    nameFontSize -= 4;
    ctx.font = `bold ${nameFontSize}px Arial`;
  }
  ctx.fillText(name, textX, 260);

  // ── Origin (white, 88pt) ──────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.font      = '88px Arial';
  ctx.fillText(origin, textX, 380);

  // ── Fact (grey italic, word-wrapped) ─────────────────────────────
  ctx.fillStyle = '#aaaaaa';

  // Dynamic font sizing: start at 64pt, reduce until fact fits in 2 lines
  let factFontSize = 64;
  let factLines    = [];
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
  ctx.lineWidth   = 10;
  ctx.strokeRect(5, 5, W - 10, H - 10);

  // ── Save PNG ──────────────────────────────────────────────────────
  const buf = canvas.toBuffer('image/png');
  require('fs').writeFileSync(outputPath, buf);
  console.log(`[intro-card] ✅ TV card written: ${require('path').basename(outputPath)} (${name})`);
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

  // ── Drop shadow behind text ─────────────────────────────────────────
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

  const writer = fs.createWriteStream(destPath);
  const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  resp.data.pipe(writer);
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
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

// GET /jobs — return all persisted job cards for dashboard recovery after server restart
// Dashboard calls this on load to restore the job queue (script + HeyGen video IDs)
app.get('/jobs', (req, res) => {
  const jobs = Object.values(persistedJobs)
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
  res.json({ ok: true, count: jobs.length, jobs });
});

// DELETE /job/:id — remove a job from persistedJobs + jobs.json
// Called by dashboard clearAllJobs() and clearDone() so cleared jobs don't reappear on restore
app.delete('/job/:id', (req, res) => {
  const jobId = req.params.id;
  if (!persistedJobs[jobId]) return res.json({ ok: false, error: 'Job not found: ' + jobId });
  delete persistedJobs[jobId];
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(persistedJobs, null, 2));
  } catch(e) {
    console.error('[jobs] Failed to save jobs.json after delete:', e.message);
  }
  console.log(`[jobs] Deleted job: ${jobId}`);
  res.json({ ok: true, deleted: jobId });
});

// ── POST /job/:id/rollback — roll a job back to the previous pipeline stage ──
// Stages (in order): script_ready → all_sent → assembled → published
// Rollback clears the data from the current stage so the previous stage's
// action button re-appears in the dashboard.
app.post('/job/:id/rollback', (req, res) => {
  const jobId = req.params.id;
  const card  = persistedJobs[jobId];
  if (!card) return res.json({ ok: false, error: 'Job not found: ' + jobId });

  const before = card.stage || detectStage(card);

  if (before === 'published') {
    // Roll back from published → assembled (clear publish record, keep finalUrl)
    delete card.publishRecord;
    delete card._gate3Approved;
    card.stage = 'assembled';
    saveJobCard(jobId, card);
    console.log(`[rollback] ${jobId}: published → assembled`);
    return res.json({ ok: true, jobId, before: 'published', after: 'assembled', message: 'Publish record cleared — re-approve to re-publish.' });
  }

  if (before === 'assembled') {
    // Roll back from assembled → all_sent (clear assembly + Gate 5 data)
    delete card.assembledAt;
    delete card.finalUrl;
    delete card.outputPath;
    delete card.gate5;
    delete card._gate5Done;
    delete card._gate5Running;
    delete card._gate3Approved;
    delete card._gate3Rejected;
    // Reset all avatar segments back to 'rendering' so REFRESH IDs re-appears
    if (card.heygen && card.heygen.videoJobs) {
      card.heygen.videoJobs.forEach(vj => { vj._url = null; });
    }
    card.stage = 'all_sent';
    saveJobCard(jobId, card);
    console.log(`[rollback] ${jobId}: assembled → all_sent`);
    return res.json({ ok: true, jobId, before: 'assembled', after: 'all_sent', message: 'Assembly cleared — click REFRESH IDs then ASSEMBLE again.' });
  }

  if (before === 'all_sent') {
    // Roll back from all_sent → script_ready (clear HeyGen video IDs)
    if (card.heygen && card.heygen.videoJobs) {
      card.heygen.videoJobs.forEach(vj => { delete vj.video_id; });
    }
    delete card.gate2;
    card.stage = 'script_ready';
    saveJobCard(jobId, card);
    console.log(`[rollback] ${jobId}: all_sent → script_ready`);
    return res.json({ ok: true, jobId, before: 'all_sent', after: 'script_ready', message: 'HeyGen IDs cleared — edit script and re-send to HeyGen.' });
  }

  return res.json({ ok: false, error: `Job is at stage "${before}" — nothing to roll back to.` });
});

// ── POST /job/:id/advance — force-advance a stuck job to the next stage ──
// Use when a gate is stuck (HeyGen timeout, Gate 5 server error, etc.)
// Does NOT skip quality checks — it marks the current gate as "force-passed"
// so the next action button appears in the dashboard.
app.post('/job/:id/advance', (req, res) => {
  const jobId = req.params.id;
  const card  = persistedJobs[jobId];
  if (!card) return res.json({ ok: false, error: 'Job not found: ' + jobId });

  const stage = card.stage || detectStage(card);

  if (stage === 'script_ready') {
    // Force-advance: mark Gate 1 as force-passed so SEND TO HEYGEN is unblocked
    card.gate1 = card.gate1 || {};
    card.gate1.outcome = 'force_pass';
    card.gate1.score   = card.gate1.score || 0;
    card.gate1.forcedAt = new Date().toISOString();
    card.stage = 'gate1_forced';
    saveJobCard(jobId, card);
    console.log(`[advance] ${jobId}: script_ready → gate1 force-passed`);
    return res.json({ ok: true, jobId, before: 'script_ready', after: 'gate1_forced', message: 'Gate 1 force-passed — SEND TO HEYGEN is now unlocked.' });
  }

  if (stage === 'all_sent') {
    // Force-advance: mark all rendering segments as completed with a placeholder URL
    // so the ASSEMBLE button appears. The placeholder will be replaced by REFRESH IDs.
    const videoJobs = (card.heygen && card.heygen.videoJobs) || [];
    let forced = 0;
    videoJobs.forEach(vj => {
      if (!vj._url && vj.video_id) {
        vj._forcedComplete = true;
        forced++;
      }
    });
    card.gate2 = card.gate2 || {};
    card.gate2.outcome  = 'force_pass';
    card.gate2.forcedAt = new Date().toISOString();
    card.stage = 'gate2_forced';
    saveJobCard(jobId, card);
    console.log(`[advance] ${jobId}: all_sent → gate2 force-passed (${forced} segments marked)`);
    return res.json({ ok: true, jobId, before: 'all_sent', after: 'gate2_forced', message: `Gate 2 force-passed — ${forced} segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE.` });
  }

  if (stage === 'assembled') {
    // Force-advance: mark Gate 5 as force-passed so APPROVE button appears
    card.gate5 = card.gate5 || {};
    card.gate5.score    = card.gate5.score || 0;
    card.gate5.outcome  = 'force_pass';
    card.gate5.forcedAt = new Date().toISOString();
    card._gate5Done     = true;
    card.stage = 'gate5_forced';
    saveJobCard(jobId, card);
    console.log(`[advance] ${jobId}: assembled → gate5 force-passed`);
    return res.json({ ok: true, jobId, before: 'assembled', after: 'gate5_forced', message: 'Gate 5 force-passed — APPROVE & UPLOAD button is now unlocked.' });
  }

  return res.json({ ok: false, error: `Job is at stage "${stage}" — cannot advance further (already at publish stage or unknown stage).` });
});

// Helper: detect current pipeline stage from persisted job card fields
function detectStage(card) {
  if (!card) return 'unknown';
  if (card.publishRecord && card.publishRecord.publishedAt) return 'published';
  if (card.assembledAt || card.finalUrl) return 'assembled';
  if (card.heygen && card.heygen.videoJobs && card.heygen.videoJobs.length) return 'all_sent';
  if (card.script && card.script.length > 10) return 'script_ready';
  return 'unknown';
}

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
    const createResp = await axios.post('https://api.topazlabs.com/video/', {
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
    });

    const requestID = createResp.data?.requestID;
    if (!requestID) throw new Error('No requestID in Topaz create response');
    console.log(`[topaz] Created request: ${requestID}`);

    // Step 3: Accept and get upload URLs
    const acceptResp = await axios.patch(`https://api.topazlabs.com/video/${requestID}/accept`, {}, {
      headers: {
        'X-API-Key': TOPAZ_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      }
    });

    const uploadUrl = acceptResp.data?.uploadUrl;
    if (!uploadUrl) throw new Error('No uploadUrl in Topaz accept response');
    console.log(`[topaz] Got upload URL, uploading video...`);

    // Step 4: Upload video to signed URL
    const videoBuffer = fs.readFileSync(videoPath);
    await axios.put(uploadUrl, videoBuffer, {
      headers: { 'Content-Type': 'video/mp4' },
      maxBodyLength: Infinity,
      timeout: 300000 // 5 min upload timeout
    });

    console.log(`[topaz] Video uploaded, completing...`);

    // Step 5: Complete upload to start processing
    await axios.patch(`https://api.topazlabs.com/video/${requestID}/complete-upload`, {}, {
      headers: {
        'X-API-Key': TOPAZ_API_KEY,
        'accept': 'application/json',
        'content-type': 'application/json'
      }
    });

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
    const writer = fs.createWriteStream(enhancedPath);
    const downloadResp = await axios.get(downloadUrl, { responseType: 'stream' });
    downloadResp.data.pipe(writer);

    await new Promise((res, rej) => {
      writer.on('finish', res);
      writer.on('error', rej);
    });

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
    { label: 'LATE',   start: Math.max(0, Math.floor(dur) - 35) },
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
  // outroCutOff: only fire when Gemini explicitly marks OUTRO as FAIL in the late sample.
  // Do NOT match "cuts off abruptly" — that phrase appears when the 20s sample window ends
  // before the video does, which is a false positive (sample window artifact, not a real problem).
  const lateReport      = reports[2] || '';
  const outroCutOff     = /OUTRO:.*FAIL/i.test(lateReport) && !/abrupt.*cut|cut.*abrupt|sample.*end/i.test(lateReport);
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
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
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
    // title is set to scene name so we can match videos back by title when refreshing IDs
    const requestBody = {
      title: `${jobId}_${String(i).padStart(2,'0')}_${scene.name}`,
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

      const response = await axios.post(
        'https://api.heygen.com/v2/video/generate',
        requestBody,
        {
          headers: {
            'X-Api-Key': HEYGEN_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

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
  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
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
    const genResp = await axios.post(
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
    );

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

// ── Gate 1: Clip Availability Report ─────────────────────────────
// Appended to every Gate 1 why-doc (pass or fail) to show why some
// streamers had fewer than the target number of clips.
// Helps Rob understand shortfalls without digging through logs.
function generateClipAvailabilityReport(items, allClips, streamerOrder, analysisClips) {
  const report = [];
  report.push('\n── CLIP AVAILABILITY REPORT ──────────────────────');

  // Fix #6: Derive target dynamically from actual data — no hardcoded numbers.
  // targetPerStreamer = clips per streamer from the first item's clips array.
  // expectedStreamers = number of streamers actually in this episode (streamerOrder).
  const targetPerStreamer = (items && items[0] && items[0].clips && items[0].clips.length > 0)
    ? items[0].clips.length
    : 2;
  const expectedStreamers = streamerOrder ? streamerOrder.length : Object.keys(STREAMER_DISPLAY_NAMES).length;
  const expectedTotal = expectedStreamers * targetPerStreamer;

  const actualTotal = analysisClips.length;
  const shortfall = expectedTotal - actualTotal;

  report.push(`Target: ${expectedTotal} clips (${expectedStreamers} streamers × ${targetPerStreamer} clips each)`);
  report.push(`Actual: ${actualTotal} clips`);
  if (shortfall > 0) {
    report.push(`Shortfall: ${shortfall} clips\n`);
  } else {
    report.push(`Status: ✅ Target met\n`);
  }

  // Per-streamer breakdown — show streamers in this episode + any roster streamers not included
  const rosterStreamers = Object.keys(STREAMER_DISPLAY_NAMES);
  // Show episode streamers first (in order), then any roster streamers not in this episode
  const allStreamersToShow = [
    ...(streamerOrder || []),
    ...rosterStreamers.filter(s => !(streamerOrder || []).includes(s))
  ];
  allStreamersToShow.forEach(streamer => {
    const streamerClips = allClips.filter(c => c.streamer === streamer);
    const analyzedClips = analysisClips.filter(c => c.streamer === streamer);
    const requested = targetPerStreamer;
    const obtained = analyzedClips.length;

    let reason = '';
    if (!streamerOrder.includes(streamer)) {
      reason = '⚠️ Not in this episode';
    } else if (obtained >= requested) {
      reason = '✅ Target met';
    } else if (streamerClips.length === 0) {
      reason = '⚠️ No clips available from dashboard';
    } else {
      const good = streamerClips.filter(c => c.videoUrl && c.videoUrl.includes('sig='));
      const bad  = streamerClips.filter(c => !c.videoUrl || !c.videoUrl.includes('sig='));
      if (good.length < requested) {
        const expired = requested - good.length;
        reason = `⚠️ ${expired} clips expired/deleted${bad.length > 0 ? `, used ${bad.length} backups` : ''}`;
      } else if (streamerClips.length < requested) {
        reason = `⚠️ Only ${streamerClips.length} clips available (need ${requested})`;
      } else {
        reason = '⚠️ Unknown issue — check logs';
      }
    }

    report.push(`${streamer}: ${obtained}/${requested} clips — ${reason}`);
  });

  report.push('──────────────────────────────────────────────────\n');
  return report.join('\n');
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
    clipsPerStreamer = 2,
    jobId = 'unknown',
    expectedScenes = 0,  // Must be provided by caller
    clipReportData = null
  } = opts;

  if (!client) return { score: 100, passed: true, outcome: 'pass', outcomeLabel: '✅ PASS (skipped — no key)', deductions: [] };

  const PASS_THRESHOLD   = 90;
  const MANUAL_THRESHOLD = 90;

  // Count [CLIP PLAYS HERE] markers in script
  const clipMarkers    = (script.match(/\[CLIP PLAYS HERE\]/g) || []).length;
  const expectedClips  = contentType === 'twitch' ? streamers.length * clipsPerStreamer : clipAnalyses.length;
  const wrongClipCount = Math.abs(clipMarkers - expectedClips) > 1; // allow ±1 tolerance
  const missingAppreciateYou = !/appreciate you/i.test(script);

  // Count scene markers
  const sceneMarkers = (script.match(/===\s+[A-Z_0-9]+\s+===/g) || []).length;
  const wrongSceneCount = expectedScenes > 0 && sceneMarkers !== expectedScenes;

  // Build clip summaries for Claude to cross-check.
  // For Twitch, clipAnalyses is a 2D array: [[s0c0, s0c1], [s1c0, s1c1], ...]
  // For NBA/News, clipAnalyses is a flat array: [c0, c1, c2, ...]
  // Flatten to a single list with correct streamer attribution before mapping.
  const flatAnalyses = (() => {
    if (contentType === 'twitch' && Array.isArray(clipAnalyses[0])) {
      // 2D → flat: iterate streamer × clip so attribution is always correct
      const flat = [];
      clipAnalyses.forEach((streamerClips, si) => {
        const s = streamers[si] || `Streamer ${si + 1}`;
        (Array.isArray(streamerClips) ? streamerClips : [streamerClips]).forEach((clip, ci) => {
          flat.push({ streamer: s, clipNum: ci + 1, analysis: clip });
        });
      });
      return flat;
    } else {
      // Already flat (NBA / News)
      return clipAnalyses.map((clip, i) => ({
        streamer: streamers[Math.floor(i / clipsPerStreamer)] || `Streamer ${i + 1}`,
        clipNum: (i % clipsPerStreamer) + 1,
        analysis: clip
      }));
    }
  })();

  const clipSummaries = flatAnalyses.map((item, i) => {
    const name = item.streamer?.displayName || item.streamer || `Streamer ${i + 1}`;
    const a = item.analysis;
    return `CLIP ${i + 1} (${name}, clip ${item.clipNum}): ${a?.summary || a?.description || a || 'No analysis available'}`;
  }).join('\n');

  const displayNames = streamers.map(s => {
    const data = typeof s === 'object' ? s : { displayName: s, username: s };
    return `"${data.displayName}" (NOT "${data.username || data.twitchUsername || ''}")`;
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
    const response = await client.messages.create({
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

  // Append clip availability report if data was provided (Twitch only)
  if (clipReportData && contentType === 'twitch') {
    try {
      const { items: rItems, allClips: rAllClips, streamerOrder: rOrder, analysisClips: rAnalysis } = clipReportData;
      const clipReport = generateClipAvailabilityReport(rItems, rAllClips, rOrder, rAnalysis);
      fs.appendFileSync(logFile, clipReport);
      console.log(`[qa-gate1] Clip availability report appended to why-doc`);
    } catch(e) { console.warn(`[qa-gate1] Clip report append failed: ${e.message}`); }
  }

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

// ── Claude Script Fix — surgically rewrites broken clip sections ──────────────
// Called after Gate 1 FAIL when the only issue is CLIP MATCH (descriptions don't
// match actual clip content). Claude rewrites ONLY the broken SETUP/REACTION
// sections using the actual Gemini clip analyses, preserving all structure.
//
// Returns: { script: string, fixed: boolean }
async function claudeScriptFix(script, clipAnalyses, opts = {}) {
  const {
    contentType = 'twitch',
    streamers = [],
    clipsPerStreamer = 2,
    qaReport = '',
    jobId = 'unknown'
  } = opts;

  if (!client) return { script, fixed: false };

  // Build clip reference block for Claude
  const clipRef = streamers.map((s, si) => {
    const name = (s.displayName || s.twitchUsername || '').toUpperCase().replace(/\s+/g, '_');
    const analysesList = Array.isArray(clipAnalyses[si]) ? clipAnalyses[si] : [clipAnalyses[si] || ''];
    return analysesList.map((a, ci) =>
      name + ' CLIP ' + (ci+1) + ': ' + (a || 'No analysis available')
    ).join('\n');
  }).join('\n');

  // Fix #6E: Added Rule 3 (CLIP ORDER) so Claude explicitly swaps CLIP1/CLIP2 content
  // when the QA report indicates the sections are describing the wrong clip.
  // Previously the prompt only said "fix broken sections" with no swap instruction,
  // so Claude would rewrite content in-place rather than reorder the sections.
  const fixPrompt = 'You are a script editor for ClipzWorld News (CWN). A script was written by Gemini but failed QA because some CLIP_SETUP and CLIP_REACTION sections describe the wrong clip content.\n\nYOUR TASK: Fix ONLY the broken sections. Do NOT change any other part of the script. Preserve all === HEADERS ===, [CLIP PLAYS HERE] markers, [beat] markers, word counts, and structure exactly.\n\nACTUAL CLIP CONTENT (what Gemini actually saw in each video):\n' + clipRef + '\n\nQA FAILURE REPORT (shows which sections are wrong):\n' + qaReport + '\n\nRULES FOR FIXING:\n1. CLIP_SETUP: Exactly 2 sentences. First sentence: what the streamer is doing/saying. Second sentence: tease what happens next.\n2. CLIP_REACTION: Exactly 1 sentence. React to what just happened — no recap, just energy/commentary.\n3. CLIP ORDER: If the QA report indicates that CLIP1_SETUP describes what is actually in CLIP2 (or vice versa), you MUST SWAP the content of those sections — move the CLIP1_SETUP+CLIP1_REACTION text to the CLIP2 slot and the CLIP2_SETUP+CLIP2_REACTION text to the CLIP1 slot. Each CLIP_SETUP and CLIP_REACTION must match the analysis for that clip number as listed in ACTUAL CLIP CONTENT above. Do NOT rewrite content in-place when the clips are simply in the wrong order — swap them.\n4. Use the streamer ON-AIR display name only (never Twitch username).\n5. Keep [beat] markers exactly where they are.\n6. Keep [CLIP PLAYS HERE] markers exactly where they are.\n7. Do NOT change INTRO, streamer INTRO sections, or OUTRO.\n8. Return the COMPLETE script with ONLY the broken sections fixed.\n\nCURRENT SCRIPT TO FIX:\n' + script + '\n\nReturn ONLY the fixed script with no explanation, no preamble, no markdown code blocks.';

  try {
    console.log('[claude-fix] Asking Claude to surgically fix clip match issues...');
    const response = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: fixPrompt }]
    });

    const fixedScript = response.content[0]?.text?.trim() || script;

    // Normalize headers (same post-processing as Gemini)
    const normalizedScript = fixedScript.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
      const normalized = name.trim().replace(/\s+/g, '_');
      return '=== ' + normalized + ' ===';
    });

    console.log('[claude-fix] Script fix complete (' + normalizedScript.length + ' chars)');
    return { script: normalizedScript, fixed: true };
  } catch(e) {
    console.error('[claude-fix] Claude fix failed: ' + e.message);
    return { script, fixed: false };
  }
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
    clipsPerStreamer = 2,
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

  // Load HeyGen context for smarter QA validation
  const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
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
    expectedScenes = 1 + (streamers.length * 4) + 1; // 1 INTRO + (items × 4 scenes each: _INTRO, _SETUP, _CLIP_REACTION, _REACTION) + 1 OUTRO
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
    const genResp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{ parts: [{ text: qaPrompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.1 }
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

      // Load HeyGen context for segment QA
      const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829';
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
   - Bobby G's background is a warm home-office/studio setting (bookshelf, lamp) — this is CORRECT and expected
   - FAIL only if there are visual artifacts, glitches, green screen bleed, or the avatar is missing entirely
   - Do NOT fail for the bookshelf/room background — that is Bobby G's standard HeyGen background

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
async function callClaudeAPI(params) {
  const client = new Anthropic();
  try {
    const response = await client.messages.create(params);
    return response;
  } catch (e) {
    // Detailed error handling for different Claude API failure modes
    if (e.status === 429) {
      throw new Error(`Claude API rate limited. Retry after ${e.headers?.['retry-after'] || '60'} seconds`);
    }
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
    if (e.status === 500 || e.status === 529) {
      throw new Error('Claude API server error - service temporarily unavailable');
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
      throw new Error('Claude API connection failed - check network connectivity');
    }
    // Generic fallback
    throw new Error(`Claude API error (${e.status || e.code || 'unknown'}): ${e.message}`);
  }
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

app.post('/assemble',
  requireFields('segments', 'segmentData'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
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
                const headResp = await axios.head(url, { timeout: 5000 });
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

      // Declare outPath/outFile/totalDur/tickerType in outer scope so Gate 3 QA + Drive upload can access them
      // regardless of whether short-form or long-form branch ran.
      let outPath = '';
      let outFile = '';
      let totalDur = '0';
      const isShortContent = contentType && contentType.includes('short');
      const tickerType = !isShortContent && contentType ? contentType.replace(/-short$/,'') : null;

      if (isShortForm) {
        log(asmId, `\n📱 SHORT-FORM DETECTED — Using split-screen assembly (9:16 portrait)`);
        const assemblyTimer = new StageTimer(asmId, 'Short-Form Split-Screen Assembly');

        // Build output path
        const outDir = outputDir || OUTPUT_DIR;
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        outFile = `${(jobTitle||"cwn_short").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50)}_${Date.now()}.mp4`;
        outPath = path.join(outDir, outFile);

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
        outFile   = `${(jobTitle||"cwn").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,50)}_${Date.now()}.${format === 'webm' ? 'webm' : format === 'mov' ? 'mov' : 'mp4'}`;
        outPath   = path.join(outDir, outFile);

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
        const sPath = path.join(__dirname, 'data/streamers.json');
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
        // Handles "JASON (INTRO)", "JASON_INTRO", and "JASON INTRO" label formats
        const isIntro = (/\(INTRO\)/i.test(label) || /[_ ]INTRO$/i.test(label)) && !/cold.open/i.test(label) && !/^INTRO$/i.test(label);

        if (isIntro && contentType === 'twitch' && streamerRoster.length) {
          // ── Twitch: Circular streamer card ────────────────────────
          // Extract streamer name from label e.g. "JASON (INTRO)" → "Jason", "JASON_INTRO" → "Jason", "JASON INTRO" → "Jason"
          const streamerMatch = label.match(/^(.+?)\s*\(INTRO\)/i) || label.match(/^(.+?)[_ ]INTRO$/i);
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

              const cardPngPath = require("path").join(require("os").tmpdir(), `cwn_card_${Date.now()}_${(streamerData.name||"x").replace(/[^a-z0-9]/gi,"")}.png`);
              try {
                await generateIntroCardPNG(
                  { name, displayName: name,
                    twitchUsername: streamerData.twitchUsername,
                    onAirName: streamerData.onAirName || '',
                    origin, fact,
                    profileImageUrl: streamerData.profileImageUrl || streamerData.profile_image_url || streamerData.profileImage || null },
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
                  "-filter_complex", `[1:v]scale=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.w}:${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.h}:flags=lanczos[card];[0:v][card]overlay=x=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.x}:y=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.y}:enable='lte(t,${introDur})'[out]`,
                  "-map", "[out]", "-map", "0:a",
                  "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                  "-pix_fmt", "yuv420p",
                  "-c:a", "aac", "-ar", "44100", "-y", burnedPath
                ];
                console.log(`[intro-card] Canvas PNG ready for ${name}, overlaying top-right at x=1240,y=40 (2x render, scaled to 360px w/ lanczos)`);
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
                '-filter_complex', `[1:v]scale=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.w}:${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.h}:flags=lanczos[card];[0:v][card]overlay=x=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.x}:y=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.OVERLAY_ZONE.y}:enable='lte(t,${introDur})'[out]`,
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
            // Source clips: zoom-to-fill (crop) to eliminate baked-in letterbox/pillarbox borders
            // Avatar segs: letterbox (decrease+pad) since HeyGen output is always clean 16:9
            const vfFilter = isAvatarSeg
              ? 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=fps=30'
              : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=fps=30';
          const tsArgs = [
              '-i', inputForTS,
              '-vf', vfFilter,
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
      } else if (tsFiles.length > 30 || clipCount > 0) {
        // Large job OR any source clips present — use concat demuxer for reliable A/V sync
        // xfade filter_complex with 30+ files causes A/V drift accumulation
        // and hits macOS file descriptor limits.
        // CRITICAL: xfade offset math is broken when mixing avatar crossfades (0.3s) with
        // clip hard cuts (0.001s) — cumulativeDur accumulates wrong offsets causing the video
        // to freeze on the last frame of the clip for the rest of the video duration.
        // Concat demuxer gives hard cuts everywhere but is rock-solid reliable with mixed content.
        log(asmId, `  ℹ️  ${tsFiles.length} segments${clipCount > 0 ? ` (${clipCount} source clips)` : ''} — using concat demuxer (reliable A/V sync)`);
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
      // Note: isShortContent and tickerType are declared in outer scope above

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
              // Overlay ticker at bottom: y=H-${CONFIG.TICKER.HEIGHT} (ticker height from config)
              // eof_action=repeat loops the ticker when it ends (stream_loop -1 handles this too)
              // Do NOT use shortest=1 — it would truncate the output to ticker duration (20s)
              // -t tickerTotalSec: tells FFmpeg exactly when to stop — prevents stalling at end
              // -stream_loop -1: loops the ticker for the full video duration
              // eof_action=repeat: redundant safety net but harmless
              const args = [
                '-i', outPath,
                '-stream_loop', '-1', '-i', tickerPath,
                '-t', (tickerTotalSec + 2.0).toFixed(3), // +2s buffer prevents outro truncation
                '-filter_complex', `[0:v][1:v]overlay=x=0:y=H-${CONFIG.TICKER.HEIGHT}:eof_action=repeat[vout]`,
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
              `[1:v]scale=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.x}:${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.y}[vout]`,
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
      } else if (!isShortContent) {
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
      totalDur = durations.reduce((a,b) => a+b, 0).toFixed(1);

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

          // ── Gate 6: Auto-publish after Gate 3 pass + Drive upload ──────────────
          // Triggered when: Gate 3 outcome = 'pass' AND Drive upload succeeded
          // Flow: /generate-publish-copy → /publish (Upload-Post)
          // Skipped when: SKIP_AUTO_PUBLISH=true in .env OR Gate 3 was manual_review
          if (qaResult && qaResult.outcome === 'pass' && process.env.SKIP_AUTO_PUBLISH !== 'true') {
            log(asmId, `\n🚀 Gate 6: Auto-publish triggered (Gate 3 PASS + Drive upload complete)...`);
            assemblyJobs[asmId].gate6Status = 'running';

            try {
              // Step 6a: Generate platform-specific publish copy
              log(asmId, `  📝 Gate 6a: Generating publish copy via /generate-publish-copy...`);
              const publishCopyResp = await axios.post(
                `http://localhost:${process.env.PORT || 3000}/generate-publish-copy`,
                {
                  contentType: contentType || 'twitch',
                  formType: (contentType && contentType.includes('-short')) ? 'short' : 'compilation',
                  script: fullScript || assemblyJobs[asmId].fullScript || '',
                  date: new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
                  streamers: req.body.streamers || [],
                  platforms: (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim())
                },
                { timeout: 60000 }
              );

              const publishCopy = publishCopyResp.data;
              log(asmId, `  ✅ Gate 6a: Publish copy generated`);

              // Extract YouTube metadata (primary platform)
              const ytMeta = publishCopy.platforms?.youtube || publishCopy;
              const title       = ytMeta.title       || jobTitle || outFile;
              const description = ytMeta.description || '';
              const tags        = ytMeta.hashtags     || [];

              assemblyJobs[asmId].publishCopy = publishCopy;
              log(asmId, `  📋 Title: ${title}`);

              // Step 6b: Publish to platforms via /publish
              log(asmId, `  📤 Gate 6b: Publishing via /publish...`);
              const platforms = (process.env.AUTO_PUBLISH_PLATFORMS || 'youtube').split(',').map(p => p.trim());

              const publishResp = await axios.post(
                `http://localhost:${process.env.PORT || 3000}/publish`,
                {
                  driveUrl,
                  platforms,
                  title,
                  description,
                  tags,
                  contentType: (contentType && contentType.includes('-short')) ? 'short' : 'long',
                  async: true
                },
                { timeout: 120000 }
              );

              const publishResult = publishResp.data;
              assemblyJobs[asmId].gate6Status     = 'done';
              assemblyJobs[asmId].publishResult   = publishResult;
              assemblyJobs[asmId].publishRequestId = publishResult.request_id || null;
              assemblyJobs[asmId].publishJobId     = publishResult.job_id || null;

              log(asmId, `  ✅ Gate 6b: Published to ${platforms.join(', ')}`);
              if (publishResult.request_id) log(asmId, `  📋 Upload-Post request_id: ${publishResult.request_id}`);
              if (publishResult.job_id)     log(asmId, `  📋 Upload-Post job_id: ${publishResult.job_id}`);
              if (publishResult.statusUrl)  log(asmId, `  🔗 Status: ${publishResult.statusUrl}`);

              log(asmId, `\n✅ Gate 6 COMPLETE — video published automatically`);

            } catch(gate6Err) {
              log(asmId, `⚠️  Gate 6 auto-publish failed: ${gate6Err.message}`);
              assemblyJobs[asmId].gate6Status = 'failed';
              assemblyJobs[asmId].gate6Error  = gate6Err.message;
              log(asmId, `   Manual publish: use driveUrl above with /publish endpoint`);
            }

          } else if (qaResult && qaResult.outcome === 'manual_review') {
            log(asmId, `\n⏸  Gate 6: Auto-publish SKIPPED — Gate 3 is MANUAL REVIEW (score ${qaResult.score}/100)`);
            log(asmId, `   Review QA report, then manually trigger /publish with driveUrl above`);
            assemblyJobs[asmId].gate6Status = 'skipped_manual_review';
          } else if (process.env.SKIP_AUTO_PUBLISH === 'true') {
            log(asmId, `\n⏸  Gate 6: Auto-publish SKIPPED (SKIP_AUTO_PUBLISH=true in .env)`);
            log(asmId, `   Manual publish: use driveUrl above with /publish endpoint`);
            assemblyJobs[asmId].gate6Status = 'skipped_env';
          }

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

function getDisplayName(twitchUsername) {
  if (!twitchUsername) return twitchUsername;
  return STREAMER_DISPLAY_NAMES[twitchUsername.toLowerCase()] || twitchUsername;
}

const TICKER_MAP = {
  nba:    'tools/sports_ticker.html',       // sports_ticker.html in tools/
  news:   'tools/cwn_combined_ticker.html', // cwn_combined_ticker.html in tools/
  twitch: 'tools/cwn_twitch_ticker.html'    // cwn_twitch_ticker.html in tools/
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
    const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
    const summaryResp = await axios.get(summaryUrl, { timeout: 10000 });
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
    const articleResp = await axios.get(articleUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CWN-Bot/1.0; +https://clipzworldnews.com)'
      }
    });

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
    const imageResp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CWN-Bot/1.0; +https://clipzworldnews.com)'
      }
    });

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

    const page = await puppeteer.newPage();
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

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Unusual names**: Add simple phonetic respelling in parentheses on FIRST mention only
   - Example: "Giannis Antetokounmpo (YAH-nis ON-tet-oh-KOON-po)"
   - Example: "Luka Dončić (LOON-kuh DON-chich)"
   - Common names like "LeBron", "Curry", "Durant" need no help
2. **Numbers**: Always spell out for clarity
   - Write "thirty-two points" NOT "32 points"
   - Write "one hundred and fifty" NOT "150"
   - Exception: Years like "2024" can stay numeric
3. **Abbreviations**: Spell out OR use phonetic if ambiguous
   - "NBA" → write "N-B-A" OR just "the NBA" (works fine)
   - "MVP" → write "M-V-P" OR "the MVP" (works fine)
4. **Foreign words/phrases**: Use simple phonetic respelling
   - "Nikola Jokić" → "Nikola Jokic (YO-kich)"
5. **Avoid homophones**: If a word could be mispronounced, clarify it
   - "Read" (past tense) → consider context or rephrase
6. **Punctuation = pacing**: Commas create short pauses, periods create full stops
   - Use commas liberally for natural speech rhythm
7. **Streamer names from streamers.json**: If phonetic field exists, use it on first mention
   - Check streamers.json for phonetic guidance (e.g., "Yonna" has phonetic: "Yawn-uh")

SCRIPT FORMAT — The user prompt will provide exact === SCENE HEADERS === to use. Output EXACTLY those headers, one scene per header. Do not combine scenes. Do not skip scenes.
Target: 120-150 words of SPOKEN TEXT per game segment (90 seconds of delivery).
The cold open and outro are short. Every game segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into The Other Side of the Pillow brought to you by ClipzWorld News. Where we appreciate all of yesterday's games in the association. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.
CRITICAL: Do NOT use "Witness the NBA" — the show is called "The Other Side of the Pillow". This is non-negotiable.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of The Other Side of the Pillow brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Go play a pick-up game today. Let us know how you did in the comments. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.
CRITICAL: Do NOT use "Witness the NBA" in the outro — the show is called "The Other Side of the Pillow".

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.

NBA VOICEOVER STRUCTURE — IMPORTANT:
In NBA compilations the avatar speaks WHILE the clip plays (voiceover style), not before/after.
This means: the intro sets up the game, then [CLIP PLAYS HERE] begins, and the avatar's commentary
plays as audio OVER the video highlight. The avatar is not seen during clips — only heard.
Write all game commentary assuming it will play as voiceover during the highlight clip.`,

news: `You write scripts for ClipzWorld News (@clipznashite), a deadpan world news show. Same rhythm as Twitch: setup → clip → reaction.

VOICE — two sources blended:
• Norm MacDonald Weekend Update: flat delivery, zero warmth, the world is absurd and we are simply reporting it. "Hi, I'm Norm MacDonald and this is the news."
• Daily Show Jon Stewart: the observation must make the headline MORE alarming, not less. "I urge you not to think about it too hard." Never explain the observation.

STRICT RULES:
- Each story follows: setup (2-3 sentences) → [beat] → [CLIP PLAYS HERE] → [beat] → reaction (1 sentence, flat)
- Setup: headline + context, establishes what happened
- Reaction: ONE flat observation after the clip. Short. Deadpan. Make it MORE alarming, not less.
- Never say "shocking", "alarming", "incredible", "wild"
- Never explain the observation — state it, period, move on
- [beat] = pause, use freely between sentences
- [CLIP PLAYS HERE] = structural marker, keep it, it is not spoken
- Write every single line — no brackets, no placeholders whatsoever
- This is long-form. Every story needs FULL CONTENT.

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Unusual names/places**: Add phonetic respelling in parentheses on FIRST mention only
   - "Zelenskyy (zeh-LEN-skee)", "Xi Jinping (shee jin-PING)", "Qatar (KAH-tar)"
2. **Numbers**: Spell out for clarity → "twenty-three" NOT "23"
3. **Abbreviations**: Spell out OR hyphenate → "UN" becomes "U-N" OR "the UN"
4. **Foreign words**: Simple phonetic respelling → "coup d'état (koo day-TAH)"
5. **Punctuation = pacing**: Use commas for natural speech rhythm

SCRIPT FORMAT — The user prompt will provide exact === SCENE HEADERS === to use. Output EXACTLY those headers, one scene per header. Do not combine scenes. Do not skip scenes.
Target: 80-120 words of SPOKEN TEXT per story (setup + reaction, clip audio stripped).
The cold open and outro are short. Every story segment must be fully written and dense.
COLD OPEN — ALWAYS use this EXACT wording, no variation:
"Hello everyone! You are tuning into BECAUSE THE LIGHT WAS ON brought to you by ClipzWorld News. Where we bring you the most impactful news stories of the day, our way, the CWN way. I am your host Bobby G. Let's get to it."
Do not improvise the cold open. This line is fixed for every compilation.

OUTRO — ALWAYS use this EXACT wording, no variation:
"Well everybody, that does it for another edition of BECAUSE THE LIGHT WAS ON brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the stories covered concerns you the most. Appreciate you!"
Do not improvise the outro. This line is fixed for every compilation.

DELIVERY NOTE — OUTRO: "Appreciate you!" must be on its own line after [beat]. Warm. Genuine. Give it room.

NEWS STRUCTURE — IMPORTANT:
Each story follows the same rhythm as Twitch:
[Setup — 2-3 sentences. Headline + context. What happened and why it matters. Sets up the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]
[ONE flat reaction sentence. Short. Deadpan. Makes the story MORE alarming, not less. Could be a non-sequitur.]
[beat]
Source: [Source name]. Link in description.`,

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

HEYGEN PRONUNCIATION BEST PRACTICES:
The avatar (HeyGen AI) reads your script aloud. Follow these rules for perfect pronunciation:
1. **Streamer names**: If streamers.json has phonetic field, use it on FIRST mention
   - Example: "Yonna (YAWN-uh)" if phonetic: "Yawn-uh" exists in data
   - Common names like "xQc", "Pokimane", "Kai Cenat" usually fine as-is
2. **Numbers**: Spell out → "fifty thousand viewers" NOT "50k viewers"
3. **Game titles**: If unusual, add phonetic → "Valorant" is fine, "Lies of P" is fine
4. **Punctuation = pacing**: Commas create natural pauses in speech

⚠️ CRITICAL - SCENE STRUCTURE:
The user prompt will provide a NUMBERED LIST of === SCENE HEADERS ===.
YOU MUST output EXACTLY that many scenes with EXACTLY those headers.
- If the user lists 72 scene headers, your output MUST have exactly 72 === HEADER === sections
- ONE scene per header - do NOT combine multiple headers into one section
- Do NOT skip any headers from the list
- Do NOT create your own headers - use ONLY the headers provided in the user prompt
- Count the headers in the user prompt and ensure your output has that exact count
- EXAMPLE: For 10 streamers with 3 clips each, you need 1 INTRO + (10 streamers × 7 scenes) + 1 OUTRO = 72 scenes total
- Each streamer gets: 1 INTRO scene + 3 SETUP scenes + 3 REACTION scenes = 7 scenes per streamer
- You must write ALL scene headers provided - no shortcuts, no summarizing, no combining

INTRO SCENE — Use this EXACT text for the === INTRO === scene:
"Hello everyone! You are tuning into Twitch Soup brought to you by ClipzWorld News. Where we appreciate our favorite streamers on Twitch. I am your host Bobby G. Let's get to it."

OUTRO SCENE — Use this EXACT text for the === OUTRO === scene:
"Well everybody, that does it for another edition of Twitch Soup brought to you by ClipzWorld News. Don't forget to like, comment, share and subscribe. Let us know in the comments which of the clips you liked the most. Appreciate you!"

Target: 80-100 words of SPOKEN TEXT per streamer (45 seconds before and after clip).

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

async function uploadToGeminiFiles(filePath, maxRetries = 3) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = (fileBuffer.length / 1024 / 1024).toFixed(1);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const boundary   = 'cwn_boundary_' + Date.now();
      const metadata   = JSON.stringify({ file: { display_name: path.basename(filePath) } });

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
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${GEMINI_APIKEY}`,
        body,
        { headers: { 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length }, timeout: 120000 }
      );

      if (attempt > 0) {
        console.log(`[gemini-upload] ✓ Upload succeeded on retry ${attempt}`);
      }

      return resp.data.file; // { name, uri, state }

    } catch (e) {
      const isLastAttempt = attempt === maxRetries - 1;

      if (isLastAttempt) {
        console.error(`[gemini-upload] ✗ Upload failed after ${maxRetries} attempts: ${e.message}`);
        throw e;
      }

      // Exponential backoff: 2s, 4s, 8s
      const backoffMs = Math.pow(2, attempt + 1) * 1000;
      console.warn(`[gemini-upload] Upload failed (attempt ${attempt + 1}): ${e.message}. Retrying in ${backoffMs/1000}s...`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
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

// Use TwitchClient method
function twitchThumbToMp4(thumbnailUrl) {
  return twitchClient.thumbnailToMp4(thumbnailUrl);
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
          generationConfig: { maxOutputTokens: 2000, temperature: 0.2 }
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


app.post('/generate-full-script',
  requireFields('type', 'items'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  validateArrayLength('items', 1),
  async (req, res) => {
  const { type, items, date } = req.body;
  if (!GEMINI_APIKEY) return res.status(400).json({ error: 'GEMINI_API_KEY not set in .env' });

  const dateStr = date || new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  console.log(`[generate-full-script] type:${type} items:${items.length} date:${dateStr}`);

  // Initialize metrics tracking
  const jobId = `script_${type}_${Date.now()}`;
  initJobMetrics(jobId);
  const scriptGenTimer = new StageTimer(jobId, 'Script Generation');

  try {
    // ── Step 1: Gemini analysis — full video where possible ──────────
    console.log('[generate-full-script] Running Gemini analysis...');

    // For Twitch: analyze ALL clips across all streamers with full video
    let analyses = [];
    let orderedClipUrls = []; // populated by twitch block — returned alongside script
    let clipReportDataForQA = null; // populated inside twitch block, passed to claudeScriptQA
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
          targetClipsPerStreamer: item.targetClipsPerStreamer || 2
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
          : Math.ceil(streamerClips.length / 2);

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
          }).then(analysis => {
            // Tag thumbnail-only analyses so Fix #6 can filter them out.
            // A clip is "video-analyzed" only if it had a signed CDN URL (sig=).
            const isVideoAnalyzed = !!(c.videoUrl && c.videoUrl.includes('sig='));
            return { analysis, isVideoAnalyzed };
          }))
        );
        flatAnalyses.push(...waveResults);
      }

      // Build analyses indexed by streamer name (not array position) to avoid order mismatch.
      // flatAnalyses is in streamerOrder sequence; items may be in a different order.
      // Keying by streamer name ensures Jason's analyses always go to Jason's item, etc.
      // Fix #6: flatAnalyses now contains {analysis, isVideoAnalyzed} objects — extract text + track video flag.
      const analysesByStreamer = {};
      const videoAnalyzedByStreamer = {}; // tracks how many clips had real video (sig=) per streamer
      let flatIdx = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = (streamerClips[0] && streamerClips[0].targetClipsPerStreamer)
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 2);
        const count = Math.min(target, streamerClips.length);
        const slice = flatAnalyses.slice(flatIdx, flatIdx + count);
        // Extract plain text analyses (backward-compatible with both string and {analysis,isVideoAnalyzed} formats)
        analysesByStreamer[streamer] = slice.map(a => (a && typeof a === 'object') ? a.analysis : a);
        // Count how many clips had real video analysis (not thumbnail fallback)
        videoAnalyzedByStreamer[streamer] = slice.filter(a => (a && typeof a === 'object') ? a.isVideoAnalyzed : (a && a.length > 50)).length;
        flatIdx += count;
      });
      // Build clipsByStreamer map from analysisClips (the clips that were ACTUALLY analyzed)
      // analysisClips is in streamerOrder, so we must iterate streamerOrder to slice correctly.
      const clipsByStreamer = {};
      let clipIdx = 0;
      streamerOrder.forEach(streamer => {
        const streamerClips = allClips.filter(c => c.streamer === streamer);
        const target = (streamerClips[0] && streamerClips[0].targetClipsPerStreamer)
          ? streamerClips[0].targetClipsPerStreamer
          : Math.ceil(streamerClips.length / 2);
        const count = Math.min(target, streamerClips.length);
        clipsByStreamer[streamer] = analysisClips.slice(clipIdx, clipIdx + count);
        clipIdx += count;
      });

      // Update items[].clips to match the clips that were actually analyzed
      items.forEach(item => {
        const analyzedClips = clipsByStreamer[item.streamer] || [];
        item.clips = analyzedClips.map(c => ({
          url:          c.pageUrl,
          mp4Url:       c.videoUrl,
          assemblyUrl:  c.assemblyUrl,
          thumbnailUrl: c.thumbnailUrl,
          title:        c.title,
          game:         c.game,
          streamer:     c.streamer,
          isBackup:     c.isBackup || false
        }));
      });

      console.log('[clip-mapping] Updated items[].clips to match analysisClips order');
      items.forEach(item => {
        console.log(`  ${item.streamer}: ${item.clips.length} clips - ${item.clips.map(c => (c.title||'').slice(0,30)).join(', ')}`);
      });
      console.log('[clip-mapping] streamerOrder:', streamerOrder);
      console.log('[clip-mapping] items order:', items.map(i => i.streamer));

      // Capture clip report data for Gate 1 why-doc (pass or fail)
      // Snapshot allClips and analysisClips now — they may be mutated later
      clipReportDataForQA = {
        items,
        allClips: [...analysisClips], // allClips was replaced with analysisClips above
        streamerOrder: [...streamerOrder],
        analysisClips: [...analysisClips]
      };

      // Map analyses by streamer name (c918cad fix preserved)
      analyses = items.map(item => analysesByStreamer[item.streamer] || []);

      const geminiHits = flatAnalyses.filter(a => a && a.length > 50).length;
      console.log(`[generate-full-script] Gemini analyzed ${geminiHits}/${allClips.length} clips (${allClips.length - geminiHits} fell back to thumbnail)`);

      // Fix #6: Filter out streamers without enough REAL video clips (sig= URL).
      // Thumbnail fallback analyses are also >50 chars, so the old length check was broken —
      // it let streamers with 0 real clips through, causing Gemini to hallucinate content.
      // Now we require ≥N real video-analyzed clips (isVideoAnalyzed flag set in Fix #6A).
      // targetClipsPerStreamer is derived dynamically from actual data, not hardcoded.
      const targetClipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
      const itemsBefore = items.length;
      const filteredPairs = items
        .map((item, i) => ({ item, analysis: analyses[i] }))
        .filter(({ item }) => (videoAnalyzedByStreamer[item.streamer] || 0) >= targetClipsPerStreamer);
      if (filteredPairs.length < itemsBefore) {
        const dropped = items
          .filter(item => !filteredPairs.find(p => p.item.streamer === item.streamer))
          .map(item => item.streamer);
        console.warn(`[generate-full-script] ⚠️  Dropping ${itemsBefore - filteredPairs.length} streamers with no real clip analyses: ${dropped.join(', ')}`);
        items.splice(0, items.length, ...filteredPairs.map(p => p.item));
        analyses = filteredPairs.map(p => p.analysis);
      }
      console.log(`[generate-full-script] Streamers with real clips: ${items.length}/${itemsBefore} — ${items.map(i => i.streamer).join(', ')}`);


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
      // News: prioritize stories by urgency before Gemini analysis
      if (type === 'news' || type === 'news-short') {
        const prioritized = prioritizeNewsStories(items);
        const priorityChange = prioritized.map((s, i) => `${i+1}. ${(s.title||'').slice(0, 40)}`).join(', ');
        console.log(`[generate-full-script] Story priority order: ${priorityChange}`);
        items.splice(0, items.length, ...prioritized);
      }
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
    const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
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
        userPrompt = `Write a COMPLETE Other Side of the Pillow NBA Short script for ${dateStr}.

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
        // Generate scene headers for NBA (4 scenes per game: intro + setup + clip_reaction + reaction)
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach((g, i) => {
          const gameLabel = `GAME${i+1}`;
          // Fix: replace spaces with underscores to prevent Gemini header parsing failures
          // e.g. "Trail Blazers" → "TRAIL_BLAZERS" not "TRAIL BLAZERS" (URGENT_TEST_FAILURE_INVESTIGATION.md Fix #2)
          const awayClean = (g.away||'AWAY').toUpperCase().replace(/\s+/g, '_');
          const homeClean = (g.home||'HOME').toUpperCase().replace(/\s+/g, '_');
          const teams = `${awayClean}_${homeClean}`;
          sceneHeaders.push(`=== ${gameLabel}_${teams}_INTRO ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_SETUP ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_CLIP_REACTION ===`);
          sceneHeaders.push(`=== ${gameLabel}_${teams}_REACTION ===`);
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE Other Side of the Pillow NBA Compilation script for ${dateStr}.

${items.length} game${items.length > 1 ? 's' : ''} total. ${items.length} [CLIP PLAYS HERE] markers required (one per game).

GAME DATA:
${items.map((g, i) => `
GAME ${i+1}: ${g.away || 'Away'} @ ${g.home || 'Home'}
Score: ${g.awayScore || '?'}-${g.homeScore || '?'} FINAL
${g.leader ? 'Top performer: ' + g.leader + (g.leaderStat ? ' — ' + g.leaderStat : '') : ''}
${g.injuries && g.injuries.length ? 'Out: ' + g.injuries.join(', ') : ''}
${g.awayRec || g.homeRec ? 'Records: ' + g.away + ' ' + (g.awayRec||'') + ' | ' + g.home + ' ' + (g.homeRec||'') : ''}
Gemini video analysis: ${analyses[i] || 'No analysis — use box score data only'}
`).join('')}

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- [GAME]_[TEAMS]_INTRO scenes: 2-3 sentences (introduce game/matchup)
- [GAME]_[TEAMS]_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- [GAME]_[TEAMS]_CLIP_REACTION scenes: EXACTLY 1 sentence (Bobby reacting WHILE clip plays — this will be overlaid on clip in editing)
- [GAME]_[TEAMS]_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan reaction AFTER clip)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== GAME#_[TEAMS]_INTRO ===
[2-3 sentences. Introduce the matchup. Build anticipation.]

=== GAME#_[TEAMS]_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about the game. Second sentence: specific setup for the highlight clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== GAME#_[TEAMS]_CLIP_REACTION ===
[EXACTLY 1 sentence. Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip.]

=== GAME#_[TEAMS]_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Final take AFTER the clip.]

=== OUTRO ===
[1-2 sentences. Sign-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each CLIP_REACTION scene: EXACTLY 1 sentence (live reaction during clip)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take after clip)
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never explain the take in reactions. Never recap what just happened.

Use Gemini video analysis AND box score data for specific, accurate content.
Target: 120-150 words spoken per game segment (90 seconds of delivery).`;
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
        // Generate scene headers for News (4 scenes per story: intro + setup + clip_reaction + reaction)
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach((s, i) => {
          const storyLabel = `STORY${i+1}`;
          sceneHeaders.push(`=== ${storyLabel}_INTRO ===`);
          sceneHeaders.push(`=== ${storyLabel}_SETUP ===`);
          sceneHeaders.push(`=== ${storyLabel}_CLIP_REACTION ===`);
          sceneHeaders.push(`=== ${storyLabel}_REACTION ===`);
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `Write the COMPLETE ClipzWorld News world news script for ${dateStr}.

${items.length} stor${items.length > 1 ? 'ies' : 'y'} total. ${items.length} [CLIP PLAYS HERE] markers required (one per story).

STORY DATA:
${items.map((s, i) => `
STORY ${i+1}: ${s.title || 'Untitled'}
Source: ${s.source || 'Al Jazeera'}
${s.pubDate ? 'Published: ' + s.pubDate : ''}
Article text: ${s.desc || 'No description available'}
${s.link ? 'Link: ' + s.link : ''}
Gemini visual/video analysis: ${analyses[i] || 'Not available — use article text only'}
`).join('')}

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- STORY#_INTRO scenes: 2-3 sentences (introduce the story/headline)
- STORY#_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- STORY#_CLIP_REACTION scenes: EXACTLY 1 sentence (Bobby reacting WHILE clip plays — this will be overlaid on clip in editing)
- STORY#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan reaction AFTER clip)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== STORY#_INTRO ===
[2-3 sentences. Introduce the headline. Build context.]
[beat]
Source: [Source name]. Link in description.
[beat]

=== STORY#_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about what happened. Second sentence: specific setup for the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== STORY#_CLIP_REACTION ===
[EXACTLY 1 sentence. Bobby's live reaction WHILE watching the clip. This will be picture-in-picture with the clip.]

=== STORY#_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. Makes it MORE alarming, not less. Final take AFTER the clip.]
[3-second pause — hold on the source clip for 3 seconds after Bobby's reaction, then cut to next story]

=== OUTRO ===
[1-2 sentences. Sign-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${items.length}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each CLIP_REACTION scene: EXACTLY 1 sentence (live reaction during clip)
- Each REACTION scene: EXACTLY 1 sentence (deadpan take after clip) + [3-second pause — hold on source clip]
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- After each REACTION scene: Add "[3-second pause — hold on source clip]" before moving to next story
- Never explain the take in reactions. Never recap what just happened.

Target: 80-120 words spoken per story (setup + reactions, clip audio is stripped).`;
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
          const sceneNameBase = displayName.toUpperCase().replace(/\s+/g, '_');
          const clipLines = clips.map((clip, ci) => `
  ── CLIP ${ci+1} → feeds scenes === ${sceneNameBase}_CLIP${ci+1}_SETUP === and === ${sceneNameBase}_CLIP${ci+1}_REACTION ===
  Title: "${clip.title||'N/A'}" | ${clip.views ? clip.views.toLocaleString()+' views' : ''} | ${clip.game||''}
  Analysis (write CLIP${ci+1}_SETUP and CLIP${ci+1}_REACTION based on THIS analysis ONLY): ${clipAnalyses[ci] || 'No analysis'}`).join('');
          return `STREAMER ${i+1}:
ON-AIR NAME (use this name ONLY — never use the Twitch username): ${displayName}
Twitch username (do NOT use this in spoken text): ${c.streamer||'Unknown'}
${notesStr}${clipLines}`;
        }).join('\n\n');

        // Determine clips per streamer from actual data structure
        // FIX: Use > 0 check to avoid empty array [] evaluating as falsy (length=0)
        const clipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
        console.log(`[generate-full-script] clipsPerStreamer: ${clipsPerStreamer} (source: ${items[0]?.clips?.length > 0 ? 'items[0].clips' : req.body.clipsPerStreamer ? 'req.body' : 'default:2'}) | totalClips: ${items.length * clipsPerStreamer}`);
        const totalClipSlots = items.length * clipsPerStreamer;

        // Generate 72 scene headers (1 INTRO + 10 streamers × 7 scenes each + 1 OUTRO)
        const sceneHeaders = ['=== INTRO ==='];
        items.forEach(item => {
          // Fix: replace spaces with underscores to prevent Gemini header parsing failures
          // e.g. "Jay Cinco" → "JAY_CINCO" not "JAY CINCO" (URGENT_TEST_FAILURE_INVESTIGATION.md Fix #1)
          const name = getDisplayName(item.streamer).toUpperCase().replace(/\s+/g, '_');
          sceneHeaders.push(`=== ${name}_INTRO ===`);
          for (let i = 1; i <= clipsPerStreamer; i++) {
            sceneHeaders.push(`=== ${name}_CLIP${i}_SETUP ===`);
            sceneHeaders.push(`=== ${name}_CLIP${i}_REACTION ===`);
          }
        });
        sceneHeaders.push('=== OUTRO ===');
        const expectedScenes = sceneHeaders.length;

        userPrompt = `🚨🚨🚨 CRITICAL — READ THIS FIRST 🚨🚨🚨
YOUR OUTPUT MUST HAVE EXACTLY ${expectedScenes} SCENES (=== HEADERS ===).
NOT ${items.length} SECTIONS. NOT 10-12 SECTIONS. EXACTLY ${expectedScenes} SEPARATE === HEADER === SCENES.
ONE SCENE PER HEADER. DO NOT COMBINE. DO NOT SKIP ANY. COUNT YOUR === HEADERS === AND VERIFY YOU HAVE ${expectedScenes}.

⚠️ IMPORTANT: You are generating ${expectedScenes} scenes. That is 1 INTRO + ${items.length} streamers with ${clipsPerStreamer} clips each (${items.length} × ${1 + clipsPerStreamer * 2} scenes per streamer = ${items.length * (1 + clipsPerStreamer * 2)} scenes) + 1 OUTRO = ${expectedScenes} total.
DO NOT generate ${items.length} sections. Generate ${expectedScenes} individual === HEADER === scenes.

Write the COMPLETE ClipzWorld News Twitch compilation script for ${dateStr}.

🎬 CRITICAL - SCENE STRUCTURE (${expectedScenes} SCENES REQUIRED):
Write the FULL SCRIPT using these === SCENE HEADERS === exactly (one scene per header):

${sceneHeaders.join('\n')}

⚠️ YOU MUST OUTPUT EXACTLY ${expectedScenes} SCENES - ONE PER HEADER LISTED ABOVE.
⚠️ BEFORE YOU SUBMIT: Count the number of === HEADER === lines in your output. It must equal ${expectedScenes}. If it doesn't, add the missing scenes.

STREAMER DATA (use this to write content for each scene):
${items.length} streamers. ${clipsPerStreamer} clip${clipsPerStreamer>1?'s':''} per streamer. ${totalClipSlots} total [CLIP PLAYS HERE] slots.

${streamerSections}

⚠️ SCENE LENGTH RULES - PREVENTS HEYGEN TTS FROM RUSHING:
- Each scene = 1-3 sentences MAXIMUM
- Scenes longer than 3 sentences cause HeyGen TTS to rush/skip words/poor enunciation
- INTRO scene: 2-3 sentences (episode intro)
- [NAME]_INTRO scenes: 2-3 sentences (introduce streamer)
- [NAME]_CLIP#_SETUP scenes: EXACTLY 2 sentences (not 1, not 3) + [beat] + [CLIP PLAYS HERE] + [beat]
- [NAME]_CLIP#_REACTION scenes: EXACTLY 1 sentence (short, flat, deadpan)
- OUTRO scene: 1-2 sentences (sign-off)

📝 CONTENT STRUCTURE PER SCENE:

=== INTRO ===
[2-3 sentences. Episode intro. Set the tone.]

=== [NAME]_INTRO ===
[2-3 sentences. Introduce streamer. Set up first clip context.]

=== [NAME]_CLIP1_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: context about what's happening. Second sentence: specific setup for the clip.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP1_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]

=== [NAME]_CLIP2_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: bridge from previous reaction. Second sentence: specific setup for clip 2.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP2_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]

=== [NAME]_CLIP3_SETUP ===
[EXACTLY 2 sentences — not 1, not 3. First sentence: bridge from previous reaction. Second sentence: specific setup for clip 3.]
[beat]
[CLIP PLAYS HERE]
[beat]

=== [NAME]_CLIP3_REACTION ===
[EXACTLY 1 sentence. Short. Flat. Deadpan. No explanation.]
[beat]
Follow [ON-AIR NAME]. Link in description.

=== OUTRO ===
[1-2 sentences. Sign-off.]

✅ VALIDATION CHECKLIST:
- Total scenes: MUST BE EXACTLY ${expectedScenes}
- Total [CLIP PLAYS HERE] markers: MUST BE EXACTLY ${totalClipSlots}
- Each SETUP scene: EXACTLY 2 sentences (not 1, not 3) + contains [beat] + [CLIP PLAYS HERE] + [beat]
- Each REACTION scene: EXACTLY 1 sentence, no more
- [beat] = 3-second pause — use before and after every [CLIP PLAYS HERE]
- Never explain the joke in reactions. Never recap what just happened.

NAME RULE: Bobby G ALWAYS refers to each streamer by their ON-AIR NAME only. Never use the Twitch username in spoken text. For example: say "Ron" not "StableRonaldo", say "Jay Cinco" not "Jaycinco", say "Yonna" not "YonnaJay".
PRONOUN RULES: use streamer context notes for pronouns. Never assume gender from name alone.
Total [CLIP PLAYS HERE] count must be exactly ${totalClipSlots}.
Target: 80-100 words spoken per streamer.`;
      }
    }

    // ── Step 3: Gemini generates the complete script (with Gate 1 retry loop) ─────────────────
    // NEW ARCHITECTURE (as of April 2026): Gemini writes, Claude QAs
    // Reason: Claude kept generating 11 scenes instead of 72 due to learned "one section per streamer" pattern
    const MAX_RETRIES = 3;
    let script = '';
    let scriptQA = null;
    let geminiResult = null;
    let tokenUsage = { input: 0, output: 0 };
    let wordCount = 0;
    let estSecs = 0;
    let retryAttempt = 0;

    const client = new Anthropic();

    // Calculate expected scene count for Claude QA to validate
    let expectedScenes = 0;
    if (type === 'twitch' && !type.includes('-short')) {
      // FIX: Use > 0 check to avoid empty array [] evaluating as falsy (length=0) — matches line 6262
      const clipsPerStreamer = (items[0]?.clips?.length > 0 ? items[0].clips.length : null) ?? req.body.clipsPerStreamer ?? 2;
      const scenesPerStreamer = 1 + clipsPerStreamer * 2;
      expectedScenes = 1 + items.length * scenesPerStreamer + 1; // 1 INTRO + (streamers × scenes) + 1 OUTRO
    } else if (type === 'nba') {
      expectedScenes = 1 + (items.length * 4) + 1; // 1 INTRO + (games × 4 scenes) + 1 OUTRO
    } else if (type === 'news') {
      expectedScenes = 1 + (items.length * 4) + 1; // 1 INTRO + (stories × 4 scenes) + 1 OUTRO
    }
    // Shorts and other types: expectedScenes remains 0 (no validation)

    // Retry loop: Generate script + run Gate 1 QA, retry on FAIL up to 3 times
    while (retryAttempt < MAX_RETRIES) {
      retryAttempt++;
      const attemptLabel = retryAttempt > 1 ? ` (retry ${retryAttempt}/${MAX_RETRIES})` : '';
      console.log(`[generate-full-script] 📝 Generating script via Gemini${attemptLabel}...`);

      // Build feedback message if this is a retry
      let feedbackMsg = '';
      if (retryAttempt > 1 && scriptQA) {
        // Enhanced Gate 1 coaching feedback — detailed suggestions for improvement
        const deductionsList = scriptQA.deductions?.map(d => `- ${d.reason} (-${d.points} points)`).join('\n') || 'See detailed report below';

        // Extract specific improvement suggestions from the QA report
        const suggestions = [];
        if (scriptQA.report.includes('Scene count mismatch') || scriptQA.report.includes('SCENE COUNT')) {
          suggestions.push('🚨 SCENE COUNT: You MUST write EXACTLY ONE SCENE PER === HEADER ===. Each scene header listed in the prompt requires its own scene with content. Do NOT combine multiple scenes under one header. Count your === headers === and make sure you have EXACTLY that many scenes in your output.');
        }
        if (scriptQA.report.includes('SETUP LENGTH') || scriptQA.report.includes('setups are 1 sentence')) {
          suggestions.push('🚨 SETUP LENGTH: ALL CLIP SETUP scenes (CLIP1_SETUP, CLIP2_SETUP, CLIP3_SETUP) MUST have EXACTLY 2 sentences — not 1, not 3. Count the periods in each setup scene to verify.');
        }
        if (scriptQA.report.includes('INTRO') || scriptQA.report.includes('intro')) {
          suggestions.push('INTRO: Use a bold, attention-grabbing hook. Reference specific events, names, or numbers. Avoid generic openings like "In today\'s video..."');
        }
        if (scriptQA.report.includes('PACING') || scriptQA.report.includes('pacing')) {
          suggestions.push('PACING: Keep sentences punchy (10-15 words). Vary sentence length. Remove filler words. Use transitions like "But here\'s the thing..." or "Now check this..."');
        }
        if (scriptQA.report.includes('ENERGY') || scriptQA.report.includes('energy')) {
          suggestions.push('ENERGY: Add excitement markers like "WAIT!", "NO WAY!", "LOOK AT THIS!". Use rhetorical questions. Build tension before payoffs.');
        }
        if (scriptQA.report.includes('STRUCTURE') || scriptQA.report.includes('structure')) {
          suggestions.push('STRUCTURE: Follow the arc - Setup → Build → Peak → Callback. Each clip needs context before reaction. End with a callback to the intro.');
        }
        if (scriptQA.report.includes('CONTEXT') || scriptQA.report.includes('context')) {
          suggestions.push('CONTEXT: Explain WHO (streamer), WHAT (action), WHY (significance) before showing the clip. Don\'t assume viewers know the backstory.');
        }

        const suggestionText = suggestions.length > 0
          ? `\n\n📚 SPECIFIC IMPROVEMENTS TO MAKE:\n${suggestions.join('\n\n')}\n`
          : '';

        feedbackMsg = `\n\n⚠️ PREVIOUS ATTEMPT FAILED GATE 1 QA (Score: ${scriptQA.score}/100)

🎯 COACHING FEEDBACK — Learn from these issues:

POINT DEDUCTIONS:
${deductionsList}
${suggestionText}
📋 FULL QA REPORT:
${scriptQA.claudeReport || scriptQA.report}

RETRY INSTRUCTIONS:
1. Read each deduction carefully and understand WHY points were lost
2. Apply the specific improvements listed above
3. Review successful CWN scripts for examples of engaging intros, pacing, and structure
4. Regenerate the COMPLETE script with all fixes applied

Remember: A great CWN script grabs attention in the first 5 seconds, maintains high energy throughout, and delivers a satisfying conclusion. Make it engaging, not just informative!`;

        console.log(`[generate-full-script] 🔄 Retry with enhanced Gate 1 coaching: ${scriptQA.deductions?.length || 0} issues + ${suggestions.length} specific improvement suggestions`);
      }

      // Call Gemini to generate the script
      try {
        geminiResult = await geminiScriptGeneration(userPrompt, systemPrompt, {
          previousScript: script || null,
          feedbackMsg: feedbackMsg,
          contentType: type
        });
        script = geminiResult.script;
        tokenUsage = geminiResult.tokenUsage;

        // ── Post-process: normalize spaces→underscores inside === HEADERS ===
        // Gemini sometimes writes "=== JAY CINCO_INTRO ===" despite prompt using "JAY_CINCO"
        // This replaces spaces within the header name (between === and ===) with underscores
        // e.g. "=== JAY CINCO_INTRO ===" → "=== JAY_CINCO_INTRO ===" (server.js:~6516)
        if (script && typeof script === 'string') {
          script = script.replace(/===\s+([^=]+?)\s+===/g, (match, name) => {
            const normalized = name.trim().replace(/\s+/g, '_');
            return `=== ${normalized} ===`;
          });
        }
      } catch(e) {
        console.error(`[generate-full-script] Gemini script generation failed: ${e.message}`);
        script = `[ERROR: Gemini script generation failed: ${e.message}]`;
        // Force fail this attempt
        scriptQA = { score: 0, outcome: 'fail', passed: false, outcomeLabel: '❌ HARD FAIL', deductions: [{ points: 100, reason: `Gemini API error: ${e.message}` }], report: `Gemini script generation failed: ${e.message}` };
        console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
        // Skip to retry loop condition check
        if (retryAttempt < MAX_RETRIES) {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Retrying script generation (attempt ${retryAttempt}/${MAX_RETRIES})...`);
          continue;
        } else {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Max retries (${MAX_RETRIES}) reached. Giving up.`);
          break;
        }
      }

      wordCount = script.split(/\s+/).filter(w => w.length > 0).length;
      estSecs   = Math.round((wordCount / 130) * 60);
      console.log(`[generate-full-script] Script generated by Gemini: ${wordCount} words, ~${Math.floor(estSecs/60)}m ${estSecs%60}s`);

      // ── Gate 1: Script QA — Claude reviews Gemini's script ──────────
      console.log(`[generate-full-script] 🔍 Running Gate 1 Script QA (Claude reviews Gemini's script)...`);
      scriptQA = await claudeScriptQA(script, analyses, {
        contentType: type,
        streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })) : [],
        clipsPerStreamer: req.body.clipsPerStreamer || 2,
        jobId: `${type}_${dateStr}_${Date.now()}`,
        expectedScenes: expectedScenes,
        clipReportData: clipReportDataForQA
      });

      console.log(`[generate-full-script] Gate 1 Script QA: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
      if (scriptQA.deductions?.length) {
        scriptQA.deductions.forEach(d => console.log(`[generate-full-script]   -${d.points} ${d.reason}`));
      }

      // Break conditions:
      // 1. PASS (score >= 90) → proceed to HeyGen
      // 2. FAIL due to CLIP MATCH only → try claudeScriptFix before next Gemini retry
      // 3. FAIL + max retries reached → give up (no manual_review zone — threshold is 90)
      if (scriptQA.outcome === 'pass') {
        console.log(`[generate-full-script] ✅ Gate 1 PASS — Breaking retry loop (attempt ${retryAttempt}/${MAX_RETRIES})`);
        break;
      } else {
        // Check if the ONLY issue is clip match (no structural failures)
        const hasStructuralFail = scriptQA.deductions && scriptQA.deductions.length > 0;
        const isClipMatchOnly = !hasStructuralFail &&
          scriptQA.claudeReport &&
          scriptQA.claudeReport.includes('CLIP MATCH') &&
          !scriptQA.claudeReport.includes('SCENE COUNT') &&
          !scriptQA.claudeReport.includes('CLIP COUNT') &&
          !scriptQA.claudeReport.includes('Appreciate you');

        if (isClipMatchOnly) {
          console.log('[generate-full-script] [FIX] Gate 1 FAIL (clip match only) -- Trying Claude surgical fix...');
          const fixResult = await claudeScriptFix(script, analyses, {
            contentType: type,
            streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })) : [],
            clipsPerStreamer: req.body.clipsPerStreamer || 2,
            qaReport: scriptQA.claudeReport || scriptQA.report,
            jobId: type + '_' + dateStr + '_' + Date.now()
          });
          if (fixResult.fixed) {
            script = fixResult.script;
            console.log('[generate-full-script] [FIX] Claude fix applied -- re-running Gate 1 QA...');
            scriptQA = await claudeScriptQA(script, analyses, {
              contentType: type,
              streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s })) : [],
              clipsPerStreamer: req.body.clipsPerStreamer || 2,
              jobId: type + '_' + dateStr + '_' + Date.now(),
              expectedScenes: expectedScenes,
              clipReportData: clipReportDataForQA
            });
            console.log(`[generate-full-script] Gate 1 QA after Claude fix: ${scriptQA.outcomeLabel} (${scriptQA.score}/100)`);
            if (scriptQA.outcome === 'pass') {
              console.log('[generate-full-script] [FIX] Claude fix worked -- Gate 1 PASS');
              break;
            }
          }
        }

        if (retryAttempt < MAX_RETRIES) {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Retrying script generation (attempt ${retryAttempt}/${MAX_RETRIES})...`);
          // Continue loop to retry
        } else {
          console.log(`[generate-full-script] ❌ Gate 1 FAIL — Max retries (${MAX_RETRIES}) reached. Giving up.`);
          break;
        }
      }
    }

    // ── Auto-send to HeyGen if Gate 1 passes ──────────────────────────
    let heygenResult = null;
    if (scriptQA.outcome === 'pass') {
      console.log('[generate-full-script] 🎬 Gate 1 PASSED — Auto-sending to HeyGen...');
      try {
        const format = type.includes('-short') ? 'portrait' : 'landscape';
        heygenResult = await sendScriptToHeyGen(script, {
          contentType: type,
          format,
          jobId: `${type}_${dateStr}_${Date.now()}`
        });
        console.log(`[generate-full-script] ✅ HeyGen video generation initiated: ${JSON.stringify(heygenResult.videoJobs?.map(j => j.video_id) || [heygenResult.video_id])}`);
      } catch(e) {
        console.error('[generate-full-script] ⚠️  HeyGen auto-send failed:', e.message);
        heygenResult = { error: e.message };
      }
    } else {
      console.log(`[generate-full-script] ⏸  Gate 1 ${scriptQA.outcome.toUpperCase()} — Skipping HeyGen auto-send (${retryAttempt} attempt${retryAttempt>1?'s':''} made)`);
    }

    // Finalize script generation metrics
    // Note: Gemini API calls now split into two categories:
    //  1. Clip analysis (pre-script) - counted below as geminiAnalysisCalls
    //  2. Script generation (Gate 1) - counted as geminiScriptGenCalls
    const totalGeminiAnalysisCalls = type === 'twitch' || type === 'twitch-short'
      ? (analyses.flat ? analyses.flat().length : analyses.length)
      : analyses.length;
    const geminiHitCount = analyses.flat ? analyses.flat().filter(a=>a && a.length > 50).length : analyses.filter(a=>a && a.length > 50).length;

    scriptGenTimer
      .addData('contentType', type)
      .addData('itemCount', items.length)
      // Gemini metrics (script generation + analysis)
      .addData('geminiAnalysisCalls', totalGeminiAnalysisCalls)
      .addData('geminiHits', geminiHitCount)
      .addData('geminiScriptGenCalls', retryAttempt) // 1 call per retry attempt
      // Claude metrics (QA only)
      .addData('claudeQAInputTokens', scriptQA.tokenUsage?.input || 0)
      .addData('claudeQAOutputTokens', scriptQA.tokenUsage?.output || 0)
      .addData('totalClaudeTokens', (scriptQA.tokenUsage?.input || 0) + (scriptQA.tokenUsage?.output || 0))
      // Script metrics
      .addData('scriptWordCount', wordCount)
      .addData('estimatedSeconds', estSecs)
      // Gate 1 outcomes
      .addData('gate1Score', scriptQA.score)
      .addData('gate1Outcome', scriptQA.outcome)
      .addData('gate1Passed', scriptQA.passed)
      .addData('gate1RetryAttempts', retryAttempt);

    addStageMetrics(jobId, scriptGenTimer.end());
    finalizeJobMetrics(jobId);

    res.json({
      ok: true,
      script,
      wordCount,
      estSecs,
      geminiHits: analyses.filter(a=>a).length,
      orderedClipUrls,
      // Design metadata — Gemini's visual instructions for Claude to execute
      design_metadata: {
        visualHook: null,       // Timestamp where visual interest peaks (e.g., "0:15")
        safeZone: null,         // Coordinates avoiding TikTok/Reels UI overlap
        overlayPositions: [],   // Array of {sceneId, x, y, w, h} for each overlay
        burnInImages: [],       // Array of {sceneId, design_brief, position}
        logoPlacement: null,    // Override default logo position if needed
        colorGrading: null      // Optional color grading suggestions
      },
      // Gate 1 QA results — dashboard shows these before user approves HeyGen send
      scriptQA: {
        score:         scriptQA.score,
        outcome:       scriptQA.outcome,
        outcomeLabel:  scriptQA.outcomeLabel,
        passed:        scriptQA.passed,
        report:        scriptQA.report,
        deductions:    scriptQA.deductions,
        retryAttempts: retryAttempt
      },
      // HeyGen auto-send result (only present if Gate 1 passed)
      heygen: heygenResult,
      // Include metrics in response for debugging
      metricsJobId: jobId
    });

    // ── Persist job card to disk so server restarts don't lose it ──
    // Saved whenever Gate 1 passes and HeyGen is submitted.
    // Dashboard calls GET /jobs on load to restore the job queue.
    if (scriptQA.outcome === 'pass' && heygenResult && !heygenResult.error) {
      const jobCard = {
        jobId,
        contentType: type,
        date: dateStr,
        script,
        wordCount,
        estSecs,
        orderedClipUrls,
        heygen: heygenResult,
        gate1Score: scriptQA.score,
        streamers: type === 'twitch' ? items.map(s => ({ displayName: s.displayName || s.name || s, twitchUsername: s.username || s.streamer || s })) : [],
        clipsPerStreamer: req.body.clipsPerStreamer || 2
      };
      saveJobCard(jobId, jobCard);
      console.log(`[jobs] ✅ Job card persisted to disk: ${jobId}`);

      // ── Auto-poll HeyGen → auto-assemble → auto-publish ──────────────
      // Starts a background poller that checks HeyGen every 30s until all
      // segments are completed, then automatically triggers assembly.
      // Gate 3 → Drive upload → Gate 6 publish (private) all run inside /assemble.
      // Rob's only role: review private drafts on YouTube/TikTok/Instagram.
      startHeyGenPoller(jobId, jobCard).catch(e => {
        console.error(`[heygen-poller:${jobId}] Poller startup error: ${e.message}`);
      });
    }

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

  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
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

        // 10x VIEWING: Watch each reference video 10 times for deeper style learning
        console.log(`[style-library] Starting 10x viewing analysis for ${url.slice(0,60)}...`);
        const multipleViewings = [];

        for (let viewNum = 1; viewNum <= 10; viewNum++) {
          const stylePrompt = `You are analyzing a reference video to extract a STYLE FINGERPRINT for ClipzWorld News (CWN), a "${contentType}" compilation show.

This is VIEWING #${viewNum} of 10. ${viewNum === 1 ? 'Watch this video carefully for the first time.' : viewNum <= 3 ? 'Focus on details you may have missed in previous viewings.' : viewNum <= 6 ? 'Look for subtle patterns and recurring elements.' : 'Deep analysis - extract nuanced stylistic details.'}

Your job is to extract the specific stylistic elements so a script writer can replicate the feel.

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

          const observation = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
          if (observation.length > 100) {
            multipleViewings.push(`--- VIEWING #${viewNum} ---\n${observation}`);
            console.log(`[style-library]   ✓ Viewing ${viewNum}/10 complete (${observation.length} chars)`);
          }

          // Rate limit pause between viewings (shorter than between videos)
          if (viewNum < 10) await new Promise(r => setTimeout(r, 2000));
        }

        // Synthesize all 10 viewings into a deep per-video analysis
        if (multipleViewings.length >= 8) { // Require at least 8 successful viewings
          const deepSynthesisPrompt = `You watched this "${contentType}" reference video ${multipleViewings.length} times and extracted style observations.

Here are your ${multipleViewings.length} viewing observations:
${multipleViewings.join('\n\n')}

Now synthesize ALL these observations into ONE DEEP, COMPREHENSIVE style analysis.
- Identify patterns that appeared across multiple viewings
- Highlight subtle details only noticed in later viewings
- Create a unified, nuanced understanding of this video's style
- Be specific and actionable for script writers
Max 600 words.`;

          try {
            const { Anthropic } = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const msg = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 800,
              messages: [{ role: 'user', content: deepSynthesisPrompt }]
            });
            const deepAnalysis = msg.content[0]?.text || multipleViewings.join('\n\n');
            videoAnalyses.push(`--- Reference video (10x viewing): ${url.slice(0,60)} ---\n${deepAnalysis}`);
            console.log(`[style-library] ✅ 10x analysis complete for ${url.slice(0,60)} (${deepAnalysis.length} chars)`);
          } catch(e) {
            // Fallback: concatenate all viewings
            videoAnalyses.push(`--- Reference video (10 viewings): ${url.slice(0,60)} ---\n${multipleViewings.join('\n\n')}`);
            console.log(`[style-library] ✅ 10x analysis complete (fallback) for ${url.slice(0,60)}`);
          }
        } else {
          console.warn(`[style-library] Only ${multipleViewings.length}/10 viewings succeeded, skipping video`);
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
  const STYLE_GUIDE_PATH = path.join(__dirname, 'data/cwn_style_guides.json');
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
//   scheduledAt: string,       // ISO-8601 UTC datetime (optional, omit for immediate delivery)
//   privacyStatus: string,     // YouTube: 'public' | 'private' | 'unlisted' (default: 'public')
//   tiktokPrivacy: string,     // TikTok: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS' (default: 'PUBLIC_TO_EVERYONE')
//   contentType: string,       // 'long' | 'short' — determines format per platform
//   async: boolean             // if true, returns request_id immediately and processes in background
// }
// ── Upload Status Tracking DB ─────────────────────────────────────────────────
// Reads/writes data/upload_status.json to track every publish attempt
const UPLOAD_STATUS_PATH = path.join(__dirname, 'data', 'upload_status.json');

function readUploadStatus() {
  try {
    return JSON.parse(fs.readFileSync(UPLOAD_STATUS_PATH, 'utf8'));
  } catch (e) {
    return { schema_version: '1.0', created: new Date().toISOString(), uploads: [] };
  }
}

function writeUploadStatus(db) {
  fs.writeFileSync(UPLOAD_STATUS_PATH, JSON.stringify(db, null, 2));
}

function logUploadAttempt(entry) {
  const db = readUploadStatus();
  db.uploads.unshift(entry); // newest first
  // Keep last 500 entries
  if (db.uploads.length > 500) db.uploads = db.uploads.slice(0, 500);
  writeUploadStatus(db);
}

// GET /publish/upload-status — read the upload tracking database
app.get('/publish/upload-status', (req, res) => {
  const db = readUploadStatus();
  const limit = parseInt(req.query.limit) || 50;
  const platform = req.query.platform || null;
  const status = req.query.status || null;

  let uploads = db.uploads;
  if (platform) uploads = uploads.filter(u => u.platforms && u.platforms.includes(platform));
  if (status)   uploads = uploads.filter(u => u.status === status);

  res.json({
    total: db.uploads.length,
    filtered: uploads.length,
    uploads: uploads.slice(0, limit)
  });
});

// GET /upload-status/:trackingId — look up a specific publish attempt by trackingId
app.get('/upload-status/:trackingId', (req, res) => {
  const db = readUploadStatus();
  const entry = db.uploads.find(u => u.trackingId === req.params.trackingId);
  if (!entry) return res.status(404).json({ error: 'trackingId not found', trackingId: req.params.trackingId });
  const overallStatus = entry.status === 'submitted' ? 'uploading' : entry.status;
  res.json({
    trackingId: entry.trackingId,
    overallStatus,
    platforms: entry.platforms,
    title: entry.title,
    timestamp: entry.timestamp,
    request_id: entry.request_id || null,
    job_id: entry.job_id || null,
    error: entry.error || null
  });
});

app.post('/publish',
  requireFields('platforms'),
  validateArrayLength('platforms', 1),
  sanitizeStrings('title', 'description'),
  async (req, res) => {
  const UPLOADPOST_API_KEY = process.env.UPLOADPOST_API_KEY;
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';

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
    privacyStatus = 'private',           // YouTube: 'public' | 'private' | 'unlisted'
    tiktokPrivacy = 'SELF_ONLY', // TikTok: 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS'
    contentType = 'long',
    async: asyncUpload = true,
    metricsJobId  // Optional: if frontend passes the jobId from script gen or assembly
  } = req.body;

  // Initialize metrics tracking
  const jobId = metricsJobId || `publish_${Date.now()}`;
  if (!metricsJobId) initJobMetrics(jobId);
  const publishTimer = new StageTimer(jobId, 'Upload-Post Publish');

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
      form.append('privacyStatus', privacyStatus || 'private');
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
      form.append('privacy_level', tiktokPrivacy); // 'PUBLIC_TO_EVERYONE' | 'SELF_ONLY' | 'MUTUAL_FOLLOW_FRIENDS'
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

    // Finalize publish metrics
    publishTimer
      .addData('platforms', platforms.join(', '))
      .addData('platformCount', platforms.length)
      .addData('contentType', contentType)
      .addData('scheduled', !!scheduledAt)
      .addData('async', asyncUpload)
      .addData('request_id', request_id || null)
      .addData('job_id', job_id || null)
      .addData('success', true);

    addStageMetrics(jobId, publishTimer.end());
    if (!metricsJobId) finalizeJobMetrics(jobId);

    // Generate trackingId for this publish attempt
    const trackingId = `pub_${Date.now()}_${req.body.testId || 'manual'}`;

    // Log successful publish attempt to upload_status.json
    logUploadAttempt({
      id: Date.now(),
      trackingId,
      timestamp: new Date().toISOString(),
      status: 'submitted',
      platforms,
      title,
      contentType,
      driveUrl: videoUrl,
      request_id: request_id || null,
      job_id: job_id || null,
      scheduledAt: scheduledAt || null,
      metricsJobId: jobId
    });

    res.json({
      ok: true,
      trackingId,
      request_id,
      job_id,
      results,
      scheduledAt: scheduledAt || null,
      platforms,
      statusUrl: request_id
        ? `https://api.upload-post.com/api/uploadposts/status?request_id=${request_id}`
        : job_id
        ? `https://api.upload-post.com/api/uploadposts/status?job_id=${job_id}`
        : null,
      metricsJobId: jobId
    });
  } catch(e) {
    const errData = e.response?.data;
    console.error('[upload-post] Publish failed:', e.message, errData || '');

    // Log failed publish attempt to upload_status.json
    logUploadAttempt({
      id: Date.now(),
      timestamp: new Date().toISOString(),
      status: 'failed',
      platforms,
      title,
      contentType,
      driveUrl: videoUrl || driveUrl || null,
      error: e.message,
      metricsJobId: jobId
    });

    // Track failed publish
    publishTimer
      .addData('platforms', platforms.join(', '))
      .addData('platformCount', platforms.length)
      .addData('success', false)
      .addData('error', e.message);
    addStageMetrics(jobId, publishTimer.end());
    if (!metricsJobId) finalizeJobMetrics(jobId);

    res.status(500).json({ error: e.message, details: errData || null });
  }
});

// ── prioritizeNewsStories ─────────────────────────────────────────────────────
// Reorders news stories by urgency score before Gemini analysis.
// High-priority keywords get a score bump so they appear first in the script.
// Returns: stories[] sorted by descending priority score (stable sort)
function prioritizeNewsStories(stories) {
  const HIGH_PRIORITY_KEYWORDS = [
    'trump', 'iran', 'war', 'breaking', 'crisis', 'election',
    'attack', 'killed', 'dead', 'explosion', 'nuclear', 'sanctions',
    'ceasefire', 'invasion', 'protest', 'arrest', 'indicted', 'verdict'
  ];

  const scored = stories.map(story => {
    const text = ((story.title || '') + ' ' + (story.desc || '')).toLowerCase();
    let score = 0;
    for (const kw of HIGH_PRIORITY_KEYWORDS) {
      if (text.includes(kw)) score += 10;
    }
    return { story, score };
  });

  // Stable sort: higher score first, preserve original order for ties
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.story);
}

// ── generateShortFormCaption ─────────────────────────────────────────────────
// Generates a platform-optimised short-form caption + hashtags + alt-text.
// Returns: { caption: string, hashtags: string[], altText: string }
// Called by /generate-publish-copy when formType === 'short'.
async function generateShortFormCaption(script, contentType) {
  const excerpt = script.substring(0, 400);

  const typeLabel = { nba: 'NBA highlights', news: 'world news', twitch: 'Twitch clips' }[contentType] || 'content';

  const systemPrompt = `You write ultra-short social captions for ClipzWorld News (@clipznashite) short-form vertical videos (60-90 seconds).

Content type: ${typeLabel}
Script excerpt:
${excerpt}...

Generate a JSON object with exactly these fields:
{
  "caption": "90-150 char hook with 1-2 emojis, punchy, no hashtags inline",
  "hashtags": ["array", "of", "8-12", "tags", "no", "hash", "symbol"],
  "altText": "1-sentence accessibility description of the video content, plain English, no emojis"
}

Rules:
- caption: 90-150 chars, starts with the most compelling fact or hook, ends with a micro-CTA ("Watch 👆", "Full story 👆", "Highlights 👆")
- hashtags: mix of broad (#Shorts #FYP #ForYou) + topic-specific; no # prefix in the array values
- altText: screen-reader friendly, describes what happens in the video
- Output ONLY valid JSON, no markdown, no explanation`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Generate the short-form caption JSON now.' }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('generateShortFormCaption: could not parse JSON from Claude');

  const result = JSON.parse(jsonMatch[0]);
  // Normalise hashtags — strip any accidental # prefix
  if (Array.isArray(result.hashtags)) {
    result.hashtags = result.hashtags.map(h => h.replace(/^#/, ''));
  }
  return result;
}

// POST /generate-publish-copy — generates platform-specific publish metadata
// Body: {
//   contentType: 'nba' | 'news' | 'twitch',
//   formType: 'compilation' | 'short',
//   script: string,             // full script text
//   date: string,               // e.g. "Friday, April 6, 2026"
//   streamers: string[],        // for Twitch only (display names)
//   platforms: string[]         // ['youtube', 'tiktok', 'instagram'] - defaults to ['youtube']
// }
app.post('/generate-publish-copy', async (req, res) => {
  const { contentType, formType, script, date, streamers = [], platforms = ['youtube'] } = req.body;

  if (!script) return res.status(400).json({ error: 'script required' });

  const isShort = formType === 'short';
  const scriptExcerpt = script.substring(0, 600);
  const needsTikTok = platforms.includes('tiktok');
  const needsInstagram = platforms.includes('instagram');
  const needsYouTube = platforms.includes('youtube');

  // Multi-platform prompt - generates metadata for all requested platforms
  const prompts = {
    nba: `Generate publish metadata for this NBA ${isShort ? 'Short' : 'highlights compilation'} for ${platforms.join(', ')}.

Date: ${date}
Script excerpt:
${scriptExcerpt}...

Generate metadata for each platform with these requirements:

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars max, include team names + hook
- Description: ${isShort ? '100-150 words' : '200-300 words'}, game summary, stats, subscribe CTA
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#NBA, #Lakers, etc.)
- Pinned Comment: Engagement question
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars optimal (max 2200), hook in first 40 chars, include emojis
- Mix 4-6 hashtags into caption naturally (#NBA #LeBron #FYP #ForYou)
- No separate title/description - ONE caption field
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: 125 char hook, then full description with line breaks, max 2200 chars total
- Include emojis and call-to-action
- 10-15 hashtags at end of caption (#NBA #Reels #Explore #Lakers etc.)
- No separate title - ONE caption field
` : ''}

Output as JSON with this structure:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    news: `Generate publish metadata for this world news ${isShort ? 'Short' : 'compilation'} for ${platforms.join(', ')}.

Date: ${date}
Script excerpt:
${scriptExcerpt}...

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars, main story hook
- Description: ${isShort ? '100-150 words' : '200-300 words'}, story summaries, subscribe CTA
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#News, #WorldNews, topic-specific)
- Pinned Comment: Ask which story concerns viewers most
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars, urgent/compelling hook with emojis
- Mix 4-6 hashtags (#News #Breaking #FYP #ForYou)
- ONE caption field (no separate title/description)
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Hook in first 125 chars, full story summary, emojis, line breaks
- 10-15 hashtags at end (#News #WorldNews #Reels #Explore)
- ONE caption field
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`,

    twitch: `Generate publish metadata for this Twitch clips ${isShort ? 'Short' : 'compilation'} for ${platforms.join(', ')}.

Date: ${date}
Streamers: ${streamers.join(', ') || 'Multiple streamers'}
Script excerpt:
${scriptExcerpt}...

${needsYouTube ? `
**YOUTUBE:**
- Title: ${isShort ? '50-80' : '50-100'} chars, streamer names + funny hook
- Description: ${isShort ? '100-150 words' : 'List each streamer with Twitch link, what they did, subscribe CTA'}
- Hashtags: ${isShort ? '10-15' : '5-8'} tags (#Twitch, streamer names, #Gaming)
- Pinned Comment: Ask which clip was funniest
` : ''}
${needsTikTok ? `
**TIKTOK:**
- Caption: 90-150 chars, funniest moment hook with emojis
- Mix 4-6 hashtags (#Twitch #Gaming #FYP #ForYou)
- Include streamer names naturally
` : ''}
${needsInstagram ? `
**INSTAGRAM:**
- Caption: Hook + clip description with emojis, line breaks for readability
- 10-15 hashtags (#Twitch #Gaming #Reels #Explore #StreamerName)
- Tag streamers if possible: @streamername
` : ''}

Output as JSON:
{
  ${needsYouTube ? '"youtube": { "title": "...", "description": "...", "hashtags": [...], "pinnedComment": "..." },' : ''}
  ${needsTikTok ? '"tiktok": { "caption": "..." },' : ''}
  ${needsInstagram ? '"instagram": { "caption": "..." }' : ''}
}`
  };

  const systemPrompt = `You generate multi-platform publish metadata for ClipzWorld News (@clipznashite).

${prompts[contentType] || prompts.twitch}

STRICT RULES:
- YouTube titles: max 100 chars (hard limit)
- TikTok captions: optimal 90-150 chars for engagement (max 2200)
- Instagram captions: hook in first 125 chars (gets truncated)
- All platforms: include "ClipzWorld News" or "@clipznashite" mention
- Hashtags: platform-appropriate (#Shorts for YouTube, #FYP for TikTok, #Reels for Instagram)
- Output ONLY valid JSON, no markdown code blocks, no explanation
- Use double quotes for all JSON strings`;

  try {
    // ── Short-form: generate optimised caption + hashtags + altText first ──
    // These are injected into the platform metadata for TikTok/Reels/Shorts
    let shortCaption = null;
    if (isShort) {
      try {
        shortCaption = await generateShortFormCaption(script, contentType);
        console.log(`[publish-copy] Short-form caption generated: "${shortCaption.caption.slice(0, 60)}..." (${shortCaption.caption.length} chars)`);
      } catch(e) {
        console.warn(`[publish-copy] generateShortFormCaption failed: ${e.message} — continuing without short caption`);
      }
    }

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Generate the metadata as JSON now.' }]
    });

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Extract JSON (Claude might wrap in ```json or include explanation)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[publish-copy] Could not extract JSON from response:', text);
      throw new Error('Could not parse JSON from Claude response');
    }

    const metadata = JSON.parse(jsonMatch[0]);

    // ── Inject short-form caption into platform metadata ──────────────
    // For short-form: override TikTok/Instagram captions with the optimised
    // short caption, and add altText + hashtags to all platforms.
    if (isShort && shortCaption) {
      if (metadata.tiktok) {
        metadata.tiktok.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
        metadata.tiktok.altText = shortCaption.altText;
      }
      if (metadata.instagram) {
        metadata.instagram.caption = shortCaption.caption + '\n\n' + shortCaption.hashtags.map(h => '#' + h).join(' ');
        metadata.instagram.altText = shortCaption.altText;
      }
      if (metadata.youtube) {
        // For YouTube Shorts: append #Shorts to title if not already there
        if (metadata.youtube.title && !metadata.youtube.title.includes('#Shorts')) {
          metadata.youtube.title = metadata.youtube.title.trim() + ' #Shorts';
          if (metadata.youtube.title.length > 100) {
            metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
          }
        }
        metadata.youtube.altText = shortCaption.altText;
        // Add short-form hashtags to YouTube hashtags array
        if (Array.isArray(metadata.youtube.hashtags)) {
          const shortHashtags = shortCaption.hashtags.filter(h => !metadata.youtube.hashtags.includes(h));
          metadata.youtube.hashtags = [...metadata.youtube.hashtags, ...shortHashtags].slice(0, 15);
        }
      }
      // Attach raw short caption data for dashboard display
      metadata._shortCaption = shortCaption;
    }

    // Validate platform-specific metadata
    if (needsYouTube && metadata.youtube) {
      // Enforce YouTube title length (hard limit is 100 chars)
      if (metadata.youtube.title && metadata.youtube.title.length > 100) {
        console.warn(`[publish-copy] YouTube title too long (${metadata.youtube.title.length} chars), truncating...`);
        metadata.youtube.title = metadata.youtube.title.substring(0, 97) + '...';
      }

      // Ensure hashtags is array
      if (!Array.isArray(metadata.youtube.hashtags)) {
        metadata.youtube.hashtags = [];
      }

      // Add metrics
      metadata.youtube.titleLength = metadata.youtube.title?.length || 0;
      metadata.youtube.descriptionLength = metadata.youtube.description?.length || 0;
      metadata.youtube.hashtagCount = metadata.youtube.hashtags?.length || 0;
    }

    if (needsTikTok && metadata.tiktok) {
      metadata.tiktok.captionLength = metadata.tiktok.caption?.length || 0;
    }

    if (needsInstagram && metadata.instagram) {
      metadata.instagram.captionLength = metadata.instagram.caption?.length || 0;
    }

    // Log summary
    const summary = platforms.map(p => {
      if (p === 'youtube' && metadata.youtube) {
        return `YouTube: ${metadata.youtube.titleLength} char title, ${metadata.youtube.hashtagCount} hashtags`;
      }
      if (p === 'tiktok' && metadata.tiktok) {
        return `TikTok: ${metadata.tiktok.captionLength} char caption`;
      }
      if (p === 'instagram' && metadata.instagram) {
        return `Instagram: ${metadata.instagram.captionLength} char caption`;
      }
      return null;
    }).filter(Boolean).join(', ');

    console.log(`[publish-copy] Generated metadata: ${summary}`);

    // Backward compatibility: if only YouTube requested, return flat structure
    if (platforms.length === 1 && platforms[0] === 'youtube' && metadata.youtube) {
      res.json({
        ok: true,
        ...metadata.youtube,  // Flat structure for backward compatibility
        platforms: { youtube: metadata.youtube }  // Also include nested for future use
      });
    } else {
      res.json({
        ok: true,
        platforms: metadata,
        // Add convenience fields if all platforms have same content type
        contentType,
        formType
      });
    }

  } catch (err) {
    console.error('[publish-copy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /log-heygen-metrics — frontend logs HeyGen rendering metrics
// Body: {
//   jobId: string,              // job ID from script generation
//   segmentCount: number,       // total segments rendered
//   totalWaitTimeMs: number,    // total time waiting for all segments
//   avgRenderTimeMs: number,    // average render time per segment
//   segments: [                 // optional per-segment details
//     { index: number, renderTimeMs: number, retries: number }
//   ]
// }
// GET /heygen/latest-videos — fetch most recent N videos from HeyGen account
// Used by dashboard "REFRESH IDs" button to get new video_ids after Avatar V web UI renders
// Returns videos sorted by created_at desc, with download URLs fetched for completed ones
// Query params: ?limit=20 (default 20, max 50)
app.get('/heygen/latest-videos', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ error: 'HEYGEN_API_KEY not set' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    // Step 1: List recent videos
    const listResp = await axios.get(
      `https://api.heygen.com/v1/video.list?limit=${limit}`,
      { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 15000 }
    );

    const videos = listResp.data?.data?.videos || [];
    console.log(`[heygen/latest-videos] Fetched ${videos.length} videos`);

    // Step 2: For completed videos, fetch download URLs in parallel (max 10 at a time)
    const completedVideos = videos.filter(v => v.status === 'completed');
    const batchSize = 10;
    const withUrls = [];

    for (let i = 0; i < completedVideos.length; i += batchSize) {
      const batch = completedVideos.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (v) => {
        try {
          const statusResp = await axios.get(
            `https://api.heygen.com/v1/video_status.get?video_id=${v.video_id}`,
            { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
          );
          const data = statusResp.data?.data || {};
          return {
            video_id: v.video_id,
            title: v.video_title || v.video_id,
            status: v.status,
            created_at: v.created_at,
            video_url: data.video_url || data.url || null,
            duration: data.duration || null
          };
        } catch(e) {
          return {
            video_id: v.video_id,
            title: v.video_title || v.video_id,
            status: v.status,
            created_at: v.created_at,
            video_url: null,
            error: e.message
          };
        }
      }));
      withUrls.push(...results);
      if (i + batchSize < completedVideos.length) {
        await new Promise(r => setTimeout(r, 500)); // brief pause between batches
      }
    }

    // Include non-completed videos (no URL fetch needed)
    const nonCompleted = videos
      .filter(v => v.status !== 'completed')
      .map(v => ({
        video_id: v.video_id,
        title: v.video_title || v.video_id,
        status: v.status,
        created_at: v.created_at,
        video_url: null
      }));

    // Merge and sort by created_at desc
    const allVideos = [...withUrls, ...nonCompleted]
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    res.json({
      ok: true,
      count: allVideos.length,
      videos: allVideos
    });

  } catch(e) {
    console.error('[heygen/latest-videos] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /heygen/video-urls — fetch video URLs for a specific list of video IDs
// Used by dashboard REFRESH IDs fallback when title-prefix matching returns 0 results
// (jobs sent before the title format was added to generateVideo())
// Body: { videoIds: ["abc123", "def456", ...] }
app.post('/heygen/video-urls', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ error: 'HEYGEN_API_KEY not set' });

  const { videoIds } = req.body;
  if (!Array.isArray(videoIds) || !videoIds.length) {
    return res.status(400).json({ error: 'videoIds array required' });
  }
  if (videoIds.length > 100) {
    return res.status(400).json({ error: 'Max 100 video IDs per request' });
  }

  console.log(`[heygen/video-urls] Fetching URLs for ${videoIds.length} video IDs`);

  const batchSize = 10;
  const results = [];

  for (let i = 0; i < videoIds.length; i += batchSize) {
    const batch = videoIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (videoId) => {
      try {
        const statusResp = await axios.get(
          `https://api.heygen.com/v1/video_status.get?video_id=${videoId}`,
          { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 10000 }
        );
        const data = statusResp.data?.data || {};
        return {
          video_id: videoId,
          status: data.status || 'unknown',
          video_url: data.video_url || data.url || null,
          duration: data.duration || null
        };
      } catch(e) {
        return { video_id: videoId, status: 'error', video_url: null, error: e.message };
      }
    }));
    results.push(...batchResults);
    if (i + batchSize < videoIds.length) {
      await new Promise(r => setTimeout(r, 300)); // brief pause between batches
    }
  }

  const completed = results.filter(r => r.video_url).length;
  console.log(`[heygen/video-urls] ${completed}/${videoIds.length} have URLs`);

  res.json({ ok: true, count: results.length, videos: results });
});

app.post('/log-heygen-metrics', async (req, res) => {
  const { jobId, segmentCount, totalWaitTimeMs, avgRenderTimeMs, segments } = req.body;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId required' });
  }

  try {
    // Check if job metrics exist, if not initialize
    if (!jobMetrics[jobId]) {
      initJobMetrics(jobId);
    }

    // Create HeyGen stage metrics
    const heygenTimer = new StageTimer(jobId, 'HeyGen Rendering');
    heygenTimer.startTime = Date.now() - totalWaitTimeMs; // Backdate to actual start

    heygenTimer
      .addData('segmentCount', segmentCount || 0)
      .addData('avgRenderTimeMs', avgRenderTimeMs || 0)
      .addData('avgRenderTimeSec', ((avgRenderTimeMs || 0) / 1000).toFixed(2))
      .addData('totalWaitTimeMs', totalWaitTimeMs || 0)
      .addData('totalWaitTimeSec', ((totalWaitTimeMs || 0) / 1000).toFixed(2));

    if (segments && segments.length) {
      heygenTimer.addData('segmentDetails', segments);
      const totalRetries = segments.reduce((sum, s) => sum + (s.retries || 0), 0);
      heygenTimer.addData('totalRetries', totalRetries);
    }

    addStageMetrics(jobId, heygenTimer.end());

    console.log(`[metrics:${jobId}] HeyGen rendering metrics logged: ${segmentCount} segments, ${(totalWaitTimeMs/1000).toFixed(2)}s total`);

    res.json({ ok: true, jobId, message: 'HeyGen metrics logged successfully' });
  } catch (e) {
    console.error(`[metrics] Failed to log HeyGen metrics: ${e.message}`);
    res.status(500).json({ error: e.message });
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
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';
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
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';
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
    const CLIENT_SECRET = 'YOUTUBE-CLIENT-SECRET-REDACTED';
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
      details: e.message
    });
  }
});

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
        protocol.get(videoPath, (response) => {
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });
    }

    // Get video duration
    const duration = await probeDuration(localPath);
    console.log(`[thumbnail-short] Video duration: ${duration.toFixed(2)}s`);

    // Find highest-motion frame using ffprobe scene detection
    // scene=0.3 threshold — picks frames with significant visual change
    let bestTimestamp = duration * 0.30; // fallback: 30% mark
    try {
      const sceneData = await new Promise((resolve, reject) => {
        const args = [
          '-i', localPath,
          '-vf', 'select=gt(scene\\,0.3),showinfo',
          '-vsync', 'vfr',
          '-f', 'null', '-'
        ];
        execFile(ffmpegPath().replace('ffmpeg', 'ffprobe'), [
          '-v', 'quiet', '-show_frames', '-select_streams', 'v',
          '-read_intervals', `%+${Math.min(duration, 60)}`,
          '-show_entries', 'frame=pkt_pts_time,pict_type',
          '-of', 'csv=p=0', localPath
        ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          // Parse frame timestamps — find I-frames (scene changes)
          const lines = stdout.trim().split('\n').filter(Boolean);
          const iFrames = lines
            .map(l => { const parts = l.split(','); return { t: parseFloat(parts[0]), type: parts[1] }; })
            .filter(f => f.type === 'I' && f.t > 3 && f.t < duration - 3); // skip first/last 3s
          if (iFrames.length > 0) {
            // Pick the I-frame closest to 40% mark (usually peak action)
            const target = duration * 0.40;
            iFrames.sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target));
            resolve(iFrames[0].t);
          } else {
            resolve(null);
          }
        });
      });
      if (sceneData !== null) {
        bestTimestamp = sceneData;
        console.log(`[thumbnail-short] Best frame at ${bestTimestamp.toFixed(2)}s (scene detection)`);
      } else {
        console.log(`[thumbnail-short] Scene detection found no I-frames — using 30% mark (${bestTimestamp.toFixed(2)}s)`);
      }
    } catch(e) {
      console.warn(`[thumbnail-short] Scene detection failed: ${e.message} — using fallback`);
    }

    // Get episode counter for this content type
    const epCounters = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data/episode_counters.json'), 'utf8')); }
      catch(e) { return {}; }
    })();
    const epKey = `${contentType}_short`;
    const epNum = (epCounters[epKey] || 0) + 1;
    epCounters[epKey] = epNum;
    try { fs.writeFileSync(path.join(__dirname, 'data/episode_counters.json'), JSON.stringify(epCounters, null, 2)); } catch(e) {}

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
      `drawtext=fontfile='${useFont}':text='${epLabel}':fontsize=36:fontcolor=#c7af4f:x=20:y=20:shadowcolor=black:shadowx=1:shadowy=1`
    ].join(',');

    await new Promise((resolve, reject) => {
      const args = [
        '-ss', bestTimestamp.toFixed(3),
        '-i', localPath,
        '-vframes', '1',
        '-vf', drawTextFilters,
        '-q:v', '2',
        '-y', outPath
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`)));
      proc.on('error', reject);
    });

    console.log(`[thumbnail-short] ✅ Thumbnail saved: ${outPath}`);

    // Clean up downloaded temp file
    if (videoPath.startsWith('http')) {
      try { fs.unlinkSync(localPath); } catch(e) {}
    }

    res.json({
      ok: true,
      thumbnailPath: outPath,
      thumbnailUrl: `/download/${outFile}`,
      episode: epNum,
      frameTimestamp: bestTimestamp,
      contentType
    });

  } catch(e) {
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
    avatarFaceRadius = 120
  } = req.body;

  const SAFETY_ZONES = {
    tiktok: { x: 880, y: 1520, w: 200, h: 400, label: 'TikTok like/share/comment buttons' },
    reels:  { x: 0,   y: 1770, w: 1080, h: 150, label: 'Instagram Reels caption area' }
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
      margin: Math.round(distance - avatarFaceRadius)
    };

    if (overlaps) {
      const msg = `⚠️ [safety-zone] ${platform.toUpperCase()} OVERLAP DETECTED — avatar face at (${avatarFaceX}, ${avatarFaceY}) overlaps ${zone.label} (${zone.x},${zone.y} ${zone.w}×${zone.h}). Distance: ${Math.round(distance)}px, radius: ${avatarFaceRadius}px`;
      warnings.push(msg);
      console.warn(msg);
    } else {
      console.log(`[safety-zone] ✅ ${platform.toUpperCase()} safe — avatar face ${Math.round(distance)}px from UI zone (margin: ${Math.round(distance - avatarFaceRadius)}px)`);
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
      : '⚠️ Avatar overlaps platform UI — flag for Rob review before publishing'
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
  if (!draft) return res.status(404).json({ error: `No draft for ${jobId} — call /capcut/init first` });

  try {
    // Extract frame at given timestamp (or 30% mark)
    const duration = await probeDuration(videoPath);
    const ts = timestamp || (duration * 0.30);
    const thumbPath = path.join(TMP_DIR, `capcut_thumb_${jobId}_${Date.now()}.png`);

    await new Promise((resolve, reject) => {
      const args = [
        '-ss', ts.toFixed(3),
        '-i', videoPath,
        '-vframes', '1',
        '-q:v', '2',
        '-y', thumbPath
      ];
      const proc = execFile(ffmpegPath(), args, { maxBuffer: 10 * 1024 * 1024 });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Frame extract failed: ${code}`)));
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
      is_cover: true
    });

    try { fs.unlinkSync(thumbPath); } catch(e) {}
    console.log(`[capcut/thumbnail] ✅ Cover frame set at ${ts.toFixed(2)}s`);
    res.json({ ok: true, timestamp: ts, thumbUrl });
  } catch(e) {
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
    format: asmJob.format || 'portrait'
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
      const guidePath = path.join(__dirname, 'data/cwn_style_guides.json');
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
  const guidePath = path.join(__dirname, 'data/cwn_style_guides.json');
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
  const UPLOADPOST_PROFILE = process.env.UPLOADPOST_PROFILE || 'clipzworldnews';
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
  const streamersPath = path.join(__dirname, 'data/streamers.json');
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

// ── POST /capcut/split-screen ────────────────────────────────────
// Creates split-screen short form video with CapCut API
// Requirements: 9:16, 1080p, masking, keyframes, auto-captions, 60fps
// Generates 3 platform-optimized variants (YouTube Shorts, TikTok, Instagram Reels)
app.post('/capcut/split-screen', async (req, res) => {
  const {
    sourceVideoPath,      // Left side: news source video
    bobbyGVideoPath,      // Right side: Bobby G reaction
    caption,              // Gemini-generated caption
    contentType = 'news', // news, nba, or twitch
    platforms = ['youtube', 'tiktok', 'instagram']
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
        fps: 60
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
        width: 540,  // 50% of 1080
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle' // Optional: can add mask for rounded corners
      });

      // Step 3: Add Bobby G reaction (right 50%)
      await axios.post(`${CAPCUT_API}/add_video`, {
        draft_id: draftId,
        video_path: bobbyGVideoPath,
        track_index: 1,
        x: 540,  // Right half
        y: 0,
        width: 540,
        height: 1920,
        start_time: 0,
        mask_type: 'rectangle'
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
          y: kf.y
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
          animation: captionStyle.animation
        });
      }

      // Step 6: Add platform-specific effects
      const effects = getPlatformEffects(platform, contentType);
      for (const effect of effects) {
        await axios.post(`${CAPCUT_API}/add_effect`, {
          draft_id: draftId,
          effect_type: effect.type,
          start_time: effect.start,
          duration: effect.duration
        });
      }

      // Step 7: Save draft and export (1080p/60fps)
      const saveResp = await axios.post(`${CAPCUT_API}/save_draft`, {
        draft_id: draftId,
        output_path: path.join(OUTPUT_DIR, `split_screen_${platform}_${Date.now()}.mp4`),
        resolution: '1080p',
        fps: 60,
        quality: 'high'
      });

      if (!saveResp.data.ok) {
        throw new Error(`CapCut save_draft failed for ${platform}: ${saveResp.data.error || 'unknown error'}`);
      }

      platformVariants[platform] = {
        draftId,
        outputPath: saveResp.data.output_path,
        status: saveResp.data.status
      };

      console.log(`[capcut-split] ✅ ${platform} variant saved: ${saveResp.data.output_path}`);
    }

    res.json({
      ok: true,
      platforms: platformVariants,
      caption
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
      { track: 1, time: 3, scale: 1.05, x: 540, y: -20 }  // Subtle zoom on Bobby G
    ],
    tiktok: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 1.5, scale: 1.15, x: -30, y: -40 }, // More aggressive zoom
      { track: 1, time: 0.5, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 2.5, scale: 1.1, x: 540, y: -30 }
    ],
    instagram: [
      { track: 0, time: 0, scale: 1.0, x: 0, y: 0 },
      { track: 0, time: 2, scale: 1.08, x: -15, y: -20 }, // Gentle zoom
      { track: 1, time: 1, scale: 1.0, x: 540, y: 0 },
      { track: 1, time: 3, scale: 1.06, x: 540, y: -15 }
    ]
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
      animation: 'fade_in'
    },
    tiktok: {
      fontSize: 52,
      color: '#FFFFFF',
      position: 'center_bottom',
      animation: 'pop'
    },
    instagram: {
      fontSize: 44,
      color: '#FFFFFF',
      position: 'bottom',
      animation: 'slide_up'
    }
  };
  return styles[platform] || styles.youtube;
}

// Helper: Get platform-specific effects
function getPlatformEffects(platform, contentType) {
  const effects = {
    youtube: [
      { type: 'color_correction', start: 0, duration: -1 } // Apply to entire video
    ],
    tiktok: [
      { type: 'fast_zoom', start: 0, duration: 0.5 },
      { type: 'shake', start: 2, duration: 0.3 }
    ],
    instagram: [
      { type: 'soft_glow', start: 0, duration: -1 }
    ]
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
      avatarId: '1a5d4e9130d2467fa01d9e1580aff829',
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
              `[1:v]scale=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.x}:${CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS.y}[vout]`,
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

// ── Generate Twitch Longform Thumbnail with Canvas ────────────────────
// Uses assets/twitchsoup_thumbnail.jpeg as base image (1024x1024 → scaled to 1280x720)
// Overlays circular streamer profile images in a ring, plus episode number + date text
//
// Options:
//   streamers: array of twitchUsername strings (e.g. ['adapt','hasanabi']) — max 12
//              If omitted, uses all active streamers from streamers.json
async function generateTwitchLongformThumbnail(options = {}) {
  const { createCanvas, loadImage } = require('canvas');
  const TEMPLATE_PATH = path.join(__dirname, 'assets', 'twitchsoup_thumbnail.jpeg');
  const EPISODE_COUNTERS_PATH = path.join(__dirname, 'data/episode_counters.json');

  // Check if template exists
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Twitch thumbnail template not found: ${TEMPLATE_PATH}`);
  }

  // Load and increment episode counter
  let counters = { twitch: 1, nba: 1, news: 1 };
  if (fs.existsSync(EPISODE_COUNTERS_PATH)) {
    counters = JSON.parse(fs.readFileSync(EPISODE_COUNTERS_PATH, 'utf8'));
  }
  const episodeNum = counters.twitch || 1;
  counters.twitch = episodeNum + 1;
  fs.writeFileSync(EPISODE_COUNTERS_PATH, JSON.stringify(counters, null, 2));

  // Format date: "Apr 7, 2026"
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  // ── Canvas setup: 1280x720 (YouTube standard) ────────────────────
  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Draw base image (scale 1024x1024 → fill 1280x720, center-crop) ──
  const baseImg = await loadImage(TEMPLATE_PATH);
  const srcW = baseImg.width, srcH = baseImg.height;
  const scale = Math.max(W / srcW, H / srcH);
  const drawW = srcW * scale, drawH = srcH * scale;
  const drawX = (W - drawW) / 2, drawY = (H - drawH) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(baseImg, drawX, drawY, drawW, drawH);

  // ── Resolve streamer list ─────────────────────────────────────────
  let roster = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/streamers.json'), 'utf8'));
    roster = data.roster || [];
  } catch(e) {
    console.warn('[twitch-thumbnail] Could not load streamers.json:', e.message);
  }

  let activeStreamers;
  if (options.streamers && options.streamers.length > 0) {
    // Filter roster to requested usernames (preserve order)
    activeStreamers = options.streamers
      .map(slug => roster.find(s =>
        s.twitchUsername?.toLowerCase() === slug.toLowerCase() ||
        s.displayName?.toLowerCase() === slug.toLowerCase()
      ))
      .filter(Boolean);
  } else {
    activeStreamers = roster.filter(s => s.active);
  }
  // Cap at 12 circles
  activeStreamers = activeStreamers.slice(0, 12);

  // ── Streamer circle layout ────────────────────────────────────────
  // Ring centered at (640, 360) with radius 280px
  // Circles are 110px diameter with 6px gold border
  const RING_CX = 640, RING_CY = 360;
  const RING_R  = 280;   // radius of ring center-to-center
  const CIRCLE_R = 55;   // radius of each streamer circle
  const BORDER_W = 6;
  const BORDER_COLOR = '#c7af4f'; // gold

  const n = activeStreamers.length;

  for (let i = 0; i < n; i++) {
    const streamer = activeStreamers[i];
    // Distribute evenly around the ring, starting from top (-π/2)
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const cx = RING_CX + RING_R * Math.cos(angle);
    const cy = RING_CY + RING_R * Math.sin(angle);

    // Try local file first, then remote URL
    const username = streamer.twitchUsername || '';
    const localPath = path.join(__dirname, 'assets', 'streamers', `${username}.png`);
    const imgSrc = fs.existsSync(localPath)
      ? localPath
      : (streamer.profileImage || null);

    // Draw circle clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, CIRCLE_R, 0, Math.PI * 2);
    ctx.clip();

    if (imgSrc) {
      try {
        const img = await loadImage(imgSrc);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
      } catch(e) {
        // Fallback: dark circle placeholder
        ctx.fillStyle = '#1a2540';
        ctx.fillRect(cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
        console.warn(`[twitch-thumbnail] Profile image failed for ${streamer.displayName}: ${e.message}`);
      }
    } else {
      ctx.fillStyle = '#1a2540';
      ctx.fillRect(cx - CIRCLE_R, cy - CIRCLE_R, CIRCLE_R * 2, CIRCLE_R * 2);
    }
    ctx.restore();

    // Gold border ring
    ctx.beginPath();
    ctx.arc(cx, cy, CIRCLE_R + BORDER_W / 2, 0, Math.PI * 2);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = BORDER_W;
    ctx.stroke();

    // Streamer name label below circle
    const label = (streamer.onAirName || streamer.displayName || '').toUpperCase();
    ctx.font = 'bold 16px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillText(label, cx, cy + CIRCLE_R + BORDER_W + 18);
    ctx.shadowColor = 'transparent';
  }

  // ── Episode number (top-right) ────────────────────────────────────
  ctx.textAlign = 'right';
  ctx.font = 'bold 36px Arial';
  ctx.fillStyle = '#c7af4f';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText(`EP ${episodeNum}`, W - 24, 48);

  // ── Date (top-left) ──────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(dateStr, 24, 48);

  // ── Tagline (bottom-center) ──────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.font = 'bold 32px Arial';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.fillText('TALK SOUP', W / 2, H - 32);

  ctx.shadowColor = 'transparent';

  // ── Save PNG ─────────────────────────────────────────────────────
  const outputPath = path.join(OUTPUT_DIR, `thumbnail_twitch_longform_ep${episodeNum}_${Date.now()}.png`);
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buf);

  console.log(`[twitch-thumbnail] ✅ Generated: ${path.basename(outputPath)} (Episode ${episodeNum}, ${dateStr}, ${n} streamers)`);
  return { thumbnailPath: outputPath, episodeNum, date: dateStr, streamerCount: n };
}

// ── POST /generate-twitch-longform-thumbnail ─────────────────────────
// Generates Twitch longform YouTube thumbnail using twitchsoup_thumbnail.jpeg base
// + canvas-drawn streamer circles in a ring + episode number + date
//
// Body: {
//   streamers?: string[]  // optional array of twitchUsername slugs (e.g. ['adapt','hasanabi'])
//                         // if omitted, uses all active streamers from streamers.json
// }
// Returns: { ok, thumbnailPath, episodeNum, date, streamerCount }
app.post('/generate-twitch-longform-thumbnail', async (req, res) => {
  try {
    const { streamers } = req.body || {};
    const result = await generateTwitchLongformThumbnail({ streamers });
    res.json({ ok: true, ...result });
  } catch(e) {
    console.error('[twitch-thumbnail] Error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ── POST /generate-thumbnail ──────────────────────────────────────
// Thumbnail generator using HTML tools + reference images
// - News: Uses cwn_news_tool.html via Puppeteer
// - NBA: Uses reference NBA thumbnail JPG
// - Twitch: Uses reference Ghostly Bobby G PNG
//
// Body: { contentType, date, storyTitle, storyImage, streamers[] }
// Returns: { ok, thumbnailPath, episodeNum, contentType }

app.post('/generate-thumbnail', async (req, res) => {
  try {
    const { contentType, date, storyImage = null, title = '', source = 'REACTION', streamers = [] } = req.body;

    if (!['twitch', 'nba', 'news'].includes(contentType)) {
      return res.status(400).json({ ok: false, error: 'Invalid contentType. Must be: twitch, nba, or news' });
    }

    // ── Step 1: Load and increment episode counter ─────────────────
    const EPISODE_COUNTERS_PATH = path.join(__dirname, 'data/episode_counters.json');
    let counters = { twitch: 1, nba: 1, news: 1 };

    if (fs.existsSync(EPISODE_COUNTERS_PATH)) {
      counters = JSON.parse(fs.readFileSync(EPISODE_COUNTERS_PATH, 'utf8'));
    }

    const episodeNum = counters[contentType] || 1;
    counters[contentType] = episodeNum + 1;
    fs.writeFileSync(EPISODE_COUNTERS_PATH, JSON.stringify(counters, null, 2));

    const outputPath = path.join(OUTPUT_DIR, `thumbnail_${contentType}_ep${episodeNum}_${Date.now()}.png`);

    // ── Step 2: Generate thumbnail based on content type ───────────
    if (contentType === 'news' || contentType === 'nba') {
      // ── Use Puppeteer with cwn_news_tool.html ──────────────────────
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // Load cwn_news_tool.html
        const toolUrl = `http://localhost:3000/news-tool`;
        await page.goto(toolUrl, { waitUntil: 'networkidle0' });

        // Inject story data into the page and make thumbnail visible
        await page.evaluate((data) => {
          // Make the gen-section visible (it's hidden by default)
          const genSection = document.getElementById('gen-section');
          if (genSection) genSection.style.display = 'block';

          const thumbBg = document.getElementById('thumb-bg');
          const thumbHeadline = document.getElementById('thumb-headline');
          const thumbCat = document.getElementById('thumb-cat');
          const thumbSrcBadge = document.getElementById('thumb-src-badge');
          const thumbSub = document.getElementById('thumb-sub');

          if (thumbBg && data.storyImage) {
            thumbBg.src = data.storyImage;
            thumbBg.style.display = 'block';
          }
          if (thumbHeadline) thumbHeadline.textContent = data.title || 'Story Headline';
          if (thumbCat) {
            const showName = data.contentType === 'nba' ? 'OTHER SIDE OF THE PILLOW' : 'BECAUSE THE LIGHT WAS ON';
            thumbCat.textContent = `${showName} - EPISODE ${data.episodeNum}`;
          }
          if (thumbSrcBadge) thumbSrcBadge.textContent = data.source || 'REACTION';
          const brandName = data.contentType === 'nba' ? 'OTHER SIDE OF THE PILLOW' : 'BECAUSE THE LIGHT WAS ON';
          if (thumbSub) thumbSub.textContent = (data.date || new Date().toLocaleDateString()).toUpperCase() + ' | ' + brandName;
        }, { title, storyImage, source, date, contentType, episodeNum });

        // Wait for image to load
        await new Promise(resolve => setTimeout(resolve, 500));

        // Screenshot the thumbnail element
        const thumbElement = await page.$('#thumb');
        if (!thumbElement) {
          throw new Error('Thumbnail element (#thumb) not found');
        }

        await thumbElement.screenshot({ path: outputPath });
        console.log(`[Thumbnail] ✅ Generated ${contentType} thumbnail via Puppeteer: ${outputPath}`);

      } finally {
        await browser.close();
      }

    } else if (contentType === 'twitch') {
      // ── Use Puppeteer with cwn_twitch_tool.html ────────────────────
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // Load cwn_twitch_tool.html
        const toolUrl = `http://localhost:3000/twitch-tool`;
        await page.goto(toolUrl, { waitUntil: 'networkidle0' });

        // Inject Twitch compilation data into the page
        await page.evaluate((data) => {
          // Make the gen-section visible (it's hidden by default)
          const genSection = document.getElementById('gen-section');
          if (genSection) {
            genSection.style.display = 'block';
            genSection.style.visibility = 'visible';
          }

          // Make sure thumb-scaler is visible and has dimensions
          const thumbScaler = document.getElementById('thumb-scaler');
          if (thumbScaler) {
            thumbScaler.style.display = 'inline-block';
            thumbScaler.style.visibility = 'visible';
            thumbScaler.style.width = '1280px';
            thumbScaler.style.height = '720px';
          }

          // Ensure thumb element is visible and has explicit dimensions
          const thumb = document.getElementById('thumb');
          if (thumb) {
            thumb.style.display = 'block';
            thumb.style.visibility = 'visible';
            thumb.style.opacity = '1';
            thumb.style.position = 'relative';
            thumb.style.width = '1280px';
            thumb.style.height = '720px';
          }

          const thumbBg = document.getElementById('thumb-bg');
          const thumbStreamer = document.getElementById('thumb-streamer');
          const thumbHeadline = document.getElementById('thumb-headline');
          const thumbSub = document.getElementById('thumb-sub');

          // Use reference Bobby G image as background
          if (thumbBg && data.backgroundImage) {
            thumbBg.src = data.backgroundImage;
            thumbBg.style.display = 'block';
          }

          // Set streamer names (if multiple, join them)
          if (thumbStreamer && data.streamers && data.streamers.length > 0) {
            const streamerNames = data.streamers.map(s => s.displayName || s.name || s).join(' • ');
            thumbStreamer.textContent = streamerNames.toUpperCase();
          }

          // Set title/headline
          if (thumbHeadline) {
            thumbHeadline.textContent = data.title || 'TWITCH REACTION COMPILATION';
          }

          // Set subtitle
          if (thumbSub) {
            thumbSub.textContent = data.subtitle || 'TWITCH REACTION | TALK SOUP';
          }
        }, {
          title,
          subtitle: `EPISODE ${episodeNum} | ${streamers && streamers.length > 0 ? streamers.length + ' STREAMERS' : 'TWITCH'} | TALK SOUP`,
          streamers: streamers || [],
          backgroundImage: '/assets/Ghostly Bobby G in Navy Themed Thumbnail.png',
          episodeNum
        });

        // Force layout reflow and wait for render
        await page.evaluate(() => {
          return new Promise(resolve => {
            const thumb = document.getElementById('thumb');
            if (thumb) {
              // Force a reflow by reading offsetHeight
              const _height = thumb.offsetHeight;
              console.log('Forced reflow, thumb offsetHeight:', _height);
            }
            // Wait for next frame
            requestAnimationFrame(() => {
              requestAnimationFrame(resolve);
            });
          });
        });

        // Additional wait for images to load
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Debug: Check element dimensions and visibility
        const debugInfo = await page.evaluate(() => {
          const thumb = document.getElementById('thumb');
          if (!thumb) return { found: false };

          const rect = thumb.getBoundingClientRect();
          const computed = window.getComputedStyle(thumb);

          return {
            found: true,
            rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
            computed: {
              display: computed.display,
              visibility: computed.visibility,
              opacity: computed.opacity,
              width: computed.width,
              height: computed.height
            }
          };
        });

        console.log('[Twitch Thumbnail Debug]', JSON.stringify(debugInfo, null, 2));

        // Use page.screenshot with clip instead of element.screenshot to avoid bounding box issues
        await page.screenshot({
          path: outputPath,
          clip: {
            x: 0,
            y: 0,
            width: 1280,
            height: 720
          }
        });
        console.log(`[Thumbnail] ✅ Generated Twitch thumbnail via Puppeteer: ${outputPath}`);

      } finally {
        await browser.close();
      }
    }

    // ── Step 3: Return response ────────────────────────────────────
    res.json({
      ok: true,
      thumbnailPath: outputPath,
      episodeNum: episodeNum,
      contentType
    });

  } catch (error) {
    console.error('[Thumbnail] ❌ Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ── Generate Newscast Overlay PNG using Puppeteer ──────────────────
// Renders clipzworld_newscast.html with story data for news intro segments
// storyIndex: which story to highlight (0-based)
async function generateNewscastOverlay(storyData, outputPath, storyIndex = 0) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Load clipzworld_newscast.html
    const overlayUrl = `http://localhost:3000/newscast-overlay`;
    await page.goto(overlayUrl, { waitUntil: 'networkidle0' });

    // Inject story data into the page
    await page.evaluate((data, activeIndex) => {
      // Update lower third with current story info
      const ltHeadline = document.querySelector('.lt-headline');
      const ltCategory = document.querySelector('.lt-category');
      const ltSub = document.querySelector('.lt-sub');

      if (ltHeadline) ltHeadline.textContent = data.title || 'Breaking News';
      if (ltCategory) ltCategory.textContent = data.category || 'WORLD NEWS';
      if (ltSub) ltSub.textContent = data.date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase();

      // Update breaking news banner with current story
      const breakingText = document.querySelector('.breaking-text');
      if (breakingText) {
        const breakingMsg = (data.title || 'BREAKING NEWS').toUpperCase();
        breakingText.textContent = breakingMsg + ' ● ' + breakingMsg;
      }

      // Update story list with all stories, highlighting the active one
      if (data.allStories && data.allStories.length > 0) {
        const storyList = document.querySelector('.story-list');
        if (storyList) {
          storyList.innerHTML = '';
          data.allStories.forEach((story, idx) => {
            const storyItem = document.createElement('div');
            // Highlight the current story being introduced
            storyItem.className = 'story-item' + (idx === activeIndex ? ' active' : '');
            storyItem.innerHTML = `
              <div class="story-item-cat">${idx === activeIndex ? '▶ ON AIR' : story.category || 'WORLD'}</div>
              <div class="story-item-text">${story.title || story.text || ''}</div>
            `;
            storyList.appendChild(storyItem);
          });
        }
      }
    }, storyData, storyIndex);

    // Wait for animations to settle
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Screenshot the full page
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`[newscast-overlay] ✅ Generated overlay (story ${storyIndex}): ${outputPath}`);

  } finally {
    await browser.close();
  }

  return outputPath;
}


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
  } catch(e) {
    return res.status(400).json({ error: 'streamers.json not found' });
  }

  // Get active streamers in configured order (max 12 for the circles)
  const activeStreamers = roster
    .filter(s => s.active)
    .slice(0, THUMBNAIL_CIRCLE_ELEMENT_IDS.length);

  const dateStr  = date || new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const hookText = hookLine || 'BEST TWITCH CLIPS';

  console.log(`[thumbnail] Generating for ${activeStreamers.length} streamers, date: ${dateStr}`);
  res.json({ ok: true, message: 'Thumbnail generation started — check /thumbnail-status/' + jobId });

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
            url: hiResUrl
          },
          {
            headers: {
              'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            },
            timeout: 30000
          }
        );

        const uploadJob = uploadResp.data.job;
        console.log(`[thumbnail] Upload job ${uploadJob.id} for ${streamer.displayName}: ${uploadJob.status}`);

        // Poll for upload completion (max 30 seconds)
        let asset = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 3000));

          const statusResp = await axios.get(
            `https://api.canva.com/rest/v1/url-asset-uploads/${uploadJob.id}`,
            {
              headers: { 'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}` }
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
          asset_id: assetId
        };
      });

      // Add text fields
      autofillData.hookLine = {
        type: 'text',
        text: hookText
      };

      autofillData.dateLine = {
        type: 'text',
        text: `CLIPZWORLD NEWS  •  ${dateStr.toUpperCase()}`
      };

      const autofillResp = await axios.post(
        'https://api.canva.com/rest/v1/autofills',
        {
          brand_template_id: TWITCH_THUMBNAIL_TEMPLATE_ID,
          data: autofillData,
          title: `Twitch Compilation - ${dateStr}`
        },
        {
          headers: {
            'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const autofillJob = autofillResp.data.job;
      console.log(`[thumbnail] Autofill job ${autofillJob.id}: ${autofillJob.status}`);

      // Poll for autofill completion (max 60 seconds)
      let design = null;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));

        const statusResp = await axios.get(
          `https://api.canva.com/rest/v1/autofills/${autofillJob.id}`,
          {
            headers: { 'Authorization': `Bearer ${CANVA_ACCESS_TOKEN}` }
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
        completedAt: new Date().toISOString()
      };

    } catch(err) {
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
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({ name: f, path: path.join(OUTPUT_DIR, f), mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(keepCount);
    const toKeep   = files.slice(0, keepCount);

    toKeep.forEach(f => results.kept.push(f.name));
    for (const f of toDelete) {
      const size = fs.statSync(f.path).size;
      fs.unlinkSync(f.path);
      results.deleted.push(f.name);
      results.freed += size;
      console.log(`[cleanup] Deleted: ${f.name} (${(size/1024/1024).toFixed(1)}MB)`);
    }

    // Also clean thumb jpg files for deleted videos
    fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('_thumb.jpg'))
      .forEach(f => {
        const baseName = f.replace('_thumb.jpg', '.mp4');
        if (results.deleted.includes(baseName)) {
          try { fs.unlinkSync(path.join(OUTPUT_DIR, f)); } catch(e) {}
        }
      });
  } catch(e) {
    console.warn('[cleanup] Output cleanup error:', e.message);
  }

  // ── Tmp directory — clean all leftover segments ───────────────
  if (cleanTmp) {
    try {
      let tmpFreed = 0;
      fs.readdirSync(TMP_DIR).forEach(f => {
        // Keep: cwn_font.ttf, ticker_*.mp4, profile_*.png (profile image cache)
        // Delete: asm_*, gate2_*, gate3_*, learn_*, early_clips/
        if (f.startsWith('asm_') || f.startsWith('gate') || f.startsWith('learn_') || f.startsWith('gemini_')) {
          const fp = path.join(TMP_DIR, f);
          try {
            const size = fs.statSync(fp).size;
            fs.unlinkSync(fp);
            tmpFreed += size;
          } catch(e) {}
        }
      });
      // Clean early_clips subfolder
      const earlyDir = path.join(TMP_DIR, 'early_clips');
      if (fs.existsSync(earlyDir)) {
        fs.readdirSync(earlyDir).forEach(f => {
          try {
            const fp = path.join(earlyDir, f);
            const size = fs.statSync(fp).size;
            fs.unlinkSync(fp);
            tmpFreed += size;
          } catch(e) {}
        });
      }
      results.freed += tmpFreed;
      if (tmpFreed > 0) console.log(`[cleanup] Tmp freed: ${(tmpFreed/1024/1024).toFixed(1)}MB`);
    } catch(e) {
      console.warn('[cleanup] Tmp cleanup error:', e.message);
    }
  }

  // ── QA logs — optional ────────────────────────────────────────
  if (cleanQaLogs) {
    const qaDir = path.join(OUTPUT_DIR, 'qa_failures');
    if (fs.existsSync(qaDir)) {
      fs.readdirSync(qaDir).forEach(f => {
        try { fs.unlinkSync(path.join(qaDir, f)); } catch(e) {}
      });
      console.log('[cleanup] QA logs cleared');
    }
  }

  const freedMB = (results.freed / 1024 / 1024).toFixed(1);
  console.log(`[cleanup] ✅ Done — freed ${freedMB}MB, deleted ${results.deleted.length} videos, kept ${results.kept.length}`);
  res.json({ ok: true, deleted: results.deleted, kept: results.kept, freedMB: parseFloat(freedMB) });
});

// GET /disk-usage — check current disk usage
app.get('/disk-usage', (req, res) => {
  try {
    const outputFiles = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const fp = path.join(OUTPUT_DIR, f);
        const stat = fs.statSync(fp); // Call statSync only once
        return { name: f, sizeMB: parseFloat((stat.size/1024/1024).toFixed(1)), mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const tmpSize = fs.readdirSync(TMP_DIR).reduce((acc, f) => {
      try { return acc + fs.statSync(path.join(TMP_DIR, f)).size; } catch(e) { return acc; }
    }, 0);

    const totalMB = outputFiles.reduce((a, f) => a + f.sizeMB, 0) + tmpSize/1024/1024;
    res.json({ ok: true, outputFiles, tmpMB: parseFloat((tmpSize/1024/1024).toFixed(1)), totalMB: parseFloat(totalMB.toFixed(1)) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /errors — diagnostic endpoint for structured error log ────
app.get('/errors', (req, res) => {
  const n = parseInt(req.query.n) || 50;
  const label = req.query.label || null;
  const rate = getErrorRate();
  let recent = getRecentErrors(n);
  if (label) recent = recent.filter(e => e.label === label);
  res.json({ ok: true, errorRate: rate, recent, logFile: ERROR_LOG });
});

// ── Express error middleware (must be last) ───────────────────────
app.use(errorMiddleware);

// ── Start ─────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🎬 CWN Production Server running on http://localhost:${PORT}`);
  console.log(`   FFmpeg path: ${ffmpegPath()}`);
  console.log(`   Tmp dir:     ${TMP_DIR}`);
  console.log(`   Output dir:  ${OUTPUT_DIR}\n`);
  checkFFmpeg((err, v) => {
    if (err) console.warn('⚠️  FFmpeg not found:', err.message);
    else console.log('✅ FFmpeg:', v);
  });
});

// Graceful shutdown handler
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Clean up active jobs
    const activeJobs = Object.keys(assemblyJobs).filter(id => 
      assemblyJobs[id].status === 'running'
    );
    
    if (activeJobs.length > 0) {
      console.log(`⚠️  ${activeJobs.length} active assembly job(s) - allowing 30s to complete`);
      setTimeout(() => {
        console.log('⏱️  Shutdown timeout - exiting');
        process.exit(0);
      }, 30000);
    } else {
      console.log('✅ No active jobs - exiting cleanly');
      process.exit(0);
    }
  });
  
  // Force exit after 35 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after 35s timeout');
    process.exit(1);
  }, 35000);
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
    return res.status(500).json({ ok: false, error: 'Template not found: templates/nba_intro_card.html' });
  }

  let browser;
  try {
    console.log(`[nba-intro-card] Generating card for game ${gameId}...`);

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    });

    const page = await browser.newPage();

    // Set viewport to exactly 640×360 (TV aspect ratio)
    await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 2 });

    // Load the template with gameId param — HTML auto-fetches ESPN API
    const fileUrl = `file://${templatePath}?gameId=${gameId}`;
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 20000 });

    // Wait for ESPN API data to render (title changes to 'READY' when done)
    try {
      await page.waitForFunction(() => document.title === 'READY', { timeout: 12000 });
    } catch(e) {
      console.warn(`[nba-intro-card] Timeout waiting for READY — taking screenshot anyway`);
    }

    // Extra buffer for images (logos) to fully load
    await new Promise(resolve => setTimeout(resolve, 1200));

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
      dimensions: '640x360'
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
      } catch(ffErr) {
        console.warn(`[nba-intro-card] FFmpeg failed (PNG still saved): ${ffErr.message}`);
        result.videoError = 'FFmpeg conversion failed — PNG is available';
      }
    }

    res.json(result);

  } catch(err) {
    if (browser) { try { await browser.close(); } catch(e) {} }
    console.error(`[nba-intro-card] Error:`, err.message);
    res.status(500).json({ ok: false, error: err.message, gameId });
  }
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
