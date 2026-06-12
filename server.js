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
    const branch = _execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }).toString().trim();
    const commitMsg = _execSync('git log -1 --format=%s', { cwd: __dirname }).toString().trim();
    const pkg = require('./package.json');
    return {
      version: pkg.version,
      gitHash: hash,
      gitHashFull: fullHash,
      gitBranch: branch,
      lastCommit: commitMsg,
      deployedAt: new Date().toISOString()
    };
  } catch(e) {
    return { version: require('./package.json').version, gitHash: 'unknown', deployedAt: new Date().toISOString() };
  }
})();

// ── New Relic custom event helpers ───────────────────────────────────────────
// All events are fire-and-forget — never block the pipeline.
// Queryable via NRQL on each custom event type name.
const { nrPipelineEvent } = require('./lib/nr_pipeline');

function nrEvent(eventType, attributes) {
  nrPipelineEvent(eventType, attributes);
}

// Keep old helper for backwards compat
function nrGateAttribute(jobId, gate, score, passed) {
  nrEvent('GateResult', { jobId, gate, gateScore: score, gatePassed: passed });
}

// ── NR Event: Job confirmed (pre-generate sign-off complete) ─────────────────
function nrJobConfirmed(jobSpec, allReady) {
  nrEvent('JobConfirmed', {
    jobId:       jobSpec.jobId,
    customerId:  jobSpec.customerId,
    templateId:  jobSpec.templateId,
    contentType: jobSpec.contentType,
    formFactor:  jobSpec.order?.output?.formFactor,
    platforms:   (jobSpec.deliverySpec?.platforms || []).join(','),
    allGatesReady: allReady,
    expectedClips: jobSpec.designSpec?.expectedClipCount ?? 0
  });
}

function nrQaGenerateConfirmPolicy(jobSpec, attrs = {}) {
  nrEvent('QaGenerateConfirmPolicy', {
    jobId: jobSpec.jobId,
    customerId: jobSpec.customerId,
    templateId: jobSpec.templateId,
    contentType: jobSpec.contentType,
    ...attrs
  });
}

// ── NR Event: Gate result (pass/fail at any gate) ────────────────────────────
function nrGateResult(jobId, customerId, contentType, gate, passed, score, outcome, durationMs) {
  nrEvent('GateResult', {
    jobId, customerId, contentType,
    gate: String(gate),
    passed: passed ? 1 : 0,
    score: score ?? null,
    outcome: outcome || null,
    durationMs: durationMs || null
  });
}

// ── NR Event: Script sendback (Gate 1 fix directive issued) ──────────────────
function nrScriptSendback(jobId, customerId, contentType, score, attempt, reasons) {
  nrEvent('ScriptSendback', {
    jobId, customerId, contentType,
    score, attempt,
    reasons: Array.isArray(reasons) ? reasons.slice(0,3).join('; ') : (reasons || '')
  });
}

// ── NR Event: Video published (Gate 5 success) ───────────────────────────────
function nrVideoPublished(jobId, customerId, contentType, platform, title, pipelineMs, scores) {
  nrEvent('VideoPublished', {
    jobId, customerId, contentType, platform,
    title: (title || '').slice(0, 100),
    totalPipelineMs: pipelineMs || null,
    gate1Score:  scores?.gate1  ?? null,
    gate3aScore: scores?.gate3a ?? null,
    gate4Score:  scores?.gate4  ?? null
  });
}

// ── NR Event: Assembly complete ───────────────────────────────────────────────
function nrAssemblyComplete(jobId, customerId, contentType, asmId, durationMs, fileSizeMB, gate3aScore) {
  nrEvent('AssemblyComplete', {
    jobId, customerId, contentType, asmId,
    durationMs: durationMs || null,
    fileSizeMB: fileSizeMB || null,
    gate3aScore: gate3aScore ?? null
  });
}

// ── NR Event: Video published (Gate 5 success) ───────────────────────────────
function nrVideoPublished(jobId, customerId, contentType, platform, title, pipelineMs, scores) {
  nrEvent('VideoPublished', {
    jobId, customerId, contentType, platform,
    title: (title || '').slice(0, 100),
    totalPipelineMs: pipelineMs || null,
    gate1Score:  scores?.gate1  ?? null,
    gate3aScore: scores?.gate3a ?? null,
    gate4Score:  scores?.gate4  ?? null
  });
}

// ── NR Event: Assembly complete ───────────────────────────────────────────────
function nrAssemblyComplete(jobId, customerId, contentType, asmId, durationMs, fileSizeMB, gate3aScore) {
  nrEvent('AssemblyComplete', {
    jobId, customerId, contentType, asmId,
    durationMs: durationMs || null,
    fileSizeMB: fileSizeMB || null,
    gate3aScore: gate3aScore ?? null
  });
}

// ── Red 4: Proactive chrome directive architecture ─────────────────────────
// Feature flag — default true. Set USE_DIRECTIVE_CHROME=false to fall back
// to the legacy Fix 5/7 reactive state machine (emergency rollback only).
const USE_DIRECTIVE_CHROME = process.env.USE_DIRECTIVE_CHROME !== 'false';
const { directiveToOverlayParams, validateScript: validateChromeScript } = require('./lib/chromeDirectives');
const {
  writeDirectiveForJob,
  loadDirectiveForJob,
  hasDirectiveForJob,
  extractSpokenTextFromDirective,
  pruneOldDirectives
} = require('./lib/directives');

// ── Option Y hotfix 1: browser-like headers to bypass Al Jazeera WAF ──────
// axios default User-Agent (axios/1.x.x) gets blocked by Al Jazeera's bot
// detection. Full Chrome-on-macOS header set makes requests look like a real
// browser. Rotate Chrome version (currently 132) quarterly to avoid staleness.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Ch-Ua': '"Chromium";v="132", "Google Chrome";v="132", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"'
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

// ── Timestamp all console output ──────────────────────────────────────────────
const _origLog   = console.log;
const _origWarn  = console.warn;
const _origError = console.error;
const _ts = () => new Date().toISOString().replace('T',' ').slice(0,19);
console.log   = (...a) => _origLog(`[${_ts()}]`,   ...a);
console.warn  = (...a) => _origWarn(`[${_ts()}]`,  ...a);
console.error = (...a) => _origError(`[${_ts()}]`, ...a);

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const axios      = require('axios');
const fs         = require('fs');
const { execFile, exec, execSync } = require('child_process');
const Anthropic  = require('@anthropic-ai/sdk');
const puppeteer  = require('puppeteer');

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
          path.join(cacheBase, ver, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
          path.join(cacheBase, ver, 'chrome-mac-x64',  'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
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
  } catch (_) { /* non-fatal */ }

  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  }
  if (process.platform === 'linux') {
    const candidates = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
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
const { requireFields, validateContentType, validateArrayLength, sanitizeStrings } = require('./lib/validation');
const TwitchClient = require('./lib/clients/twitch_client');
const { CONFIG } = require('./lib/config');
const logger = require('./lib/logger');
const pipelineBus = require('./lib/pipeline_events');
const { StageTimer, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics } = require('./lib/metrics');
const db = require('./lib/db');
const { createJobSpec, getJobSpec } = require('./lib/job_spec');
const {
  shouldUseManualCheckpoint,
  useC0ImmediateManualHold,
  writeManualManifest,
  prefetchManualSourceClips,
  prepareC0ManualHoldAfterHeyGen,
  applyManualOverrides
} = require('./lib/manual_segment_workflow');
const { persistJobSpecGateContracts } = require('./lib/job_spec_contracts');
const { startMonitoring } = require('./lib/monitoring');
const {
  generateTwitchLongformThumbnail,
  generateNewsNbaThumbnail,
  burnSceneChromeFromDirective,
  generateChromeOverlayFromDirective,
  generateNewscastOverlay
} = require('./lib/chrome_overlay');
const {
  parseScriptIntoScenes,
  generateClipAvailabilityReport,
  claudeScriptQA,
  claudeScriptFix,
  callClaudeAPI,
  uploadToGeminiFiles,
  waitForGeminiFile,
  deleteGeminiFile,
  autoAction
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
  handleGenerateFullScript
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
  handleGeneratePublishCopy
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
  TICKER_CACHE,
  TICKER_MAP,
  assemblyJobs
} = require('./lib/assembly');
const { downloadFile } = require('./lib/downloader');
const { ffmpegPath: _ffmpegDockerPath, ffprobePath: _ffprobeDockerPath } = require('./lib/ffmpeg_utils');
const cheerio = require('cheerio');

const app  = express();

// ── FFmpeg encoder selection ─────────────────────────────────────────────────
// macOS (local dev, M4 Pro): VideoToolbox hardware encoder — ~5x faster than libx264
// Linux (Railway standard): libx264 ultrafast — no GPU on standard plan
// Linux + GPU (Railway future): h264_nvenc — add when GPU instance available
const _IS_MACOS  = process.platform === 'darwin';
const _HW_AVAIL  = _IS_MACOS; // extend to check process.env.ENABLE_NVENC when Railway GPU added

// Returns encoder + quality args for the current platform.
// hwQuality=true for chrome burns (short segments, worth extra quality)
// hwQuality=false for normalize/concat (large files, speed matters more)
function ffmpegEncodeArgs(hwQuality = false) {
  if (_HW_AVAIL) {
    // Apple VideoToolbox — uses M4 Pro media engine, doesn't compete with CPU
    return ['-c:v', 'h264_videotoolbox',
            ...( hwQuality ? CONFIG.FFMPEG.HW_QUALITY_HQ : CONFIG.FFMPEG.HW_QUALITY_FLAG ),
            ...CONFIG.FFMPEG.THREADS];
  } else {
    // Linux / Railway — software encode, ultrafast preset for speed
    return ['-c:v', 'libx264',
            ...( hwQuality ? CONFIG.FFMPEG.SW_QUALITY_HQ : CONFIG.FFMPEG.SW_QUALITY_FLAGS ),
            ...CONFIG.FFMPEG.THREADS];
  }
}

console.log(`[ffmpeg] Encoder: ${_HW_AVAIL ? 'h264_videotoolbox (hardware)' : 'libx264 (software)'} on ${process.platform}`);

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
pruneOldDirectives(); // Red 4 hotfix 12: prune directive sidecar files older than 7 days

// assemblyJobs imported from lib/assembly.js (shared in-memory state)
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
// Expose to assembly.js Gate 2 bypass (avoids circular require)
global.persistedJobsRef = persistedJobs;

// ── SQLite init + fallback load ───────────────────────────────────────────────
// Initialize SQLite alongside jobs.json. During transition both run in parallel.
// If SQLite has more jobs than the JSON file (e.g. after a partial migration),
// prefer SQLite so no jobs are lost.
try {
  db.initDb();
  const sqliteJobs = db.loadAllJobs();
  if (sqliteJobs.length > Object.keys(persistedJobs).length) {
    console.log(`[db] SQLite has ${sqliteJobs.length} jobs vs JSON ${Object.keys(persistedJobs).length} — using SQLite as primary`);
    persistedJobs = {};
    for (const card of sqliteJobs) {
      // Cards created by /generate-clip-comp (and some legacy flows) use `id`, not `jobId`
      // — keying on jobId alone silently dropped them from memory on every restart.
      const key = card && (card.jobId || card.id);
      if (key) persistedJobs[key] = card;
    }
  } else {
    console.log(`[db] SQLite ready (${sqliteJobs.length} jobs). JSON file is primary for now.`);
  }
} catch (e) {
  console.error('[db] SQLite init failed — falling back to jobs.json only:', e.message);
}

// Infer job stage from card fields for legacy jobs that predate the explicit stage field.
// Used by /jobs filter and startup resume logic.
function inferJobStage(job) {
  if (job.finalUrl) return 'assembled';
  if (job.assembly?.url || job.assembledUrl) return 'assembled';
  const videoJobs = job.heygen?.videoJobs || [];
  if (videoJobs.length > 0) {
    const allComplete = videoJobs.every(vj => vj.status === 'completed' && vj.video_url);
    if (allComplete) return 'all_sent'; // all done — ready for assembly
    const anyStarted = videoJobs.some(vj => vj.video_id);
    if (anyStarted) return 'all_sent'; // in-flight in HeyGen
  }
  if (job.script) return 'script_ready';
  return '';
}

// ── SQLite init + fallback load ───────────────────────────────────────────────
// Initialize SQLite alongside jobs.json. During transition both run in parallel.
// If SQLite has more jobs than the JSON file (e.g. after a partial migration),
// prefer SQLite so no jobs are lost.
try {
  db.initDb();
  const sqliteJobs = db.loadAllJobs();
  if (sqliteJobs.length > Object.keys(persistedJobs).length) {
    console.log(`[db] SQLite has ${sqliteJobs.length} jobs vs JSON ${Object.keys(persistedJobs).length} — using SQLite as primary`);
    persistedJobs = {};
    for (const card of sqliteJobs) {
      const key = card && (card.jobId || card.id);
      if (key) persistedJobs[key] = card;
    }
  } else {
    console.log(`[db] SQLite ready (${sqliteJobs.length} jobs). JSON file is primary for now.`);
  }
} catch (e) {
  console.error('[db] SQLite init failed — falling back to jobs.json only:', e.message);
}

// Infer job stage from card fields for legacy jobs that predate the explicit stage field.
// Used by /jobs filter and startup resume logic.
function inferJobStage(job) {
  if (job.finalUrl) return 'assembled';
  if (job.assembly?.url || job.assembledUrl) return 'assembled';
  const videoJobs = job.heygen?.videoJobs || [];
  if (videoJobs.length > 0) {
    const allComplete = videoJobs.every(vj => vj.status === 'completed' && vj.video_url);
    if (allComplete) return 'all_sent'; // all done — ready for assembly
    const anyStarted = videoJobs.some(vj => vj.video_id);
    if (anyStarted) return 'all_sent'; // in-flight in HeyGen
  }
  if (job.script) return 'script_ready';
  return '';
}

function saveJobCard(jobId, card) {
  // Fix 2 Part A: Extract source_clip segments from script and save to card
  if (card.script && card.orderedClipUrls) {
    const sourceClipScenes = (card.script.scenes || []).filter(s => s.type === 'source_clip');
    if (sourceClipScenes.length > 0) {
      const sourceClipSegments = sourceClipScenes.map((scene, i) => {
        const clipData = card.orderedClipUrls[i] || {};
        return {
          type:            'source_clip',
          sceneId:         scene.name,
          label:           scene.name || `STORY${i+1}_CLIP`,
          clipUrl:         clipData.clipUrl || clipData.url || '',
          pageUrl:         clipData.pageUrl || '',
          pillarboxFilter: clipData.pillarboxFilter || null,
          orientation:     clipData.orientation || 'portrait',
          clipTimingTargets: Array.isArray(clipData.clipTimingTargets) ? clipData.clipTimingTargets : [],
          clipTimingFormat: clipData.clipTimingFormat || 'none',
          storyIndex:      clipData.storyIndex ?? i,
          status: 'ready'  // source clips don't render via HeyGen
        };
      });
      card.sourceClipSegments = sourceClipSegments;
      console.log(`[jobs] Saved ${sourceClipSegments.length} source_clip segments to job card ${jobId}`);
    }
  }

  persistedJobs[jobId] = { ...card, savedAt: new Date().toISOString() };
  // Keep global ref in sync so assembly.js Gate 2 bypass can read card state
  if (global.persistedJobsRef) global.persistedJobsRef[jobId] = persistedJobs[jobId];
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
  // ── SQLite write (additive — runs alongside JSON during transition) ──────────
  try {
    db.saveJob(jobId, persistedJobs[jobId]);
  } catch (e) {
    console.error('[db] Failed to save job to SQLite:', e.message);
  }
}

// ── markJobStuck() — Mark a job as stuck and trigger auto-disable pattern check ──
// Called when a job fails hard gates (Gate 0, Gate 1, Gate 3) after max retries.
// Sets card.status = 'stuck', card.stuckAt = gate, card.stuckReason = reason (human-readable).
// Logs to errors.jsonl and checks if content type should be auto-disabled (3 stuck jobs in 24h).
function markJobStuck(jobId, gate, reason, detail = {}) {
  const card = persistedJobs[jobId];
  if (!card) {
    console.error(`[markJobStuck] Job ${jobId} not found in persistedJobs`);
    return;
  }

  card.status = 'stuck';
  card.stuckAt = gate;
  card.stuckReason = reason;
  card.stuckDetail = detail;
  card.stuckTimestamp = new Date().toISOString();

  console.log(`[markJobStuck:${jobId}] 🚨 STUCK at ${gate}: ${reason}`);

  // Persist the stuck card
  saveJobCard(jobId, card);

  // Log to errors.jsonl for audit trail
  logError(jobId, gate, reason, detail);

  // Check if this content type should be auto-disabled (3 stuck jobs in 24h)
  const contentType = card.contentType || 'twitch';
  checkContentTypeStuckPattern(contentType, jobId);
}

// ── checkContentTypeStuckPattern() — Auto-disable content type after 3 stuck jobs in 24h ──
// Maintains in-memory counter of stuck jobs per content type.
// If 3+ stuck jobs in 24h window, auto-disable the content type to prevent wasted API spend.
// Operator can re-enable via dashboard after fixing root cause.
const stuckPatternLog = {}; // { contentType: [timestamp1, timestamp2, ...] }

function checkContentTypeStuckPattern(contentType, jobId) {
  const now = Date.now();
  const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
  const THRESHOLD = 3; // 3 stuck jobs triggers auto-disable

  // Initialize log for this content type if needed
  if (!stuckPatternLog[contentType]) {
    stuckPatternLog[contentType] = [];
  }

  // Prune entries older than 24h
  stuckPatternLog[contentType] = stuckPatternLog[contentType].filter(ts => now - ts < WINDOW_MS);

  // Add this stuck job
  stuckPatternLog[contentType].push(now);

  const stuckCount = stuckPatternLog[contentType].length;
  console.log(`[checkContentTypeStuckPattern] ${contentType}: ${stuckCount} stuck jobs in last 24h`);

  if (stuckCount >= THRESHOLD) {
    // Auto-disable this content type
    if (!global.disabledContentTypes) {
      global.disabledContentTypes = {};
    }

    const disabledAt = new Date().toISOString();
    const reason = `Auto-disabled: ${stuckCount} stuck jobs in 24h (last: ${jobId})`;
    
    global.disabledContentTypes[contentType] = {
      disabledAt,
      reason,
      stuckCount,
      lastJobId: jobId
    };

    console.error(`[checkContentTypeStuckPattern] 🚫 AUTO-DISABLED ${contentType}: ${reason}`);
    
    // Log to errors.jsonl
    logError('SYSTEM', 'AUTO_DISABLE', reason, { contentType, stuckCount, jobId });
  }
}

// ── Active poller registry — tracks in-flight HeyGen pollers for graceful shutdown ──
// On SIGTERM (nodemon restart or kill), we wait up to 35s for the current poll to finish
// so the job card is written to disk before the process exits. The startup resume then
// picks up exactly where we left off on the next boot.
const activePollers = new Map(); // jobId → { jobId, resolve, settled }

function registerPoller(jobId) {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  activePollers.set(jobId, { jobId, resolve, done });
  return resolve; // caller calls resolve() when the poller exits cleanly
}

function unregisterPoller(jobId) {
  const entry = activePollers.get(jobId);
  if (entry) { entry.resolve(); activePollers.delete(jobId); }
}

// Graceful shutdown — wait for active pollers before exiting
// gracefulShutdown defined later — single implementation handles pollers + assembly

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

  // Sim mode / pre-completed jobs: skip external polling, emit directly.
  const allAlreadyComplete = videoJobs.every(vj => vj.status === 'completed' && vj.video_url);
  if (allAlreadyComplete) {
    console.log(`[heygen-poller:${jobId}] ⏭️ All segments already completed (sim/local) — emitting heygen:all_complete`);
    try {
      pipelineBus.emit('heygen:poll_terminal', {
        jobId,
        outcome: 'skipped_external_poll',
        reason: 'all_segments_already_complete'
      });
    } catch (_e) { /* non-fatal */ }
    const sortedAvatarSegs = [...videoJobs]
      .filter(vj => vj.video_url)
      .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
    const avatarByName = {};
    for (const seg of sortedAvatarSegs) avatarByName[seg.sceneName] = seg;

    const orderedClipUrls = card.orderedClipUrls || [];
    const scriptScenes = card.script?.scenes || [];
    const segmentData = [];
    let clipIdx = 0;
    if (scriptScenes.length > 0) {
      for (const scene of scriptScenes) {
        if (scene.type === 'source_clip') {
          const clip = orderedClipUrls[clipIdx++];
          if (clip && (clip.url || clip.clipUrl)) {
            segmentData.push({
              url:             clip.clipUrl || clip.url || '',
              pageUrl:         clip.pageUrl || '',
              label:           clip.label || scene.name || `CLIP_${clipIdx}`,
              type:            'source_clip',
              clipUrl:         clip.clipUrl || clip.url || '',
              pillarboxFilter: clip.pillarboxFilter || null,
              orientation:     clip.orientation || 'portrait',
              clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
              clipTimingFormat: clip.clipTimingFormat || 'none'
            });
          }
        } else {
          const sceneKey = scene.name || scene.id;
          const avatarSeg = avatarByName[sceneKey];
          if (avatarSeg && avatarSeg.video_url) {
            segmentData.push({ url: avatarSeg.video_url, label: avatarSeg.sceneName, type: 'avatar' });
            if (scene.hasClipInsert) {
              const clip = orderedClipUrls[clipIdx++];
              if (clip && (clip.url || clip.clipUrl)) {
                segmentData.push({
                  url:             clip.clipUrl || clip.url || '',
                  pageUrl:         clip.pageUrl || '',
                  label:           clip.label || `${sceneKey}_CLIP`,
                  type:            'source_clip',
                  clipUrl:         clip.clipUrl || clip.url || '',
                  pillarboxFilter: clip.pillarboxFilter || null,
                  orientation:     clip.orientation || 'portrait',
                  clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
                  clipTimingFormat: clip.clipTimingFormat || 'none'
                });
              }
            }
          }
        }
      }
    } else {
      for (const s of sortedAvatarSegs) segmentData.push({ url: s.video_url, label: s.sceneName, type: 'avatar' });
    }
    const updatedCard = persistedJobs[jobId] || card;
    updatedCard.heygen = updatedCard.heygen || {};
    updatedCard.heygen.videoJobs = videoJobs;
    updatedCard.stage = 'all_sent';
    saveJobCard(jobId, updatedCard);
    if (shouldUseManualCheckpoint(updatedCard)) {
      const man = writeManualManifest(jobId, updatedCard, segmentData);
      const { dir, manifestPath, manifest, overlaysDir, overlaysReadme, copiedPreviews, operatorGuideDir } = man;
      let prefetch = { logPath: path.join(dir, 'source_clip_prefetch.log') };
      try {
        prefetch = await prefetchManualSourceClips(dir, segmentData, { jobId });
      } catch (e) {
        console.error(`[heygen-poller:${jobId}] source clip prefetch failed (non-fatal): ${e.message}`);
      }
      updatedCard.stage = 'awaiting_manual_segments';
      updatedCard.manualSegments = {
        enabled: true,
        status: 'awaiting_upload',
        manualDir: dir,
        manifestPath,
        operatorGuideDir,
        sourceClipPrefetchLogPath: prefetch.logPath,
        overlaysDir,
        overlaysReadme,
        overlayPreviewCopies: copiedPreviews || [],
        segmentCount: manifest.segments.length,
        requestedAt: new Date().toISOString()
      };
      saveJobCard(jobId, updatedCard);
      console.log(`[heygen-poller:${jobId}] 🛑 c0 manual checkpoint — ${dir} (see read_me/) — resume POST /job/${jobId}/manual-segments/resume`);
      unregisterPoller(jobId);
      return;
    }
    const segmentUrls = sortedAvatarSegs.map(s => s.video_url).filter(Boolean);
    pipelineBus.emit('heygen:all_complete', {
      jobId,
      contentType: card.contentType || 'twitch',
      segmentUrls,
      card: updatedCard,
      segmentData
    });
    return;
  }

  const POLL_INTERVAL_MS = 30000; // 30 seconds between polls
  const MAX_POLL_MINUTES = 60;    // Give up after 60 minutes (safety net)
  const MAX_POLLS = (MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS;
  let pollCount = 0;

  // Register with graceful shutdown tracker
  const pollerDone = registerPoller(jobId);

  console.log(`[heygen-poller:${jobId}] 🔄 Starting — polling ${videoJobs.length} segments every 30s (max ${MAX_POLL_MINUTES}min)`);
  nrEvent('HeyGenPollStart', {
    jobId,
    executionMode: 'inline',
    segmentCount: videoJobs.length,
    contentType: card.contentType || 'twitch',
    maxPollMinutes: MAX_POLL_MINUTES
  });

  // Seed pending rows in heygen_renders DB table for each video job (non-fatal)
  try {
    const { saveHeyGenRender } = require('./lib/db');
    for (const vj of videoJobs) {
      if (vj.video_id) saveHeyGenRender(jobId, vj.video_id, vj.sceneName, 'pending', {});
    }
  } catch(e) {}

  // Seed pending rows in heygen_renders DB table for each video job (non-fatal)
  try {
    const { saveHeyGenRender } = require('./lib/db');
    for (const vj of videoJobs) {
      if (vj.video_id) saveHeyGenRender(jobId, vj.video_id, vj.sceneName, 'pending', {});
    }
  } catch(e) {}

  const poll = async () => {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      console.error(`[heygen-poller:${jobId}] ⏰ Timeout after ${MAX_POLL_MINUTES}min — giving up. Manual REFRESH IDs + ASSEMBLE required.`);
      nrEvent('HeyGenPollTimeout', { jobId, pollCount, segmentCount: videoJobs.length, contentType: card.contentType || 'twitch' });
      try {
        pipelineBus.emit('heygen:poll_terminal', {
          jobId,
          outcome: 'timeout',
          reason: 'max_polls_exceeded'
        });
      } catch (_e) { /* non-fatal */ }
      unregisterPoller(jobId);
      return;
    }

    try {
      // Check status of all video IDs in parallel
      const statuses = await Promise.all(videoJobs.map(async (job) => {
        try {
          const resp = await axios.get(
            `https://api.heygen.com/v3/videos/${job.video_id}`,
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

      // Detect silent placeholder renders: source_clip scenes submitted to HeyGen produce 5s silent videos.
      // Flag them in logs so we can diagnose — they will be excluded at segmentData build time (type: source_clip skipped).
      const silentSuspects = completed.filter(s => {
        const name = (s.sceneName || '').toUpperCase();
        return name.includes('_CLIP') && !name.includes('_CLIP1') && !name.includes('_CLIP2') && !name.includes('_CLIP3') && !name.includes('SETUP') && !name.includes('REACTION') && !name.includes('RECAP');
      });
      if (silentSuspects.length > 0) {
        console.warn(`[heygen-poller:${jobId}] ⚠️  SILENT RENDER DETECTED: ${silentSuspects.map(s => s.sceneName).join(', ')} — these are source_clip scenes that should not have been submitted to HeyGen. They will be excluded from assembly. Check parseSegments_v2 or sendScriptToHeyGen for source_clip skip logic.`);
      }

      // Persist completed/failed render statuses to DB (non-fatal)
      try {
        const { saveHeyGenRender } = require('./lib/db');
        for (const s of statuses) {
          if (s.status === 'completed' || s.status === 'failed') {
            saveHeyGenRender(jobId, s.video_id, s.sceneName, s.status,
              s.status === 'completed' ? { videoUrl: s.video_url } : {});
          }
        }
      } catch(e) {}

      console.log(`[heygen-poller:${jobId}] Poll ${pollCount}: ${completed.length}/${videoJobs.length} completed, ${pending.length} pending, ${failed.length} failed`);
      nrEvent('HeyGenPollTick', {
        jobId,
        pollCount,
        completed: completed.length,
        pending: pending.length,
        failed: failed.length,
        total: videoJobs.length,
        contentType: card.contentType || 'twitch'
      });
      try {
        pipelineBus.emit('heygen:poll_tick', {
          jobId,
          attempt: pollCount,
          allComplete: completed.length === videoJobs.length,
          pending: pending.length,
          failed: failed.length,
          total: videoJobs.length
        });
      } catch (_e) { /* non-fatal */ }

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

      // Build avatar lookup by sceneName for fast access
      const avatarByName = {};
      for (const seg of sortedAvatarSegs) {
        avatarByName[seg.sceneName] = seg;
      }

      // Build the interleaved segmentData array using the SCRIPT as the source of truth.
      // Script scenes define order and clip positions. HeyGen provides audio/video for avatar scenes.
      // source_clip scenes in the script are NOT sent to HeyGen — clips come from orderedClipUrls.
      const orderedClipUrls = card.orderedClipUrls || [];
      const scriptScenes = card.script?.scenes || [];
      const segmentData = [];
      let clipIdx = 0;

      if (scriptScenes.length > 0) {
        // Script-driven build: walk scenes in script order
        for (const scene of scriptScenes) {
          if (scene.type === 'source_clip') {
            // Insert source clip from orderedClipUrls in order
            const clip = orderedClipUrls[clipIdx];
            clipIdx++;
            if (clip && (clip.url || clip.clipUrl)) {
              segmentData.push({
                url:             clip.clipUrl || clip.url || '',
                pageUrl:         clip.pageUrl || '',
                label:           clip.label || scene.name || `CLIP_${clipIdx}`,
                type:            'source_clip',
                clipUrl:         clip.clipUrl || clip.url || '',
                pillarboxFilter: clip.pillarboxFilter || null,
                orientation:     clip.orientation || 'portrait',
                clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
                clipTimingFormat: clip.clipTimingFormat || 'none'
              });
            }
          } else {
            // Avatar scene — find matching HeyGen render
            const sceneKey = scene.name || scene.id;
            const avatarSeg = avatarByName[sceneKey] || Object.values(avatarByName).find(v => v.sceneName === sceneKey);
            if (avatarSeg && avatarSeg.video_url) {
              segmentData.push({
                url:   avatarSeg.video_url,
                label: avatarSeg.sceneName,
                type:  'avatar'
              });
              // SETUP scene: has clip insert after dialogue — insert source_clip from orderedClipUrls
              if (scene.hasClipInsert) {
                const clip = orderedClipUrls[clipIdx];
                clipIdx++;
                if (clip && (clip.url || clip.clipUrl)) {
                  segmentData.push({
                    url:             clip.clipUrl || clip.url || '',
                    pageUrl:         clip.pageUrl || '',
                    label:           clip.label || `${sceneKey}_CLIP`,
                    type:            'source_clip',
                    clipUrl:         clip.clipUrl || clip.url || '',
                    pillarboxFilter: clip.pillarboxFilter || null,
                    orientation:     clip.orientation || 'portrait',
                    clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
                    clipTimingFormat: clip.clipTimingFormat || 'none'
                  });
                }
              }
            }
          }
        }
      } else {
        // Fallback: legacy avatar-only build (no script — old jobs)
        for (const avatarSeg of sortedAvatarSegs) {
          segmentData.push({
            url:   avatarSeg.video_url,
            label: avatarSeg.sceneName,
            type:  'avatar'
          });
        }
      }

      // Attach cardData to INTRO segments in segmentData (works for both script-driven and legacy paths)
      for (const avatarSeg of sortedAvatarSegs) {
        const seg = segmentData.find(s => s.label === avatarSeg.sceneName && s.type === 'avatar');
        if (!seg) continue;

        const _sceneName = avatarSeg.sceneName || '';
        const _ct = card.contentType || 'twitch';
        if (_ct === 'news' && /STORY(\d+)_INTRO/i.test(_sceneName)) {
          const storyMatch = _sceneName.match(/STORY(\d+)_INTRO/i);
          const storyIdx   = storyMatch ? parseInt(storyMatch[1], 10) - 1 : -1;
          const storyItem  = (card.newsItems || [])[storyIdx];
          if (storyItem) {
            seg.cardData = {
              title:        storyItem.title    || `Story ${storyIdx + 1}`,
              category:     storyItem.category || 'WORLD NEWS',
              storyId:      `story_${storyIdx + 1}`,
              imageUrl:     storyItem.thumbnailUrl || storyItem.imageUrl || null,
              heroImageUrl: storyItem.heroImageUrl || storyItem.thumbnailUrl || null,
              source:       storyItem.source || ''
            };
          }
        } else if (_ct === 'nba' && /GAME(\d+)[_ ].*INTRO/i.test(_sceneName)) {
          const gameMatch = _sceneName.match(/GAME(\d+)/i);
          const gameIdx   = gameMatch ? parseInt(gameMatch[1], 10) - 1 : 0;
          const rawName   = _sceneName.replace(/^GAME\d+[_ ]/i,'').replace(/[_ ]INTRO$/i,'').replace(/_/g,' ');
          const nbaItem   = (card.nbaItems || [])[gameIdx];
          seg.cardData = {
            title:    nbaItem?.title || nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
            matchup:  nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
            category: 'NBA GAME',
            storyId:  `game_${gameIdx + 1}`,
            gameId:   nbaItem?.gameId || null
          };
        } else if (_ct === 'twitch' && /[_ ]INTRO$/i.test(_sceneName)) {
          const namePart = _sceneName.replace(/[_ ]INTRO$/i,'').replace(/_/g,' ').toLowerCase();
          const streamer = (card.streamers || []).find(s =>
            (s.displayName||'').toLowerCase() === namePart ||
            (s.twitchUsername||'').toLowerCase() === namePart
          ) || (card.streamers||[])[0];
          if (streamer) {
            seg.cardData = {
              title:    streamer.displayName || namePart,
              category: 'ON STREAM',
              storyId:  `streamer_${namePart.replace(/\s+/g,'_')}`,
              fact:     [streamer.origin, streamer.fact].filter(Boolean).join(' · ').slice(0,60),
              imageUrl: streamer.profileImage || null,
              twitchUsername: streamer.twitchUsername || streamer.username || null
            };
          }
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
      if (shouldUseManualCheckpoint(updatedCard)) {
        const man = writeManualManifest(jobId, updatedCard, segmentData);
        const { dir, manifestPath, manifest, overlaysDir, overlaysReadme, copiedPreviews, operatorGuideDir } = man;
        let prefetch = { logPath: path.join(dir, 'source_clip_prefetch.log') };
        try {
          prefetch = await prefetchManualSourceClips(dir, segmentData, { jobId });
        } catch (e) {
          console.error(`[heygen-poller:${jobId}] source clip prefetch failed (non-fatal): ${e.message}`);
        }
        updatedCard.stage = 'awaiting_manual_segments';
        updatedCard.manualSegments = {
          enabled: true,
          status: 'awaiting_upload',
          manualDir: dir,
          manifestPath,
          operatorGuideDir,
          sourceClipPrefetchLogPath: prefetch.logPath,
          overlaysDir,
          overlaysReadme,
          overlayPreviewCopies: copiedPreviews || [],
          segmentCount: manifest.segments.length,
          requestedAt: new Date().toISOString()
        };
        saveJobCard(jobId, updatedCard);
        try {
          pipelineBus.emit('heygen:poll_terminal', {
            jobId,
            outcome: 'manual_checkpoint_waiting',
            reason: 'c0_manual_segment_hold'
          });
        } catch (_e) { /* non-fatal */ }
        console.log(`[heygen-poller:${jobId}] 🛑 c0 manual checkpoint — ${dir} (see read_me/) — resume POST /job/${jobId}/manual-segments/resume`);
        unregisterPoller(jobId);
        return;
      }

      // ── Emit pipeline event — Gate 2 QA + assembly handled by pipelineBus listener ──
      const segmentUrls = sortedAvatarSegs.map(s => s.video_url).filter(Boolean);
      nrEvent('HeyGenSegmentsReady', {
        jobId,
        contentType: card.contentType || 'twitch',
        segmentCount: videoJobs.length,
        segmentUrlCount: segmentUrls.length
      });
      try {
        pipelineBus.emit('heygen:poll_terminal', {
          jobId,
          outcome: 'all_segments_ready',
          reason: null
        });
      } catch (_e) { /* non-fatal */ }
      pipelineBus.emit('heygen:all_complete', {
        jobId,
        contentType: card.contentType || 'twitch',
        segmentUrls,
        card: updatedCard,
        segmentData
      });
      unregisterPoller(jobId);
      console.log(`[heygen-poller:${jobId}] 📡 heygen:all_complete emitted — Gate 2 + assembly handed off to pipeline bus`);
      return; // poller's job is done — pipelineBus listener owns Gate 2 + assembly

    } catch(pollErr) {
      console.error(`[heygen-poller:${jobId}] Poll error: ${pollErr.message} — retrying in 30s`);
      setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  // Start first poll after 30s (give HeyGen time to begin processing)
  setTimeout(poll, POLL_INTERVAL_MS);
}

// NOTE: GET /jobs endpoint is registered after app is initialized (see below near line 796+)

// ── Startup: Resume in-flight HeyGen pollers after server restart ─────────────
// nodemon or any crash kills in-memory pollers. On boot, scan persistedJobs for jobs that
// were actively polling HeyGen (all_sent stage, not yet assembled) and restart the poller.
// This is fire-and-forget — the poller handles its own timeout/failure.
setImmediate(() => {
  // Safety: only resume jobs that were legitimately in-flight.
  // MAX_RESUME_POLLERS prevents the 35-poller flood that burned 390 HeyGen credits.
  const MAX_RESUME_POLLERS = 2;
  let resumed = 0;

  const ALL_SENT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // only resume pollers for jobs created in last 24h
  const candidates = Object.entries(persistedJobs).filter(([jobId, card]) => {
    if ((card.status || '') === 'dismissed') return false;
    const stage = card.stage || inferJobStage(card);
    // Never re-trigger assembly for jobs that already finished — this was causing
    // assembled jobs to oscillate back to all_sent on every server restart.
    if (stage === 'assembled' || stage === 'published' || stage === 'gate5_forced') return false;
    if (stage !== 'all_sent') return false;
    const videoJobs = card.heygen?.videoJobs || [];
    if (!videoJobs.length) return false;
    // Skip if a poller is already running for this job (shouldn't happen at startup but guard anyway)
    if (activePollers.has(jobId)) return false;
    // Skip stale jobs — don't resume HeyGen pollers for jobs older than 24h
    const createdAt = card.createdAt ? new Date(card.createdAt).getTime() : 0;
    if (createdAt && (Date.now() - createdAt) > ALL_SENT_MAX_AGE_MS) return false;
    return true;
  });

  if (candidates.length > MAX_RESUME_POLLERS) {
    console.warn(`[startup-resume] ⚠️  ${candidates.length} jobs eligible for resume — capping at ${MAX_RESUME_POLLERS} to prevent HeyGen flood. Remaining ${candidates.length - MAX_RESUME_POLLERS} jobs need manual re-trigger from dashboard.`);
  }

  const toResume = candidates.slice(0, MAX_RESUME_POLLERS);

  for (const [jobId, card] of toResume) {
    const videoJobs = card.heygen?.videoJobs || [];
    const allComplete = videoJobs.every(vj => vj.status === 'completed' && vj.video_url);
    if (allComplete) {
      console.log(`[startup-resume:${jobId}] All segments already completed — emitting heygen:all_complete`);
      const contentType = card.contentType || 'twitch';
      const formType = card.formType || 'compilation';
      const segmentUrls = videoJobs.filter(vj => vj.video_url).map(vj => vj.video_url);
      setTimeout(() => {
        try {
          pipelineBus.emit('heygen:poll_terminal', {
            jobId,
            outcome: 'all_segments_ready',
            reason: 'startup_resume_card_complete'
          });
        } catch (_e) { /* non-fatal */ }
        pipelineBus.emit('heygen:all_complete', {
          jobId, contentType, formType, segmentUrls, card, segmentData: null
        });
      }, 2000);
    } else {
      console.log(`[startup-resume:${jobId}] Resuming HeyGen poller (${videoJobs.length} segments, not all complete)`);
      startHeyGenPoller(jobId, card).catch(e => {
        console.error(`[startup-resume:${jobId}] Poller error: ${e.message}`);
      });
    }
    resumed++;
  }

  if (resumed > 0) {
    console.log(`[startup-resume] Resumed ${resumed} in-flight job(s) (cap: ${MAX_RESUME_POLLERS})`);
  }

  // ── script_ready jobs: DO NOT auto-send on startup ────────────────────────────
  // script_ready means Gate 1 passed and the script is waiting for operator review.
  // Auto-sending on restart burns HeyGen credits without operator approval.
  // Operator must explicitly click SEND TO HEYGEN in the dashboard.
  const scriptReadyCount = Object.values(persistedJobs).filter(card => {
    if ((card.status || '') === 'dismissed') return false;
    return (card.stage || inferJobStage(card)) === 'script_ready';
  }).length;
  if (scriptReadyCount > 0) {
    console.log(`[startup-resume] ${scriptReadyCount} script_ready job(s) found — NOT auto-sending (operator must click SEND TO HEYGEN)`);
  }
});

// ── Pipeline Bus: heygen:all_complete → Gate 2 QA → assembly ─────────────────
// The HeyGen poller emits this when all segments are done.
// This listener owns Gate 2 QA + logging + assembly trigger + assembly completion polling.
// Dashboard is view-only — it reads persistedJobs, never drives this flow.
pipelineBus.on('thumbnail:uploaded', ({ jobId, thumbnailDriveUrl }) => {
  if (!jobId || !thumbnailDriveUrl) return;
  const card = persistedJobs[jobId];
  if (card) {
    card.thumbnailDriveUrl = thumbnailDriveUrl;
    card.state = card.state || {};
    card.state.savedOutputs = card.state.savedOutputs || {};
    card.state.savedOutputs.thumbnailDriveUrl = thumbnailDriveUrl;
    saveJobCard(jobId, card);
    console.log(`[thumbnail:uploaded] Saved thumbnailDriveUrl to job card ${jobId}`);
  }
});

// CPD-936: assembly held Gate 5 for a scheduled publish — persist the hold state
// (stage/driveUrl/publishCopy/thumbnail) so a restart during the hold window
// doesn't strand the job (cron used to fire with no driveUrl on the reloaded card).
pipelineBus.on('gate5:scheduled_hold', ({ jobId, driveUrl, scheduledAt, publishCopy, thumbnailDriveUrl }) => {
  if (!jobId) return;
  const card = persistedJobs[jobId];
  if (!card) {
    console.warn(`[gate5:scheduled_hold] No card for ${jobId} — hold state NOT persisted`);
    return;
  }
  card.stage = 'publish_scheduled';
  if (driveUrl) card.driveUrl = driveUrl;
  if (scheduledAt) card.scheduledPublishAt = scheduledAt;
  card.state = card.state || {};
  card.state.savedOutputs = card.state.savedOutputs || {};
  if (driveUrl) card.state.savedOutputs.driveUrl = driveUrl;
  if (publishCopy) {
    card.publishCopy = publishCopy;
    card.state.savedOutputs.publishCopy = publishCopy;
  }
  if (thumbnailDriveUrl) {
    card.thumbnailDriveUrl = thumbnailDriveUrl;
    card.state.savedOutputs.thumbnailDriveUrl = thumbnailDriveUrl;
  }
  saveJobCard(jobId, card);
  console.log(`[gate5:scheduled_hold] Persisted hold state for ${jobId} (driveUrl=${!!driveUrl}, publishCopy=${!!publishCopy}, due=${scheduledAt})`);
});

pipelineBus.on('heygen:all_complete', async ({ jobId, contentType, segmentUrls, card, segmentData: rawSegmentData }) => {
  // Concurrent job isolation guard: verify the card in persistedJobs matches the event's jobId
  // and contentType. If a concurrent job mutated persistedJobs[jobId] with the wrong contentType,
  // this guard aborts before assembly uses mismatched context (e.g. long-form assembled as short-form).
  const _liveCard = persistedJobs[jobId];
  if (_liveCard && _liveCard.contentType && _liveCard.contentType !== contentType) {
    logger.error({ jobId, eventContentType: contentType, cardContentType: _liveCard.contentType },
      'heygen:all_complete — contentType mismatch between event and persistedJobs card. Aborting assembly to prevent cross-job contamination.');
    return;
  }

  // Rebuild segmentData from card if null (e.g. emitted by startup resume after server restart)
  let segmentData = rawSegmentData;
  if (!segmentData) {
    const segCard = _liveCard || card;
    if (shouldUseManualCheckpoint(segCard) && segCard.manualSegments?.holdKind === 'immediate') {
      const { buildManualHoldSegmentData } = require('./lib/manual_segment_workflow');
      segmentData = buildManualHoldSegmentData(segCard);
      const avatarCount = segmentData.filter(s => s.type === 'avatar').length;
      const clipCount = segmentData.filter(s => s.type === 'source_clip').length;
      logger.warn(
        { jobId, avatarCount, clipCount },
        'heygen:all_complete — segmentData from c0 immediate manual template (no HeyGen avatar URLs)'
      );
    } else {
    const videoJobs = segCard.heygen?.videoJobs || [];
    const sourceClips = segCard.sourceClipSegments || [];

    // Build avatar lookup by sceneName for fast access
    const avatarByName = {};
    for (const vj of videoJobs) {
      if (vj.status === 'completed' && vj.video_url) {
        avatarByName[vj.sceneName] = vj;
      }
    }

    // Use the script's scene order as the merge template so clips land in the right positions
    const scriptScenes = segCard.script?.scenes || [];
    if (scriptScenes.length > 0) {
      let clipIdx = 0;
      segmentData = [];
      for (const scene of scriptScenes) {
        if (scene.type === 'source_clip') {
          // Explicit source_clip scenes (news, short-form)
          const clip = sourceClips[clipIdx] || segCard.orderedClipUrls?.[clipIdx];
          if (clip) {
            segmentData.push({
              type:            'source_clip',
              url:             clip.clipUrl || clip.url || '',
              label:           clip.label || scene.name || scene.id || `CLIP_${clipIdx + 1}`,
              pageUrl:         clip.pageUrl || '',
              pillarboxFilter: clip.pillarboxFilter || null,
              orientation:     clip.orientation || 'portrait',
              clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
              clipTimingFormat: clip.clipTimingFormat || 'none',
              storyIndex:      clip.storyIndex ?? clipIdx,
              sceneId:         scene.name || scene.id
            });
          }
          clipIdx++;
        } else if (scene.type === 'avatar') {
          // Avatar scene
          const sceneKey = scene.name || scene.id;
          const vj = avatarByName[sceneKey] ||
            Object.values(avatarByName).find(v => v.sceneName === sceneKey);
          if (vj) {
            const seg = { type: 'avatar', url: vj.video_url, label: vj.sceneName, sceneIndex: vj.sceneIndex };
            // Attach cardData for INTRO segments — chrome overlay reads this for flag + sidebar
            if (segCard.contentType === 'news' && /STORY(\d+)_INTRO/i.test(vj.sceneName)) {
              const storyMatch = vj.sceneName.match(/STORY(\d+)_INTRO/i);
              const storyIdx = storyMatch ? parseInt(storyMatch[1], 10) - 1 : -1;
              const storyItem = (segCard.newsItems || [])[storyIdx];
              if (storyItem) {
                seg.cardData = {
                  title:        storyItem.title    || `Story ${storyIdx + 1}`,
                  category:     storyItem.category || 'WORLD NEWS',
                  storyId:      `story_${storyIdx + 1}`,
                  imageUrl:     storyItem.thumbnailUrl || storyItem.imageUrl || null,
                  heroImageUrl: storyItem.heroImageUrl || storyItem.thumbnailUrl || null,
                  source:       storyItem.source || ''
                };
              }
            } else if (segCard.contentType === 'nba' && /GAME(\d+)[_ ].*INTRO/i.test(vj.sceneName)) {
              // NBA: attach game matchup data to INTRO segments for flag + sidebar
              const gameMatch = vj.sceneName.match(/GAME(\d+)/i);
              const gameIdx = gameMatch ? parseInt(gameMatch[1], 10) - 1 : 0;
              // Extract matchup from scene name: GAME1_CHARLOTTE_HORNETS_ORLANDO_MAGIC_INTRO
              const rawName = vj.sceneName.replace(/^GAME\d+[_ ]/i, '').replace(/[_ ]INTRO$/i, '').replace(/_/g, ' ');
              const nbaItem = (segCard.nbaItems || [])[gameIdx];
              seg.cardData = {
                title:   nbaItem?.title || nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
                matchup: nbaItem?.matchup || rawName || `Game ${gameIdx + 1}`,
                category: 'NBA GAME',
                storyId:  `game_${gameIdx + 1}`,
                gameId:   nbaItem?.gameId || null
              };
            } else if (segCard.contentType === 'twitch' && /[_ ]INTRO$/i.test(vj.sceneName)) {
              // Twitch: attach streamer data to INTRO segments for sidebar
              const namePart = vj.sceneName.replace(/[_ ]INTRO$/i, '').replace(/_/g, ' ').toLowerCase();
              const streamer = (segCard.streamers || []).find(s =>
                (s.displayName || '').toLowerCase() === namePart ||
                (s.twitchUsername || '').toLowerCase() === namePart
              ) || (segCard.streamers || [])[0];
              if (streamer) {
                seg.cardData = {
                  title:    streamer.displayName || namePart,
                  category: 'ON STREAM',
                  storyId:  `streamer_${namePart.replace(/\s+/g,'_')}`,
                  fact:     [streamer.origin, streamer.fact].filter(Boolean).join(' · ').slice(0, 60),
                  imageUrl: streamer.profileImage || null,
                  twitchUsername: streamer.twitchUsername || streamer.username || null
                };
              }
            }
            segmentData.push(seg);

            // SETUP-style clip insert (NBA/Twitch long-form): avatar + source_clip
            if (scene.hasClipInsert) {
              const clip = sourceClips[clipIdx] || segCard.orderedClipUrls?.[clipIdx];
              if (clip) {
                segmentData.push({
                  type:            'source_clip',
                  url:             clip.clipUrl || clip.url || '',
                  label:           clip.label || `${sceneKey}_CLIP`,
                  pageUrl:         clip.pageUrl || '',
                  pillarboxFilter: clip.pillarboxFilter || null,
                  orientation:     clip.orientation || 'portrait',
                  clipTimingTargets: Array.isArray(clip.clipTimingTargets) ? clip.clipTimingTargets : [],
                  clipTimingFormat: clip.clipTimingFormat || 'none',
                  storyIndex: clip.storyIndex ?? clipIdx,
                  sceneId: scene.name || scene.id
                });
              }
              clipIdx++;
            }
          }
        }
      }
    } else {
      // No script scenes — fall back to avatar-only in sceneIndex order
      segmentData = videoJobs
        .filter(vj => vj.status === 'completed' && vj.video_url)
        .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0))
        .map(vj => ({ type: 'avatar', url: vj.video_url, label: vj.sceneName, sceneIndex: vj.sceneIndex }));
    }

    const avatarCount = segmentData.filter(s => s.type === 'avatar').length;
    const clipCount   = segmentData.filter(s => s.type === 'source_clip').length;
    logger.warn({ jobId, avatarCount, clipCount }, 'heygen:all_complete — segmentData rebuilt from card (startup resume)');
    }
  }

  {
    const manualApplied = applyManualOverrides(jobId, segmentData || []);
    segmentData = manualApplied.segmentData;
    if (manualApplied.overrideCount > 0) {
      logger.info(
        { jobId, overrideCount: manualApplied.overrideCount, manualDir: manualApplied.dir },
        'heygen:all_complete — using manual segment overrides from /tmp'
      );
    }
  }

  logger.info({ jobId, contentType, segmentCount: segmentUrls.length }, 'heygen:all_complete — running Gate 2');
  nrEvent('PipelineHeyGenComplete', {
    jobId,
    contentType,
    customerId: (card && card.customerId) || (_liveCard && _liveCard.customerId) || 'c0',
    segmentUrlCount: (segmentUrls || []).length,
    scriptJobId: card.scriptJobId || null,
    jobSpecId: card.jobSpecId || null
  });

  // ── Gate 2: Handled inside assembly.js after segments are downloaded ─────
  // Removed pre-assembly Gate 2 here — segmentUrls are HeyGen video IDs/URLs,
  // not local file paths. fs.existsSync(url) always returns false → score 0.
  // Gate 2 (new gate worker) runs inside handleAssemble() after downloads complete
  // where it has actual local file paths to ffprobe and analyze.
  logger.info({ jobId }, 'heygen:all_complete — skipping pre-assembly Gate 2, assembly.js owns it');

  // ── Pre-warm ticker cache (long-form only) ────────────────────────────────
  if (!contentType.includes('short')) {
    const tickerContentType = contentType.replace(/-short$/, '');
    logger.info({ jobId, tickerContentType }, 'Pre-warming ticker cache');
    try {
      const tickerPath = await captureTicker(tickerContentType);
      if (tickerPath) logger.info({ jobId, tickerPath }, 'Ticker pre-warmed');
      else logger.warn({ jobId }, 'Ticker pre-warm returned null — assembly continues without ticker');
    } catch(e) {
      logger.warn({ jobId, err: e.message }, 'Ticker pre-warm error — continuing');
    }
  }

  // ── Trigger assembly ──────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3000;
  // Assembly ID derived from jobId — survives retries, keeps all gate results linked
  // Retry attempts append _r2, _r3 etc. First attempt uses clean asm_{jobId}
  const _existingAsmId = (persistedJobs[jobId] || card).assemblyId;
  const _retryCount = (persistedJobs[jobId] || card)._assemblyRetryCount || 0;
  const assemblyId = _existingAsmId && _retryCount === 0
    ? _existingAsmId  // reuse on first auto-trigger after server restart
    : `asm_${jobId}${_retryCount > 0 ? `_r${_retryCount + 1}` : ''}`;
  const format = contentType.includes('-short') ? 'portrait' : 'landscape';
  const _cardDate = card.savedAt ? new Date(card.savedAt) : new Date();
  const _dateLabel = _cardDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const _avatarCount = (segmentData || []).filter(s => s.type === 'avatar').length || segmentUrls.length;
  const _clipCount   = (segmentData || []).filter(s => s.type === 'source_clip').length;
  const _humanTitle  = `${contentType.toUpperCase()} ${_dateLabel} (${_avatarCount} avatar + ${_clipCount} clips)`;

  try {
    await axios.post(`http://localhost:${PORT}/assemble`, {
      segments:     (segmentData || []).map(s => s.url),
      segmentData:  segmentData || [],
      labels:       (segmentData || []).map(s => s.label),
      transition:   'crossfade',
      format:       contentType.includes('-short') ? 'portrait' : 'mp4',
      assemblyId,
      jobTitle:     _humanTitle,
      contentType,
      jobId,
      jobSpecId:    card.jobSpecId || null,  // semantic job spec ID for gate workers to load full spec
      sceneTextMap:  card.heygen?.sceneTextMap || null,
      fullScript:    (card.script && card.script.raw) ? card.script.raw : (card.script || null),
      streamers:     card.streamers || [],
      expectedClips: card.expectedClips ?? 0,  // Pipeline contract — Gate 3 asserts this
      designSpec:    card.designSpec || null,
      nbaItems:      card.nbaItems || [],
      captionText:   card.captionText || null,
      captionStyle:  card.captionStyle || null
    }, { timeout: 10000 });

    logger.info({ jobId, assemblyId }, 'Auto-assembly triggered — Gate 3 → Drive will run automatically');
    nrEvent('AssemblyTriggered', {
      jobId,
      assemblyId,
      contentType,
      segmentCount: (segmentData || []).length,
      customerId: (card.customerId || 'c0')
    });
    pipelineBus.emit('assembly:triggered', { jobId, assemblyId });

    const cardNow = persistedJobs[jobId] || card;
    cardNow.assemblyId = assemblyId;
    cardNow.autoAssembledAt = new Date().toISOString();
    cardNow._assemblyRetryCount = (_retryCount || 0) + 1;
    saveJobCard(jobId, cardNow);

    // ── Poll assembly completion → persist final state ────────────────────
    const ASM_POLL_INTERVAL = 15000;
    const ASM_POLL_MAX = 120; // 30 min
    let asmPollCount = 0;
    const pollAssemblyCompletion = () => {
      asmPollCount++;
      const asmJob = assemblyJobs[assemblyId];
      if (!asmJob) {
        if (asmPollCount < ASM_POLL_MAX) setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);
        return;
      }
      const isDone = asmJob.status === 'done' || asmJob.status === 'manual_review' || asmJob.status === 'failed';
      if (!isDone && asmPollCount < ASM_POLL_MAX) { setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL); return; }

      const finalCard = persistedJobs[jobId] || cardNow;
      if (asmJob.status === 'done' || asmJob.status === 'manual_review') {
        finalCard.assembledAt = new Date().toISOString();
        finalCard.stage = 'assembled';
        if (asmJob.outputPath) finalCard.outputPath = asmJob.outputPath;
        // Use driveUrl if available; fall back to local download URL so stage
        // reaches 'assembled' and Approve button appears even when Drive is down.
        const _resolvedUrl = asmJob.driveUrl || asmJob.localUrl || null;
        if (_resolvedUrl) finalCard.finalUrl = _resolvedUrl;
        // Gate 3 = assembly QA (Gemini watches the assembled video)
        if (asmJob.qaScore !== undefined) {
          finalCard.gate3 = {
            score:   asmJob.qaScore,
            outcome: asmJob.qaOutcome || 'manual_review',
            report:  asmJob.qaReport  || '',
            checkedAt: new Date().toISOString()
          };
          if (asmJob.qaOutcome === 'pass' || asmJob.qaOutcome === 'manual_review') {
            finalCard.stage = 'assembled';
          }
        }
        if (asmJob.publishResult) {
          finalCard.publishRecord = { publishedAt: new Date().toISOString(), ...asmJob.publishResult };
          finalCard.stage = 'published';
        }
        saveJobCard(jobId, finalCard);
        logger.info({ jobId, stage: finalCard.stage, gate3Score: asmJob.qaScore || null, driveUrl: asmJob.driveUrl || null }, 'Assembly completion persisted');
        const _cid = finalCard.customerId || 'c0';
        const _durMs = asmJob.duration != null ? Math.round(Number(asmJob.duration) * 1000) : null;
        nrAssemblyComplete(jobId, _cid, contentType, assemblyId, _durMs, asmJob.sizeMB ?? null, asmJob.qaScore ?? null);
        nrEvent('PipelineRunTerminal', {
          jobId,
          assemblyId,
          contentType,
          customerId: _cid,
          stage: finalCard.stage,
          gate3Score: asmJob.qaScore ?? null,
          gate3Outcome: asmJob.qaOutcome || null,
          hasDriveUrl: !!(asmJob.driveUrl || finalCard.finalUrl)
        });
        pipelineBus.emit('gate3:complete', { jobId, score: asmJob.qaScore, outcome: asmJob.qaOutcome });
      } else {
        logger.warn({ jobId, asmStatus: asmJob.status }, 'Assembly ended without done/manual_review — card not updated');
        nrEvent('AssemblyPersistSkipped', {
          jobId,
          assemblyId,
          contentType,
          asmStatus: asmJob.status || 'unknown',
          error: (asmJob.error || '').slice(0, 500)
        });
      }
    };
    setTimeout(pollAssemblyCompletion, ASM_POLL_INTERVAL);

  } catch(assembleErr) {
    logger.error({ jobId, err: assembleErr.message }, 'Auto-assembly POST failed — manual ASSEMBLE required');
    nrEvent('AssemblyTriggerFailed', {
      jobId,
      contentType,
      customerId: (card && card.customerId) || 'c0',
      error: (assembleErr && assembleErr.message) ? String(assembleErr.message).slice(0, 500) : 'unknown'
    });
  }
});

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
function ffmpegPath() { return _ffmpegDockerPath(); }
function ffprobePath() { return _ffprobeDockerPath(); }

function checkFFmpeg(cb) {
  execFile(ffmpegPath(), ['-version'], (err, stdout) => {
    if (err) return cb(new Error('FFmpeg not found or Docker not running.'));
    const versionLine = stdout.split('\n')[0];
    cb(null, versionLine);
  });
}

// Check available disk space before assembly

// ── Build FFmpeg concat filter ─────────────────────────────────────

// Probe clip duration via ffprobe

// ── Routes ────────────────────────────────────────────────────────

// Health check with dependency validation
// GET /episode-counters — read current episode numbers
app.get('/episode-counters', (req, res) => {
  const epPath = path.join(__dirname, 'data', 'episode_counters.json');
  try {
    const data = JSON.parse(fs.readFileSync(epPath, 'utf8'));
    res.json({ ok: true, counters: data });
  } catch(e) {
    res.json({ ok: true, counters: { twitch: 1, nba: 1, news: 1 } });
  }
});

// POST /episode-counters — update episode numbers
app.post('/episode-counters', (req, res) => {
  const { twitch, nba, news } = req.body || {};
  const epPath = path.join(__dirname, 'data', 'episode_counters.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(epPath, 'utf8')); } catch(e) {}
  if (typeof twitch === 'number' && twitch > 0) current.twitch = twitch;
  if (typeof nba    === 'number' && nba    > 0) current.nba    = nba;
  if (typeof news   === 'number' && news   > 0) current.news   = news;
  try {
    fs.writeFileSync(epPath, JSON.stringify(current, null, 2));
    console.log(`[episode-counters] Updated: ${JSON.stringify(current)}`);
    res.json({ ok: true, counters: current });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', async (req, res) => {
  const health = {
    ok: true,
    version: BUILD_INFO.version,
    gitHash: BUILD_INFO.gitHash,
    gitBranch: BUILD_INFO.gitBranch,
    lastCommit: BUILD_INFO.lastCommit,
    deployedAt: BUILD_INFO.deployedAt,
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
  // Only return in-flight jobs. Completed (assembled, published) and
  // failed/dismissed jobs are excluded — they do not need to restore on page load.
  const IN_FLIGHT_STAGES = new Set(['script_ready', 'all_sent', 'awaiting_manual_segments', 'assembling']);

  const actionableJobs = Object.values(persistedJobs).filter(job => {
    const status = job.status || '';
    // Never return dismissed jobs regardless of stage
    if (status === 'dismissed') return false;
    // Infer stage for legacy jobs that don't have the stage field set
    const stage = job.stage || inferJobStage(job);
    // Only return in-flight stages
    return IN_FLIGHT_STAGES.has(stage);
  }).sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));

  const { getJobBySpec } = require('./lib/db');
  const { buildGateStatusSnapshot } = require('./lib/job_spec_contracts');
  const jobsWithGateStatus = actionableJobs.map((job) => {
    const candidates = [job.jobSpecId, job.scriptJobId, job.id].filter(Boolean);
    let spec = null;
    for (const id of candidates) {
      try {
        spec = getJobBySpec(id);
        if (spec) break;
      } catch (_e) {}
    }
    return { ...job, gateStatus: spec ? buildGateStatusSnapshot(spec) : null };
  });

  res.json({ ok: true, count: jobsWithGateStatus.length, jobs: jobsWithGateStatus });
});

// DELETE /job/:id — remove a job from persistedJobs + jobs.json AND kill any active work
// Called by dashboard clearAllJobs() and clearDone() so cleared jobs don't reappear on restore
app.delete('/job/:id', (req, res) => {
  const jobId = req.params.id;
  if (!persistedJobs[jobId]) return res.json({ ok: false, error: 'Job not found: ' + jobId });

  // 1. Stop active HeyGen poller for this job (prevents further polling / credit use)
  if (activePollers.has(jobId)) {
    unregisterPoller(jobId);
    console.log(`[jobs] Killed active HeyGen poller for: ${jobId}`);
  }

  // 2. Mark any running assembly jobs for this job as cancelled
  Object.keys(assemblyJobs).forEach(asmId => {
    if (assemblyJobs[asmId]?.sourceJobId === jobId) {
      assemblyJobs[asmId].status = 'cancelled';
      console.log(`[jobs] Cancelled assembly job ${asmId} for: ${jobId}`);
    }
  });

  // 3. Remove from persisted state
  delete persistedJobs[jobId];
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(persistedJobs, null, 2));
  } catch(e) {
    console.error('[jobs] Failed to save jobs.json after delete:', e.message);
  }

  // 4. Delete from SQLite DB so job doesn't reappear on server restart
  try {
    const { deleteJob } = require('./lib/db');
    if (typeof deleteJob === 'function') deleteJob(jobId);
  } catch(e) {
    // DB delete is best-effort — non-fatal
  }

  console.log(`[jobs] Deleted job: ${jobId}`);
  res.json({ ok: true, deleted: jobId });
});

// ── POST /job/:id/fix-claims (CPD-980) — mute claimed ranges + republish ─────
// Body: { ranges: "12:34-13:10, 45:00-45:40" } (timestamps from the Studio
// claim panel). Mutes those ranges on the job's final video (video stream
// copied) and uploads a clean copy to YouTube as a NEW video. The claimed
// original is left alone — deleting it is the operator's call.
app.post('/job/:id/fix-claims', async (req, res) => {
  const card = persistedJobs[req.params.id];
  if (!card) return res.status(404).json({ ok: false, error: 'Job not found: ' + req.params.id });
  try {
    const { parseTimeRanges, muteAndRepublish } = require('./lib/services/claim_fixer');
    const ranges = parseTimeRanges(req.body?.ranges);
    const out = await muteAndRepublish({
      card, ranges,
      tmpDir: path.join(__dirname, 'tmp'),
      log: (m) => console.log(m),
    });
    try {
      const { savePublishResult } = require('./lib/db');
      savePublishResult(card.id, 'youtube', {
        platformJobId: out.videoId,
        driveUrl: out.url,
        title: card.publishPrep?.title || card.title,
        status: 'published',
      });
    } catch (e) { console.warn('[claim-fixer] publish_results save failed (non-fatal):', e.message); }
    try { fs.unlinkSync(out.mutedPath); } catch (_) {}
    res.json({ ok: true, videoId: out.videoId, url: out.url });
  } catch (e) {
    console.error(`[claim-fixer] ${req.params.id} failed:`, e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
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
    logError('PIPELINE_ROLLBACK', `Job rolled back: published → assembled`, { jobId, before: 'published', after: 'assembled', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'published',
        after: 'assembled',
        message: 'Publish record cleared — re-approve to re-publish.'
      });
    } catch (_e) { /* non-fatal */ }
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
    // Clear assembly dedup lock to allow re-assembly
    Object.keys(assemblyJobs).forEach(asmId => {
      if (assemblyJobs[asmId]?.sourceJobId === jobId) {
        delete assemblyJobs[asmId];
        console.log(`[rollback] ${jobId}: cleared assembly dedup lock for asmId=${asmId}`);
      }
    });
    card.stage = 'all_sent';
    saveJobCard(jobId, card);
    console.log(`[rollback] ${jobId}: assembled → all_sent`);
    logError('PIPELINE_ROLLBACK', `Job rolled back: assembled → all_sent`, { jobId, before: 'assembled', after: 'all_sent', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'assembled',
        after: 'all_sent',
        message: 'Assembly cleared — click REFRESH IDs then ASSEMBLE again.'
      });
    } catch (_e) { /* non-fatal */ }
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
    logError('PIPELINE_ROLLBACK', `Job rolled back: all_sent → script_ready`, { jobId, before: 'all_sent', after: 'script_ready', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:rollback', {
        jobId,
        before: 'all_sent',
        after: 'script_ready',
        message: 'HeyGen IDs cleared — edit script and re-send to HeyGen.'
      });
    } catch (_e) { /* non-fatal */ }
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
    logError('PIPELINE_ADVANCE', `Job force-advanced: script_ready → gate1_forced`, { jobId, before: 'script_ready', after: 'gate1_forced', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'script_ready',
        to: 'gate1_forced',
        message: 'Gate 1 force-passed — SEND TO HEYGEN is now unlocked.'
      });
    } catch (_e) { /* non-fatal */ }
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
    logError('PIPELINE_ADVANCE', `Job force-advanced: all_sent → gate2_forced`, { jobId, before: 'all_sent', after: 'gate2_forced', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'all_sent',
        to: 'gate2_forced',
        message: `Gate 2 force-passed — ${forced} segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE.`
      });
    } catch (_e) { /* non-fatal */ }
    return res.json({ ok: true, jobId, before: 'all_sent', after: 'gate2_forced', message: `Gate 2 force-passed — ${forced} segment(s) marked. Click REFRESH IDs to get real URLs, then ASSEMBLE.` });
  }

  if (stage === 'assembled') {
    // Force-advance: mark stage then kick off server-side Gate 5 automatically.
    // Dashboard no longer needs an APPROVE button — Gate 5 runs the same path as the
    // normal auto-flow (assembly → Gate 4 → Gate 5) just triggered by the operator's
    // force-advance instead of a Gate 4 uploadSignal.
    card.gate5 = card.gate5 || {};
    card.gate5.outcome  = 'force_advance';
    card.gate5.forcedAt = new Date().toISOString();
    card.stage = 'gate5_forced';
    saveJobCard(jobId, card);
    console.log(`[advance] ${jobId}: assembled → gate5_forced → triggering Gate 5`);
    logError('PIPELINE_ADVANCE', `Job force-advanced: assembled → gate5_forced`, { jobId, before: 'assembled', after: 'gate5_forced', at: new Date().toISOString() });
    try {
      pipelineBus.emit('job:advance', {
        jobId,
        from: 'assembled',
        to: 'gate5_forced',
        message: 'Gate 5 triggered automatically — upload to Upload-Post is in progress.'
      });
    } catch (_e) { /* non-fatal */ }

    // Respond immediately so the dashboard doesn't wait; Gate 5 runs async.
    res.json({ ok: true, jobId, before: 'assembled', after: 'gate5_forced', message: 'Gate 5 triggered — upload is in progress. Job will move to "published" when complete.' });

    // Fire Gate 5 async (same logic as POST /job/:id/run-gate5)
    setImmediate(async () => {
      try {
        await _runGate5ForCard(jobId);
      } catch (err) {
        console.error(`[advance] Gate 5 async error for ${jobId}:`, err.message);
      }
    });
    return;
  }

  return res.json({ ok: false, error: `Job is at stage "${stage}" — cannot advance further (already at publish stage or unknown stage).` });
});

// ── Gate 5 helper — builds job spec from saved card and calls gate5.run() ────────────────────
async function _runGate5ForCard(jobId) {
  const gate5Worker = require('./lib/gates/gate5');
  const { readAutoPublishPlatformsEnv } = require('./lib/auto_publish_env');

  const card = persistedJobs[jobId];
  if (!card) throw new Error(`Job not found: ${jobId}`);

  const savedOutputs = card.state?.savedOutputs || {};
  const driveUrl = savedOutputs.driveUrl || card.driveUrl;
  if (!driveUrl) throw new Error(`driveUrl missing for ${jobId} — Drive upload may not have completed`);

  // publishCopy may be in the DB spec's savedOutputs but not yet flushed to the in-memory card
  // (assembly saves it via saveOutput() which writes to DB, but card is in-memory snapshot).
  // Load from DB as fallback so Gate 5 always has the correct title/description.
  // Short-form publish copy has no top-level title — titles nest under
  // platforms.youtube.* (gate5 resolves via publishCopy.platforms?.youtube).
  const _pcUsable = pc => pc && (pc.title || pc.platforms?.youtube || pc.youtube);
  let publishCopy = savedOutputs.publishCopy || card.publishCopy || null;
  if (!_pcUsable(publishCopy)) {
    try {
      const { getJobSpec: _g5GetSpec } = require('./lib/job_spec');
      const _dbSpec = _g5GetSpec(jobId);
      const _dbPc = _dbSpec?.state?.savedOutputs?.publishCopy;
      if (_pcUsable(_dbPc)) publishCopy = _dbPc;
    } catch (_e) { /* non-fatal */ }
  }
  publishCopy = publishCopy || {};
  const thumbnailDriveUrl = savedOutputs.thumbnailDriveUrl || card.thumbnailDriveUrl || null;
  const contentType      = card.contentType || 'news';

  // Resolve platforms: env override → contentTypes.json config → content-type default
  let platforms = readAutoPublishPlatformsEnv();
  if (!platforms) {
    try {
      const cfg = require('./config/contentTypes.json');
      platforms = cfg.contentTypes?.[contentType]?.publish?.platforms || null;
    } catch (_e) { /* non-fatal */ }
  }
  if (!platforms || !platforms.length) {
    const isShort = contentType.includes('short');
    platforms = isShort ? ['youtube', 'tiktok', 'instagram'] : ['youtube'];
  }

  const g5JobSpec = {
    jobId,
    contentType,
    driveUrl,
    state: {
      ...(card.state || {}),
      savedOutputs: { ...savedOutputs, publishCopy, thumbnailDriveUrl }
    },
    // A card deliverySpec without platforms (e.g. created by /job/:id/schedule)
    // must not defeat the platform fallback — merge defaults underneath it.
    deliverySpec: (card.deliverySpec && Array.isArray(card.deliverySpec.platforms) && card.deliverySpec.platforms.length)
      ? card.deliverySpec
      : {
          driveFolderId: process.env.DRIVE_FOLDER_ID || null,
          uploadPostProfile: process.env.UPLOADPOST_PROFILE || null,
          categoryId: '24',
          ...(card.deliverySpec || {}),
          platforms
        },
    order: card.order || {},
    planTier: card.planTier || 'dfy'
  };

  // Mark as running
  card.stage = 'gate5_running';
  saveJobCard(jobId, card);
  console.log(`[run-gate5] ${jobId}: Gate 5 starting — driveUrl=${driveUrl}`);

  let g5Result;
  try {
    g5Result = await gate5Worker.run(g5JobSpec, { uploadSignal: true, passed: true, gate: 4 });
  } catch (err) {
    card.stage = 'gate5_failed';
    card.gate5Error = err.message;
    saveJobCard(jobId, card);
    console.error(`[run-gate5] ${jobId}: Gate 5 threw:`, err.message);
    pipelineBus.emit('gate5:failed', { jobId, error: err.message });
    return;
  }

  card.gate5Result = g5Result;
  if (g5Result.passed) {
    card.stage = 'published';
    card.publishedAt = new Date().toISOString();
    console.log(`[run-gate5] ${jobId}: Gate 5 PASS — marked published`);
    pipelineBus.emit('publish:complete', { jobId });
  } else {
    card.stage = 'gate5_failed';
    const violations = g5Result.prePublishValidation?.violations || [];
    console.warn(`[run-gate5] ${jobId}: Gate 5 FAIL — ${violations.slice(0, 3).join('; ')}`);
    pipelineBus.emit('gate5:failed', { jobId, violations });
  }
  saveJobCard(jobId, card);
}

// ── Direct YouTube OAuth (CPD-923) ──────────────────────────────────────────
// One-time connect: visit /connect/youtube in a browser, authorize the
// ClipzWorld channel, tokens persist in data/youtube_tokens.json.
// Publish path stays Upload-Post until YOUTUBE_DIRECT_PUBLISH=true is set.

function _ytRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/connect/youtube/callback`;
}

app.get('/connect/youtube', (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
    return res.status(400).send('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not set in .env');
  }
  const ytDirect = require('./lib/services/youtube_direct');
  res.redirect(ytDirect.buildAuthUrl(_ytRedirectUri(req), 'c0'));
});

app.get('/connect/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Google OAuth error: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const ytDirect = require('./lib/services/youtube_direct');
    const tokens = await ytDirect.exchangeCode(code, _ytRedirectUri(req));
    if (!tokens.refresh_token) {
      return res.status(400).send('No refresh_token returned — revoke app access at myaccount.google.com/permissions and retry');
    }
    const stored = {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      scope: tokens.scope,
      connectedAt: new Date().toISOString(),
    };
    try {
      const info = await ytDirect.getChannelInfo(tokens.access_token);
      if (info) Object.assign(stored, info);
    } catch { /* channel info is cosmetic */ }
    ytDirect.saveTokens(stored);
    console.log(`[youtube_direct] Connected channel: ${stored.channelTitle || stored.channelId || 'unknown'}`);
    res.send(`<h2>✅ YouTube connected</h2><p>Channel: <b>${stored.channelTitle || stored.channelId || 'unknown'}</b></p><p>Set <code>YOUTUBE_DIRECT_PUBLISH=true</code> in .env to enable direct publishing (after thumbnail parity test).</p>`);
  } catch (e) {
    console.error('[youtube_direct] OAuth exchange failed:', e.response?.data || e.message);
    res.status(500).send(`Token exchange failed: ${e.response?.data?.error_description || e.message}`);
  }
});

app.get('/connect/youtube/status', (req, res) => {
  const ytDirect = require('./lib/services/youtube_direct');
  const t = ytDirect.loadTokens();
  res.json({
    connected: ytDirect.isConnected(),
    channelTitle: t?.channelTitle || null,
    channelId: t?.channelId || null,
    connectedAt: t?.connectedAt || null,
    directPublishEnabled: process.env.YOUTUBE_DIRECT_PUBLISH === 'true',
  });
});

// POST /job/:id/schedule — set/clear a deferred publish time (CPD-924)
// Body: { scheduledAt: ISO-8601 string } to set, { scheduledAt: null } to clear.
// Gate 5 holds at 'publish_scheduled' and scheduling_cron fires it when due.
app.post('/job/:id/schedule', (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
  if (card.stage === 'published') {
    return res.status(400).json({ ok: false, error: 'Job already published — cannot schedule' });
  }

  const { scheduledAt } = req.body;

  // Optional: update delivery platforms alongside the schedule (calendar workflows)
  if (Array.isArray(req.body.platforms) && req.body.platforms.length) {
    card.platforms = req.body.platforms;
    card.deliverySpec = card.deliverySpec || {};
    card.deliverySpec.platforms = req.body.platforms;
  }

  if (scheduledAt === null || scheduledAt === '') {
    card.scheduledPublishAt = null;
    if (card.deliverySpec) card.deliverySpec.scheduledAt = null;
    if (card.stage === 'publish_scheduled') card.stage = 'assembled';
    saveJobCard(jobId, card);
    return res.json({ ok: true, jobId, scheduledAt: null, message: 'Schedule cleared — job will publish on normal Gate 5 flow' });
  }

  const due = new Date(scheduledAt);
  if (isNaN(due.getTime())) {
    return res.status(400).json({ ok: false, error: `Invalid scheduledAt: ${scheduledAt} — must be ISO-8601` });
  }
  if (due.getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, error: 'scheduledAt must be in the future' });
  }

  card.scheduledPublishAt = due.toISOString();
  card.deliverySpec = card.deliverySpec || {};
  card.deliverySpec.scheduledAt = due.toISOString();
  // If the video is already assembled and waiting, hold it now;
  // otherwise assembly's Gate 5 trigger will see the schedule and hold.
  if (['assembled', 'gate5_forced', 'gate5_failed'].includes(card.stage)) {
    card.stage = 'publish_scheduled';
  }
  saveJobCard(jobId, card);
  console.log(`[schedule] ${jobId}: publish scheduled for ${card.scheduledPublishAt} (stage=${card.stage})`);
  return res.json({ ok: true, jobId, scheduledAt: card.scheduledPublishAt, stage: card.stage });
});

// ---------------------------------------------------------------------------
// Live Grid (CPD-940/CPD-946) — 4-quadrant Twitch mosaic → YouTube Live
// ---------------------------------------------------------------------------
let liveGridManager = null;

// POST /live-grid/start { privacyStatus?, title?, roster?, bench?, exclude?, output? }
app.post('/live-grid/start', async (req, res) => {
  try {
    if (liveGridManager?.running) {
      return res.status(400).json({ ok: false, error: 'Live grid already running', status: liveGridManager.status() });
    }
    const { LiveGridManager } = require('./lib/live_grid/manager');
    liveGridManager = new LiveGridManager();
    const status = await liveGridManager.start(req.body || {});
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[live-grid] start failed:', e.message);
    try { await liveGridManager?.stop(); } catch (_) {}
    liveGridManager = null;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /live-grid/stop — instant kill (also the DMCA mitigation switch)
app.post('/live-grid/stop', async (req, res) => {
  if (!liveGridManager) return res.status(400).json({ ok: false, error: 'Live grid not running' });
  const watchUrl = liveGridManager.broadcast?.watchUrl || null;
  await liveGridManager.stop();
  liveGridManager = null;
  res.json({ ok: true, message: 'Live grid stopped — VOD remains on the channel', watchUrl });
});

// --- Twitch user OAuth (CPD-953) — one-time connect so the grid can read
// Rob's followed channels (user:read:follows) and use them as the bench. ---
app.get('/connect/twitch', async (req, res) => {
  // Separate localhost OAuth app (production app's redirect is auraflux.co)
  const clientId = process.env.TWITCH_OAUTH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_OAUTH_CLIENT_SECRET;
  const redirectUri = `http://localhost:${PORT}/connect/twitch`;

  // Authorization code grant (CPD-966) — confidential client with secret.
  // One browser auth ever: the refresh token keeps the server tokened forever.
  if (clientSecret) {
    const page = (msg) => `<!doctype html><html><body style="background:#0d1424;color:#fff;font-family:monospace;padding:40px;">${msg}</body></html>`;
    if (req.query.error) {
      return res.send(page(`❌ Twitch error: ${req.query.error_description || req.query.error}`));
    }
    if (req.query.code) {
      try {
        const t = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
          grant_type: 'authorization_code',
          code: req.query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const v = await axios.get('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${t.data.access_token}` } });
        require('./lib/live_grid/follows').saveUserToken({
          accessToken: t.data.access_token,
          refreshToken: t.data.refresh_token,
          login: v.data.login,
          clientId: v.data.client_id,
          userId: v.data.user_id,
        });
        console.log(`[live-grid:follows] Twitch user token saved for ${v.data.login} (auth-code + refresh)`);
        return res.send(page(`✅ Twitch connected as ${v.data.login} — token now auto-refreshes, no re-auth needed. You can close this tab.`));
      } catch (e) {
        return res.send(page(`❌ Token exchange failed: ${e.response?.data?.message || e.message}`));
      }
    }
    const codeUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=user:read:follows`;
    return res.redirect(codeUrl);
  }

  // Legacy implicit grant (no client secret configured) — token lasts ~4h.
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=user:read:follows`;
  // Implicit grant returns the token in the URL #fragment — only the browser
  // can see it, so this page captures it and POSTs it back.
  res.send(`<!doctype html><html><body style="background:#0d1424;color:#fff;font-family:monospace;padding:40px;">
<div id="msg">Connecting to Twitch…</div>
<script>
const h = new URLSearchParams(location.hash.slice(1));
const token = h.get('access_token');
if (token) {
  fetch('/connect/twitch/token', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ access_token: token }) })
    .then(r => r.json())
    .then(d => { document.getElementById('msg').textContent = d.ok ? ('✅ Twitch connected as ' + d.login + ' — followed channels will be used as the live grid bench. You can close this tab.') : ('❌ ' + (d.error || 'failed')); })
    .catch(e => { document.getElementById('msg').textContent = '❌ ' + e.message; });
} else if (h.get('error') || new URLSearchParams(location.search).get('error')) {
  document.getElementById('msg').textContent = '❌ Twitch error: ' + (h.get('error_description') || new URLSearchParams(location.search).get('error_description') || 'denied');
} else {
  location.href = ${JSON.stringify(authUrl)};
}
</script></body></html>`);
});

app.post('/connect/twitch/token', async (req, res) => {
  try {
    const accessToken = req.body?.access_token;
    if (!accessToken) return res.status(400).json({ ok: false, error: 'access_token required' });
    const v = await axios.get('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${accessToken}` } });
    if (!(v.data.scopes || []).includes('user:read:follows')) {
      return res.status(400).json({ ok: false, error: 'token missing user:read:follows scope' });
    }
    require('./lib/live_grid/follows').saveUserToken({ accessToken, login: v.data.login, clientId: v.data.client_id, userId: v.data.user_id });
    console.log(`[live-grid:follows] Twitch user token saved for ${v.data.login}`);
    res.json({ ok: true, login: v.data.login });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.response?.data?.message || e.message });
  }
});

// GET /live-grid/followed-bench — preview the bench the next stream would use
app.get('/live-grid/followed-bench', async (req, res) => {
  const { getFollowedBench, FOLLOWS_USER } = require('./lib/live_grid/follows');
  const { DEFAULT_ROSTER } = require('./lib/live_grid/poller');
  const bench = await getFollowedBench({ roster: DEFAULT_ROSTER });
  if (!bench) return res.status(400).json({ ok: false, error: `No Twitch user token (or expired) — connect at /connect/twitch as ${FOLLOWS_USER}` });
  res.json({ ok: true, user: FOLLOWS_USER, count: bench.length, bench });
});

// POST /live-grid/roster { add?, remove?, benchAdd?, benchRemove? } — mutate the
// running grid's streamer lists on demand (CPD-951); next 60s poll applies it.
// Bench streamers only fill quadrants the A-roster can't and are preempted
// the moment a roster streamer goes live.
app.post('/live-grid/roster', (req, res) => {
  if (!liveGridManager?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
  const lists = liveGridManager.poller.updateRoster(req.body || {});
  liveGridManager.poller.pollOnce().catch(() => {}); // apply immediately, don't wait for the tick
  res.json({ ok: true, ...lists });
});

// POST /live-grid/audio { quadrant: 1-4 } pins audio (operator override);
// { quadrant: "auto" } releases back to chat/auto control
app.post('/live-grid/audio', (req, res) => {
  if (!liveGridManager?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
  const { quadrant } = req.body || {};
  const arg = quadrant === 'auto' ? 'auto' : Number(quadrant) - 1;
  const switched = liveGridManager.setAudio(arg, 'manual');
  res.json({ ok: true, switched, audio: liveGridManager.status().audio });
});

// GET /live-grid/status
app.get('/live-grid/status', (req, res) => {
  if (!liveGridManager) return res.json({ ok: true, running: false });
  res.json({ ok: true, ...liveGridManager.status() });
});

// ---------------------------------------------------------------------------
// ClipzWorld TV (CPD-956/CPD-957) — 24/7 loop of produced videos → Twitch
// ---------------------------------------------------------------------------
let liveTvManager = null;

// POST /live-tv/start { videos?, shuffle?, output? } — default playlist scans
// output/ for finished videos (build artifacts + Live Grid recordings excluded)
app.post('/live-tv/start', (req, res) => {
  try {
    if (liveTvManager?.running) {
      return res.status(400).json({ ok: false, error: 'ClipzWorld TV already running', status: liveTvManager.status() });
    }
    const { LiveTvManager } = require('./lib/live_tv/manager');
    liveTvManager = new LiveTvManager();
    const status = liveTvManager.start(req.body || {});
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[live-tv] start failed:', e.message);
    try { liveTvManager?.stop(); } catch (_) {}
    liveTvManager = null;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /live-tv/stop
app.post('/live-tv/stop', (req, res) => {
  if (!liveTvManager) return res.status(400).json({ ok: false, error: 'ClipzWorld TV not running' });
  liveTvManager.stop();
  liveTvManager = null;
  res.json({ ok: true, message: 'ClipzWorld TV stopped' });
});

// GET /live-tv/status
app.get('/live-tv/status', (req, res) => {
  if (!liveTvManager) return res.json({ ok: true, running: false });
  res.json({ ok: true, ...liveTvManager.status() });
});

// GET /stream-scheduler/status — programming windows + next start/stop (CPD-975/976)
let streamScheduler = null;
app.get('/stream-scheduler/status', (req, res) => {
  if (!streamScheduler) return res.json({ ok: true, enabled: false });
  res.json({ ok: true, enabled: true, streams: streamScheduler.status() });
});

// POST /job/:id/run-gate5 — trigger Gate 5 upload for an assembled/force-advanced job
app.post('/job/:id/run-gate5', async (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });

  const stage = card.stage || '';
  if (!['assembled', 'gate5_forced', 'gate5_failed', 'gate5_running', 'heygen_done', 'gate3b_blocked'].includes(stage)) {
    return res.status(400).json({ ok: false, error: `Job is at stage "${stage}" — run-gate5 only valid for assembled/heygen_done/gate5_forced/gate5_failed/gate5_running` });
  }

  // Allow caller to inject driveUrl / assembledPath when Gate 3b blocked the normal save path
  if (req.body.driveUrl) {
    card.driveUrl = req.body.driveUrl;
    card.state = card.state || {};
    card.state.savedOutputs = card.state.savedOutputs || {};
    card.state.savedOutputs.driveUrl = req.body.driveUrl;
  }
  if (req.body.assembledPath) {
    card.assembledPath = req.body.assembledPath;
    card.state = card.state || {};
    card.state.savedOutputs = card.state.savedOutputs || {};
    card.state.savedOutputs.assembledPath = req.body.assembledPath;
  }
  if (req.body.thumbnailDriveUrl) {
    card.thumbnailDriveUrl = req.body.thumbnailDriveUrl;
    card.state = card.state || {};
    card.state.savedOutputs = card.state.savedOutputs || {};
    card.state.savedOutputs.thumbnailDriveUrl = req.body.thumbnailDriveUrl;
  }

  // Mark forced so the advance branch doesn't re-fire on page reload
  card.gate5 = card.gate5 || {};
  card.gate5.retriggeredAt = new Date().toISOString();
  card.stage = 'gate5_forced';
  saveJobCard(jobId, card);

  res.json({ ok: true, message: 'Gate 5 triggered — upload is in progress.' });

  setImmediate(async () => {
    try { await _runGate5ForCard(jobId); } catch (err) {
      console.error(`[run-gate5 endpoint] ${jobId}:`, err.message);
    }
  });
});

// GET /job/:id/assembly-preflight — verify manual_segments folder before triggering assembly.
// Returns a report showing every expected segment: present/missing, dimensions, chrome story mapping.
// Run this after placing HeyGen exports but BEFORE hitting resume — catch mismatches before spending credits.
app.get('/job/:id/assembly-preflight', (req, res) => {
  const jobId = req.params.id;
  const card  = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });

  const { getManualDir, discoverHeyGenNestedExports: _discoverNestedExports, labelSceneTypeSuffixMatch: _labelSuffixMatch } = require('./lib/manual_segment_workflow');
  const manualDir = getManualDir(jobId);
  const dirExists = fs.existsSync(manualDir);

  // Load manifest to get expected segments in correct order
  const manifestPath = path.join(manualDir, 'manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(_) {}

  const segments = manifest?.segments || [];
  const sceneItems = card?.designSpec?.sceneStructure?.items || [];

  // Build expected chrome story order from the CARD (picker order), not DB spec
  const chromeStoryOrder = sceneItems.map((it, i) => ({
    position: i + 1,
    title: (it.label || '').slice(0, 50),
    sceneId: it.sceneId || `ITEM${i+1}`
  }));

  const report = {
    jobId,
    contentType: card.contentType,
    manualDir,
    dirExists,
    chromeStoryOrder,
    segments: [],
    summary: { total: 0, avatar: 0, sourceClip: 0, present: 0, missing: 0, dimensionOk: 0, dimensionWrong: 0, audioOk: 0, audioMissing: 0 }
  };

  if (!dirExists || segments.length === 0) {
    report.error = dirExists ? 'manifest.json missing — job has not reached manual checkpoint yet' : 'manual_segments folder does not exist yet';
    return res.json(report);
  }

  const { spawnSync } = require('child_process');

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segType = seg.type || 'avatar';

    // Determine expected file for this segment
    let expectedFile = null;
    if (segType === 'source_clip') {
      // Flat mp4 files for clips
      const typeTag = 'clip';
      const safeLabel = String(seg.label || 'seg').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      expectedFile = path.join(manualDir, `${String(i).padStart(2, '0')}_${typeTag}_${safeLabel}.mp4`);
    } else {
      // Nested HeyGen folder for avatar segments
      expectedFile = null; // checked via label matching below
    }

    // For avatar: mirror the 3-priority matching used in applyManualOverrides so the
    // preflight accurately reflects whether assembly will find each segment.
    let foundMp4 = null;
    if (segType === 'avatar') {
      if (dirExists) {
        const nested = _discoverNestedExports(manualDir);
        const segLabel = String(seg.label || '').toUpperCase().trim();
        // heygenOrdinal = count of non-source_clip segments before this index
        const heygenOrdinal = segments.slice(0, i).filter(s => (s.type || 'avatar') !== 'source_clip').length;

        // Priority 1: exact label match (e.g. folder "RON_INTRO" === seg label "RON_INTRO")
        const labelMatches = segLabel ? nested.filter(n => n.label === segLabel) : [];
        const byLabel = labelMatches.length === 1
          ? labelMatches[0]
          : labelMatches.length > 1
            ? labelMatches.reduce((best, n) =>
                Math.abs(n.ord - heygenOrdinal) < Math.abs(best.ord - heygenOrdinal) ? n : best)
            : null;

        // Priority 2: HeyGen avatar ordinal + scene-type suffix match
        // (handles NBA short labels "G1_INTRO" matching manifest "GAME1_NEW_YORK_KNICKS_..._INTRO")
        const byHeygenOrd = nested.find(n => n.ord === heygenOrdinal && (
          !n.label || !segLabel || n.label === segLabel || _labelSuffixMatch(n.label, segLabel)
        ));

        // Priority 3: absolute index + suffix match (fallback when user names folders 00_, 01_…)
        const byAbsoluteIdx = nested.find(n => n.ord === i && (
          !n.label || !segLabel || n.label === segLabel || _labelSuffixMatch(n.label, segLabel)
        ));

        const pick = byLabel || byHeygenOrd || byAbsoluteIdx;
        if (pick) foundMp4 = pick.mp4Path;
      }
    } else {
      if (expectedFile && fs.existsSync(expectedFile) && fs.statSync(expectedFile).size > 10000) {
        foundMp4 = expectedFile;
      }
    }

    // Probe dimensions + audio if file found
    let width = null, height = null, hasAudio = null;
    if (foundMp4) {
      try {
        const probe = spawnSync('ffprobe', [
          '-v', 'quiet', '-show_streams', '-of', 'json', foundMp4
        ], { encoding: 'utf8', timeout: 8000 });
        if (probe.status === 0) {
          const streams = JSON.parse(probe.stdout).streams || [];
          const v = streams.find(s => s.codec_type === 'video');
          const a = streams.find(s => s.codec_type === 'audio');
          if (v) { width = v.width; height = v.height; }
          hasAudio = !!a;
        }
      } catch(_) {}
    }

    // Determine which chrome story this segment maps to
    const storyMatch = String(seg.label || '').match(/(?:STORY|ITEM|GAME)(\d+)/i);
    const storyNum = storyMatch ? parseInt(storyMatch[1], 10) : null;
    const chromeStory = storyNum ? chromeStoryOrder[storyNum - 1] : null;

    // Dimension check: avatars must be 1920x1080 (HeyGen standard).
    // Source clips can be any resolution — assembly pillarboxes portrait clips automatically.
    let dimOk = null;
    if (width && height) {
      if (segType === 'avatar') {
        dimOk = (width === 1920 && height === 1080);
      } else {
        // For clips: just require video track present — any resolution is acceptable
        dimOk = true;
      }
    }
    const isPortraitClip = segType === 'source_clip' && width && height && height > width;

    const row = {
      index: i,
      label: seg.label,
      type: segType,
      present: !!foundMp4,
      file: foundMp4 ? path.basename(path.dirname(foundMp4) === manualDir ? foundMp4 : path.dirname(foundMp4)) : (expectedFile ? path.basename(expectedFile) : '(nested folder)'),
      dimensions: width ? `${width}x${height}${isPortraitClip ? ' (portrait→pillarbox)' : ''}` : null,
      dimensionsOk: dimOk,
      hasAudio,
      chromeStory: chromeStory ? `[${chromeStory.position}] ${chromeStory.title}` : null,
      issue: null
    };

    if (!row.present) row.issue = 'MISSING';
    else if (dimOk === false) row.issue = `WRONG_DIMS: ${width}x${height} (expected 1920x1080)`;
    else if (hasAudio === false && segType === 'avatar') row.issue = 'NO_AUDIO on avatar segment — Bobby G will be silent';

    report.segments.push(row);
    report.summary.total++;
    if (segType === 'avatar') report.summary.avatar++;
    else report.summary.sourceClip++;
    if (row.present) report.summary.present++;
    else report.summary.missing++;
    if (dimOk === true) report.summary.dimensionOk++;
    if (dimOk === false) report.summary.dimensionWrong++;
    if (hasAudio === true) report.summary.audioOk++;
    if (hasAudio === false) report.summary.audioMissing++;
  }

  report.ready = report.summary.missing === 0 && report.summary.dimensionWrong === 0 && report.summary.audioMissing === 0;
  report.issues = report.segments.filter(s => s.issue).map(s => `[${s.index}] ${s.label}: ${s.issue}`);

  res.json(report);
});

// POST /job/:id/manual-segments/resume — continue pipeline after c0 manual checkpoint
app.post('/job/:id/manual-segments/resume', (req, res) => {
  const jobId = req.params.id;
  const card = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });

  let stage = card.stage || inferJobStage(card);
  if (stage === 'published') {
    return res.status(400).json({
      ok: false,
      error: 'Job is published — POST /job/:id/rollback first, then resume.'
    });
  }

  // Operator fixed manual drops (or ordinal parsing) after a bad assemble — same cleanup as
  // POST /job/:id/rollback from assembled, without requiring a second request.
  if (stage === 'assembled' || stage === 'gate5_forced') {
    delete card.assembledAt;
    delete card.finalUrl;
    delete card.outputPath;
    delete card.gate5;
    delete card._gate5Done;
    delete card._gate5Running;
    delete card._gate3Approved;
    delete card._gate3Rejected;
    if (card.heygen && card.heygen.videoJobs) {
      card.heygen.videoJobs.forEach(vj => { vj._url = null; });
    }
    Object.keys(assemblyJobs).forEach(asmId => {
      if (assemblyJobs[asmId]?.sourceJobId === jobId) {
        delete assemblyJobs[asmId];
        console.log(`[manual-segments/resume] ${jobId}: cleared assembly dedup lock for asmId=${asmId}`);
      }
    });
    card.stage = 'all_sent';
    saveJobCard(jobId, card);
    stage = 'all_sent';
    console.log(`[manual-segments/resume] ${jobId}: cleared prior assembly — continuing to Gate 2 + assemble`);
  }

  if (stage !== 'awaiting_manual_segments' && stage !== 'all_sent') {
    return res.status(400).json({
      ok: false,
      error: `Job is at stage "${stage}" — expected awaiting_manual_segments, all_sent, assembled, or gate5_forced`
    });
  }

  const segmentUrls = (card.heygen?.videoJobs || [])
    .filter(vj => vj.status === 'completed' && vj.video_url)
    .map(vj => vj.video_url);

  card.manualSegments = {
    ...(card.manualSegments || {}),
    status: 'resume_requested',
    resumedAt: new Date().toISOString()
  };
  card.stage = 'all_sent';
  saveJobCard(jobId, card);

  try {
    pipelineBus.emit('heygen:all_complete', {
      jobId,
      contentType: card.contentType || 'twitch',
      segmentUrls,
      card,
      segmentData: null
    });
    return res.json({
      ok: true,
      jobId,
      message: 'Resume accepted — Gate 2 + assembly handoff emitted.',
      segmentCount: segmentUrls.length
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// POST /job/:id/reassemble — skip Gate 2, build segmentData from the card's heygen.videoJobs
// and orderedClipUrls, then fire /assemble directly.  Any files the operator dropped into
// tmp/manual_segments/<jobId>/ are picked up automatically by applyManualOverrides inside
// the assembly handler, so expired HeyGen URLs don't matter — they get replaced.
//
// Safe to call from any stage except 'published'. Increments _assemblyRetryCount so the
// asmId is unique and the dedup lock does not block it.
app.post('/job/:id/reassemble', async (req, res) => {
  const jobId = req.params.id;
  const card  = persistedJobs[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
  if (card.stage === 'published') {
    return res.status(400).json({ ok: false, error: 'Job is already published — rollback first if you need to re-assemble.' });
  }

  const videoJobs     = card.heygen?.videoJobs || [];
  const orderedClips  = card.orderedClipUrls   || [];

  // Clips-only jobs (CPD-935 comps / CPD-981 avatar-free shorts) legitimately
  // have zero videoJobs — their script scenes are all source_clip, so the
  // script-driven rebuild below works fine. Only reject when there is nothing
  // at all to rebuild from.
  if (!videoJobs.length && !card.clipsOnly && !orderedClips.length) {
    return res.status(400).json({ ok: false, error: 'No heygen.videoJobs on this card — cannot build segment data.' });
  }

  // ── Build segmentData — prefer manifest (has correct clip interleaving) ────
  // The manifest written at hold time is authoritative: it has both avatar and
  // source_clip segments in the correct order.  Fall back to videoJobs-only
  // reconstruction if no manifest exists (older jobs / NBA long-form).
  const { getManualDir } = require('./lib/manual_segment_workflow');
  const manualDir = getManualDir(jobId);
  const manifestPath = path.join(manualDir, 'manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}

  let clipIdx = 0;
  let segmentData;

  if (manifest?.segments?.length) {
    // Use manifest — interleaves source_clip segments in the correct positions
    segmentData = manifest.segments.map((seg, i) => {
      if ((seg.type || 'avatar') === 'source_clip') {
        const clipEntry = orderedClips[clipIdx++] || {};
        return {
          type:              'source_clip',
          url:               seg.url || clipEntry.url || clipEntry.pageUrl || '',
          label:             seg.label,
          clipTimingTargets: clipEntry.clipTimingTargets  || seg.clipTimingTargets  || [],
          clipTimingFormat:  clipEntry.clipTimingFormat   || seg.clipTimingFormat   || 'timestamp_table',
          pillarboxFilter:   clipEntry.pillarboxFilter    || seg.pillarboxFilter    || null,
          sourceOrientation: clipEntry.sourceOrientation  || seg.sourceOrientation  || 'landscape'
        };
      }
      // Avatar — find matching videoJob for the HeyGen URL (best-effort, overridden by applyManualOverrides anyway)
      const matchingJob = videoJobs.find(j => (j.sceneName || j.scene) === seg.label);
      return { type: 'avatar', url: matchingJob?.video_url || seg.url || '', label: seg.label };
    });
    console.log(`[reassemble] ${jobId}: using manifest (${segmentData.length} segs, ${clipIdx} clips)`);
  } else if (card.script?.scenes?.length) {
    // Script-driven rebuild — same source of truth as the heygen-poller build.
    // The videoJobs-only fallback below drops source_clip scenes (they are never
    // sent to HeyGen), which produced 0-clip re-assemblies on shorts (CPD-932).
    const pushClip = (scene, labelFallback) => {
      const clipEntry = orderedClips[clipIdx++] || {};
      const url = clipEntry.clipUrl || clipEntry.url || clipEntry.pageUrl || '';
      if (!url) return;
      segmentData.push({
        type:              'source_clip',
        url,
        label:             clipEntry.label || scene.name || labelFallback,
        clipTimingTargets: Array.isArray(clipEntry.clipTimingTargets) ? clipEntry.clipTimingTargets : [],
        clipTimingFormat:  clipEntry.clipTimingFormat || 'timestamp_table',
        pillarboxFilter:   clipEntry.pillarboxFilter || null,
        sourceOrientation: clipEntry.sourceOrientation || clipEntry.orientation || 'landscape'
      });
    };
    segmentData = [];
    for (const scene of card.script.scenes) {
      if (scene.type === 'source_clip') {
        pushClip(scene, `CLIP_${clipIdx + 1}`);
      } else {
        const sceneKey = scene.name || scene.id;
        const matchingJob = videoJobs.find(j => (j.sceneName || j.scene) === sceneKey);
        if (matchingJob?.video_url) {
          segmentData.push({ type: 'avatar', url: matchingJob.video_url, label: sceneKey });
        }
        if (scene.hasClipInsert) pushClip(scene, `${sceneKey}_CLIP`);
      }
    }
    console.log(`[reassemble] ${jobId}: script-driven rebuild (${segmentData.length} segs, ${clipIdx} clips)`);
  } else {
    // Fallback: rebuild from videoJobs only (no clip interleaving)
    segmentData = videoJobs.map(job => {
      const sceneName   = job.sceneName || job.scene || `SEG_${clipIdx}`;
      const isClipScene = /CLIP/i.test(sceneName) && !/COLD_OPEN/i.test(sceneName);
      if (isClipScene) {
        const clipEntry = orderedClips[clipIdx++] || {};
        return {
          type:              'source_clip',
          url:               clipEntry.url || clipEntry.pageUrl || '',
          label:             sceneName,
          clipTimingTargets: clipEntry.clipTimingTargets  || [],
          clipTimingFormat:  clipEntry.clipTimingFormat   || 'timestamp_table',
          pillarboxFilter:   clipEntry.pillarboxFilter    || null,
          sourceOrientation: clipEntry.sourceOrientation  || 'landscape'
        };
      }
      return { type: 'avatar', url: job.video_url || '', label: sceneName };
    });
    console.log(`[reassemble] ${jobId}: no manifest — rebuilt from videoJobs (${segmentData.length} segs, ${clipIdx} clips)`);
  }

  // ── Reset assembly-related state so old stitch artefacts are gone ──────────
  const retryNum  = (card._assemblyRetryCount || 0) + 1;
  const assemblyId = `asm_${jobId}_r${retryNum}`;

  card._assemblyRetryCount = retryNum;
  // Clear previous assembly artefacts but preserve heygen, script, designSpec, etc.
  delete card.assembledAt;
  delete card.finalUrl;
  delete card.outputPath;
  delete card.gate5;
  delete card._gate5Done;
  delete card._gate5Running;
  delete card._gate3Approved;
  delete card._gate3Rejected;
  Object.keys(assemblyJobs).forEach(asmId => {
    if (assemblyJobs[asmId]?.sourceJobId === jobId) delete assemblyJobs[asmId];
  });
  card.stage = 'heygen_done';
  saveJobCard(jobId, card);

  // ── Fire /assemble (internal axios call so all middleware runs normally) ───
  const port = process.env.PORT || 3000;
  const payload = {
    segments:     segmentData.map(s => s.url),
    segmentData,
    labels:       segmentData.map(s => s.label),
    transition:   'crossfade',
    // Shorts must re-assemble down the split-screen portrait path (CPD-932):
    // assembly.js only routes short-form when format === 'portrait'.
    format:       (card.contentType || '').includes('-short') ? 'portrait' : 'mp4',
    assemblyId,
    contentType:  card.contentType || 'nba',
    jobId,
    jobSpecId:    card.specId || card.jobSpecId || null,
    // Without jobTitle the short-form output falls back to a cwn_short_* name —
    // clips-only retries then lose their clips_comp_*/clip_short_* slug and the
    // ClipzWorld TV takedown-shield filename filter no longer matches them.
    jobTitle:     card.title || null,
    sceneTextMap: card.heygen?.sceneTextMap || null,
    fullScript:   card.script?.raw || card.script || null,
    streamers:    card.streamers || [],
    items:        card.nbaItems  || card.newsItems || card.items || [],
    expectedClips: orderedClips.length,
    designSpec:   card.designSpec  || null,
    nbaItems:     card.nbaItems    || [],
    captionText:  card.captionText || null,
    captionStyle: card.captionStyle || null
  };

  res.json({
    ok: true,
    jobId,
    assemblyId,
    retryNum,
    message: `Re-assembly r${retryNum} started — files from manual_segments will be used. Watch the dashboard for Gate 3 result.`,
    segmentCount: segmentData.length,
    clipCount: clipIdx
  });

  // Fire async so the HTTP response goes out first
  setImmediate(async () => {
    try {
      await axios.post(`http://localhost:${port}/assemble`, payload, { timeout: 20000 });
      console.log(`[reassemble] ${jobId} r${retryNum}: /assemble fired (${segmentData.length} segs, ${clipIdx} clips)`);
    } catch (err) {
      console.error(`[reassemble] ${jobId} r${retryNum}: /assemble failed — ${err.message}`);
    }
  });
});

// ── POST /generate-clip-comp — CPD-935: clips-only compilation short ─────────
// No script gen, no HeyGen. Picked clips (already mp4-resolved by the dashboard)
// go straight to assembly: blur-pad portrait per clip + concat. Whisper captions
// and loudnorm apply in the standard post-process pass.
// CPD-981: also the path for ALL dashboard shorts — Bobby G is VOD-only now
// (HeyGen credits reserved for watch-hour content until CPD-881 lands), so the
// SHORT buttons dispatch single-clip jobs here. contentType 'news-short' rides
// the same flow: assembly re-scrapes fresh Brightcove HLS from clip pageUrl.
app.post('/generate-clip-comp', async (req, res) => {
  const clips = Array.isArray(req.body.clips) ? req.body.clips.filter(c => c && (c.url || c.clipUrl)) : [];
  if (!clips.length) return res.status(400).json({ error: 'clips[] required — each needs a resolved mp4 url' });
  if (clips.length > 10) return res.status(400).json({ error: `Too many clips (${clips.length} > 10 max)` });

  const contentType = ['twitch-short', 'news-short'].includes(req.body.contentType)
    ? req.body.contentType : 'twitch-short';
  const platforms = Array.isArray(req.body.platforms) && req.body.platforms.length ? req.body.platforms : ['tiktok'];
  const streamers = [...new Set(clips.map(c => c.displayName || c.streamer).filter(Boolean))];
  // Single-clip shorts slug to clip_short_* — the ClipzWorld TV playlist filter
  // excludes that prefix (no avatar = no transformative layer = never on the loop)
  const title     = req.body.title ||
    (clips.length === 1 ? `Clip Short — ${streamers[0] || 'Twitch'}`
                        : `Clips Comp — ${streamers.join(', ') || 'Twitch'}`);
  const jobId     = `script_${contentType}_${Date.now()}`;

  // Job spec — same contract as the script flow so all gates read normally.
  // contentType twitch-short inherits the CPD-932 short-form gate handling.
  let jobSpec = null;
  try {
    jobSpec = await createJobSpec({
      customerId:   'c0',
      templateId:   'short-form',
      contentType,
      createdBy:    'dashboard',
      sourceType:   'url_list',
      sourceConfig: { urls: clips.map(c => c.pageUrl || c.url).filter(Boolean) },
      items:        clips,
      title
    });
    const { updateJobSpec, linkScriptJob } = require('./lib/job_spec');
    // Link semantic spec ↔ card id like the script flow does. Without this,
    // saveOutput(card id) seeds a DUPLICATE spec row and Gate 5 (reading the
    // semantic row) sees publishCopy=null → "YouTube: title is required" fail.
    linkScriptJob(jobSpec.jobId, jobId);
    jobSpec = updateJobSpec(jobSpec.jobId, {
      clipsOnly: true,
      deliverySpec: { platforms },
      // Spec-driven routing: declare the stages this job actually skips. Clips-only
      // comps have no script generation and no HeyGen avatar — the spec must say so.
      stageMap: {
        script: { active: false },
        avatar: { active: false }
      },
      designSpec: { chrome: {
        layout: 'clip-comp',
        hasTopBar: false, hasFlag: false, hasSidebar: false, hasTicker: false, hasLogo: true,
        // Short-form assembly places the logo bottom-right (shortLogoPos "mug") — the
        // inherited top-right default made Gate 3a dock points for a per-spec logo.
        logoPosition: 'bottom-right', logoSize: 80
      } }
    });
  } catch (specErr) {
    console.warn('[/generate-clip-comp] Job Spec creation failed (non-fatal):', specErr.message);
  }

  const orderedClipUrls = clips.map((c, i) => ({
    url:         c.url || c.clipUrl || '',
    clipUrl:     c.url || c.clipUrl || '',
    pageUrl:     c.pageUrl || '',
    label:       `CLIP_${i + 1}`,
    streamer:    c.streamer || '',
    displayName: c.displayName || c.streamer || '',
    title:       c.title || '',
    orientation: c.orientation || 'landscape',
    pillarboxFilter: c.pillarboxFilter != null ? c.pillarboxFilter : null
  }));

  const card = {
    id:          jobId,
    contentType,
    clipsOnly:   true,
    title,
    streamers,
    platforms,
    specId:      jobSpec?.jobId || null,
    jobSpecId:   jobSpec?.jobId || null,
    createdAt:   new Date().toISOString(),
    stage:       'heygen_done',
    status:      'assembling',
    // Synthetic all-clip scene script: keeps saveJobCard segment extraction and
    // the /reassemble script-driven rebuild (CPD-932) working with no avatar scenes.
    script: {
      title,
      scenes: clips.map((c, i) => ({ name: `CLIP_${i + 1}`, type: 'source_clip', title: c.title || '' }))
    },
    orderedClipUrls,
    heygen: { videoJobs: [] },
    designSpec: jobSpec?.designSpec || { chrome: { layout: 'clip-comp', hasLogo: true, hasTopBar: false, hasFlag: false, hasSidebar: false, hasTicker: false } },
    _assemblyRetryCount: 1
  };
  saveJobCard(jobId, card);

  const segmentData = orderedClipUrls.map(c => ({
    url:             c.clipUrl,
    pageUrl:         c.pageUrl,
    label:           c.label,
    type:            'source_clip',
    clipUrl:         c.clipUrl,
    pillarboxFilter: c.pillarboxFilter,
    orientation:     c.orientation,
    clipTimingTargets: [],
    clipTimingFormat: 'none'
  }));

  const assemblyId = `asm_${jobId}_r1`;
  const port = process.env.PORT || 3000;
  const payload = {
    segments:      segmentData.map(s => s.url),
    segmentData,
    labels:        segmentData.map(s => s.label),
    transition:    'crossfade',
    format:        'portrait',
    assemblyId,
    contentType,
    jobId,
    jobSpecId:     jobSpec?.jobId || null,
    jobTitle:      title,
    streamers,
    expectedClips: segmentData.length,
    designSpec:    card.designSpec,
    captionText:   null, // CPD-935: no hook caption — whisper captions only
    // Synthetic script from clip titles so publish-copy generation has material
    fullScript:    clips.map((c, i) => `CLIP ${i + 1} (${c.displayName || c.streamer || 'streamer'}): ${c.title || 'untitled clip'}`).join('\n')
  };

  res.json({
    ok: true,
    jobId,
    assemblyId,
    clipCount: segmentData.length,
    platforms,
    message: `Clips comp started — ${segmentData.length} clip(s) assembling full-frame portrait. Watch the dashboard for Gate 3 result.`
  });

  setImmediate(async () => {
    try {
      await axios.post(`http://localhost:${port}/assemble`, payload, { timeout: 20000 });
      console.log(`[clip-comp] ${jobId}: /assemble fired (${segmentData.length} clips)`);
    } catch (err) {
      console.error(`[clip-comp] ${jobId}: /assemble failed — ${err.message}`);
    }
  });
});

// POST /job/:id/dismiss — operator closed the job card on the dashboard.
// Marks the job dismissed so restoreJobsFromServer() skips it on next page load.
// Does NOT delete the record — preserves audit trail in data/jobs.json.
app.post('/job/:id/dismiss', (req, res) => {
  const { id } = req.params;
  const card = persistedJobs[id];
  if (!card) return res.status(404).json({ error: 'Job not found', id });
  saveJobCard(id, { ...card, status: 'dismissed' });
  res.json({ ok: true, id, status: 'dismissed' });
});

// POST /job/:id/stuck — mark a job as stuck (called by lib/assembly.js, lib/script_gen.js)
// Prevents circular dependency by exposing markJobStuck() via HTTP endpoint.
// Body: { gate, reason, detail }
app.post('/job/:id/stuck', (req, res) => {
  const { id } = req.params;
  const { gate, reason, detail = {} } = req.body;
  
  if (!gate || !reason) {
    return res.status(400).json({ error: 'gate and reason required' });
  }
  
  if (!persistedJobs[id]) {
    return res.status(404).json({ error: 'Job not found', id });
  }
  
  markJobStuck(id, gate, reason, detail);
  res.json({ ok: true, id, gate, reason });
});

// POST /job/:id/qa-confirm-generate — QA agents confirm before generate when QA_CONFIRM_ON_GENERATE=true
app.post('/job/:id/qa-confirm-generate', (req, res) => {
  const { id } = req.params;
  try {
    const { markConfirmed } = require('./lib/qa_generate_confirm');
    markConfirmed(id, { source: 'qa_confirm_endpoint' });
    res.json({ ok: true, jobId: id, status: 'confirmed' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// GET /content-type-status — return disabled content types + stuck counts
// Dashboard polls this on init to show auto-disable warnings.
app.get('/content-type-status', (req, res) => {
  const disabled = global.disabledContentTypes || {};
  const stuckCounts = {};
  
  // Build stuck counts from in-memory log
  for (const [contentType, timestamps] of Object.entries(stuckPatternLog)) {
    stuckCounts[contentType] = timestamps.length;
  }
  
  res.json({
    ok: true,
    disabled,
    stuckCounts,
    threshold: 3,
    windowHours: 24
  });
});

// Helper: detect current pipeline stage from persisted job card fields
function detectStage(card) {
  if (!card) return 'unknown';
  if (card.publishRecord && card.publishRecord.publishedAt) return 'published';
  if (card.assembledAt || card.finalUrl) return 'assembled';
  if (card.heygen && card.heygen.videoJobs && card.heygen.videoJobs.length) return 'all_sent';
  if (card.script && (card.script.raw || typeof card.script === 'string') && (card.script.raw || card.script).length > 10) return 'script_ready';
  return 'unknown';
}

// ── Serve HTML thumbnail/overlay tools ──────────────────────────────
app.get('/news-tool', (req, res) => {
  res.sendFile(path.join(__dirname, 'cwn_news_tool.html'));
});

app.get('/newscast-overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'tools/clipzworld_newscast.html'));
});

app.get('/twitch-tool', (req, res) => {
  res.sendFile(path.join(__dirname, 'cwn_twitch_tool.html'));
});

// Returns Twitch credentials for browser-side Twitch API calls (ticker, etc.)
// Token is read from env at request time so it picks up rotations without restart
app.get('/twitch-token', (req, res) => {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token    = process.env.TWITCH_TOKEN;
  if (!clientId || !token) return res.status(503).json({ error: 'Twitch credentials not configured' });
  res.json({ clientId, token });
});

app.get('/market-keys', (req, res) => {
  res.json({
    fmp:     process.env.FMP_API_KEY     || '',
    finnhub: process.env.FINNHUB_API_KEY || ''
  });
});

// Serve assets folder for images (Bobby G, etc.)
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Serve dashboard — no-cache so hard refresh always picks up latest on-disk version
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'cwn_production.html'));
});

// ── POST /assemble ────────────────────────────────────────────────
// ── GOOGLE DRIVE AUTO-UPLOAD ──────────────────────────────────────
// Uses a service account key at ~/Downloads/cwn-drive-key.json
// One-time setup: https://console.cloud.google.com → Drive API → Service Account
// Share your "CWN Videos" Drive folder with the service account email (Editor)

// DRIVE_KEY_PATH + DRIVE_FOLDER_NAME moved to lib/publish.js (only consumer after module split)
let   _driveFolderId   = null; // cached after first lookup (getDriveFolderId is in lib/publish.js)



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

// GET /job-spec/:jobId — fetch job spec state for a given job
app.get('/job-spec/:jobId', async (req, res) => {
  try {
    const spec = await getJobSpec(req.params.jobId);
    if (!spec) return res.status(404).json({ error: 'Job spec not found' });
    const { buildGateStatusSnapshot, validateGateContractConsistency } = require('./lib/job_spec_contracts');
    res.json({
      ok: true,
      jobSpec: spec,
      gateStatus: buildGateStatusSnapshot(spec),
      gateContractValidation: validateGateContractConsistency(spec)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    error:            job.error || null,
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

// ── Pinned first-comment templates (fixed per content type) ──────
// Used by autonomous Gate 6 publish to set the YouTube first comment.
// Rob's canonical wording — do NOT let Claude freestyle these.
const PINNED_COMMENT_TEMPLATES = {
  twitch: "What was your favorite streamer clip? Let me know below! 👇 If you enjoyed this, consider subscribing for more Twitch Soup episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  nba:    "What was your favorite game highlight? Let me know below! 👇 If you enjoyed this, consider subscribing for more Other Side of the Pillow episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1",
  news:   "What was your favorite news story? Let me know below! 👇 If you enjoyed this, consider subscribing for more Because the Light Was On episodes. www.youtube.com/@clipzworldnews?sub_confirmation=1"
};


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
    browser = await puppeteer.launch(withPuppeteerExecutable({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }));
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', req => req.continue());
    page.on('response', async resp => {
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
      await new Promise(r => setTimeout(r, 600));
    }

    // Wait up to 5s for HLS manifest intercept
    for (let i = 0; i < 10 && !capturedHlsUrl; i++) {
      await new Promise(r => setTimeout(r, 500));
    }

    await browser.close();
    browser = null;

    if (capturedHlsUrl) {
      console.log(`[nba-scrape] Puppeteer HLS captured for ${gameId}: ${capturedHlsUrl.slice(0, 80)}...`);
      return { videoUrl: capturedHlsUrl };
    }

  } catch (e) {
    console.warn(`[nba-scrape] Puppeteer fallback failed for ${gameId}: ${e.message}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
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

  const streamerList = streamersParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!streamerList.length) return res.status(400).json({ error: 'no streamers provided' });

  const clientId = process.env.TWITCH_CLIENT_ID;
  const token    = process.env.TWITCH_TOKEN;
  if (!clientId || !token) return res.status(500).json({ error: 'TWITCH_CLIENT_ID / TWITCH_TOKEN not set' });

  try {
    // Resolve user IDs in one batch call
    const userResp = await axios.get(
      `https://api.twitch.tv/helix/users?${streamerList.map(s => `login=${s}`).join('&')}`,
      { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${token}` }, timeout: 10000 }
    );
    const users = userResp.data?.data || [];

    // Fetch recent clips for each resolved user in parallel.
    // Recency: last 24h first; if a streamer has none, fall back to last 7d.
    const fetchClips = async (userId, sinceIso) => {
      const startedAt = sinceIso ? `&started_at=${encodeURIComponent(sinceIso)}` : '';
      const resp = await axios.get(
        `https://api.twitch.tv/helix/clips?broadcaster_id=${userId}&first=${clipsPerStreamer}${startedAt}`,
        { headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${token}` }, timeout: 10000 }
      );
      return resp.data?.data || [];
    };

    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const since7d  = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const allClips = (await Promise.all(users.map(async user => {
      try {
        let clips = await fetchClips(user.id, since24h);
        if (!clips.length) {
          console.log(`[twitch/clips-pool] No 24h clips for ${user.login} — falling back to 7d window`);
          clips = await fetchClips(user.id, since7d);
        }
        return clips.map(c => ({
          streamer:  user.display_name || user.login,
          title:     c.title || 'Clip',
          thumbnail: c.thumbnail_url || '',
          duration:  Math.round(c.duration || 0),
          url:       c.url || '',
          slug:      c.id || '',
          game:      c.game_id || '',
          viewCount: c.view_count || 0,
          createdAt: c.created_at || null
        }));
      } catch (e) {
        console.warn(`[twitch/clips-pool] Failed for ${user.login}: ${e.message}`);
        return [];
      }
    }))).flat();

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
      : (summaryData.article?.video ? [summaryData.article.video] : []);
    const topVideos = summaryData.videos || [];
    const all = [...topVideos, ...articleVideos];

    const clips = all
      .map(v => {
        const src = v.links?.source || {};
        const url = src.HLS?.HD?.href || src.HLS?.href || src.HD?.href || src.mezzanine?.href || '';
        if (!url) return null;
        return {
          headline: v.headline || v.title || 'Clip',
          duration: v.duration || 0,
          url,
          thumbnail: (typeof v.thumbnail === 'string' ? v.thumbnail : v.thumbnail?.href) || ''
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
  // Short-form clips need 30-90s for split-screen. Long-form needs ≥ 30s for narration value.
  const isShortFormRequest = formType === 'short';
  const minDurationSecs = isShortFormRequest ? 30 : 30;
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

    // Merge article.video + summaryData.videos into one pool, then pick by duration.
    // article.video[0] was previously assumed to always be the highlights reel, but ESPN
    // sometimes puts short stat/milestone clips (16-27s) there instead. Picking by duration
    // is the only reliable way to get the actual highlights compilation for long form.
    const articleVideos = Array.isArray(summaryData.article?.video)
      ? summaryData.article.video
      : (summaryData.article?.video ? [summaryData.article.video] : []);
    const topVideos = summaryData.videos || [];
    const videos = [...topVideos, ...articleVideos];

    if (!videos.length) {
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No videos found for game ${gameId} — ESPN API returned empty videos[]. Game may be too recent or too old.`
      });
    }

    console.log(`[nba-scrape] Found ${videos.length} total videos for game ${gameId} (${topVideos.length} top + ${articleVideos.length} article)`);

    // Select best clip by form type from the merged pool.
    // Long-form: prefer "Game Highlights" titled clip (the actual compiled reel ESPN produces).
    //   Fall back to longest clip only if no highlights-titled clip exists.
    //   Duration-only selection is unreliable — player feature clips ("Ant drops 36 points", 109s)
    //   can beat the actual "Game Highlights" reel (107s) by a few seconds.
    // Short-form: prefer 30-90s range; fall back to longest if none in range.
    const videoPool = videos;
    console.log(`[nba-scrape]   Using full pool of ${videoPool.length} videos`);

    const isHighlightsReel = (v) => {
      const t = (v.headline || v.title || v.description || '').toLowerCase();
      return /game highlights|highlights$/i.test(t);
    };

    // Log all clips for diagnostics
    for (const video of videoPool) {
      const title = video.headline || video.title || video.description || '';
      console.log(`[nba-scrape]   Video: "${title}" (${video.duration || 0}s)${isHighlightsReel(video) ? ' ← HIGHLIGHTS REEL' : ''}`);
    }

    let highestDurationVideo = null;
    let maxDuration = 0;
    let shortFormPreferred = null;

    for (const video of videoPool) {
      const duration = video.duration || 0;
      if (duration > maxDuration) {
        maxDuration = duration;
        highestDurationVideo = video;
      }
      if (isShortFormRequest && duration >= minDurationSecs && duration <= maxDurationSecs) {
        if (!shortFormPreferred || duration > (shortFormPreferred.duration || 0)) {
          shortFormPreferred = video;
        }
      }
    }

    if (!isShortFormRequest) {
      // Long-form: prefer the "Game Highlights" reel over pure duration
      const highlightsReelCandidates = videoPool.filter(isHighlightsReel);
      if (highlightsReelCandidates.length > 0) {
        // Among highlights reels, pick the longest
        const best = highlightsReelCandidates.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
        console.log(`[nba-scrape] ✅ Gate 0 PASS: Selected "Game Highlights" reel: "${best.headline || best.title}" (${best.duration}s)`);
        highestDurationVideo = best;
        maxDuration = best.duration || 0;
      } else {
        console.log(`[nba-scrape] ✅ Gate 0 PASS: Selected longest duration video: "${(highestDurationVideo?.headline || highestDurationVideo?.title) || '?'}" (${maxDuration}s)`);
      }
    }

    // Short-form: use preferred 30-90s clip if found, otherwise fall back to longest
    if (isShortFormRequest && shortFormPreferred) {
      highestDurationVideo = shortFormPreferred;
      maxDuration = shortFormPreferred.duration || 0;
      console.log(`[nba-scrape] Short-form: selected ${maxDuration}s clip in target 30-90s range`);
    } else if (isShortFormRequest) {
      console.warn(`[nba-scrape] Short-form: no clip in 30-90s range found — falling back to longest (${maxDuration}s)`);
    }

    if (!highestDurationVideo) {
      console.warn(`[nba-scrape] No valid video with duration found`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No video with duration >0 found for game ${gameId} — ESPN may not have processed highlights yet.`
      });
    }

    // Step 4: Extract best quality video URL — prefer Akamai HLS (stable, no expiry)
    // over direct CDN MP4 (expires within seconds of being generated)
    const links = highestDurationVideo.links || {};
    const source = links.source || {};
    let videoUrl = source.HLS?.HD?.href
      || source.HLS?.href
      || source.HD?.href
      || source.mezzanine?.href
      || source.full?.href
      || source.href
      || links.mobile?.href
      || '';

    // Gate 0: Validate the selected URL is usable
    // Puppeteer already ran first and failed, so no further fallback is available.
    if (!videoUrl) {
      console.error(`[nba-scrape] Gate 0 FAIL: No usable video URL found for game ${gameId}`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clip URL found for game ${gameId} — Puppeteer failed and API returned metadata but no downloadable URL. Check ESPN API response at: ${summaryUrl}`
      });
    }

    // Gate 0: Validate duration meets minimum threshold (30s for short-form, 10s for long-form)
    if (maxDuration > 0 && maxDuration < minDurationSecs) {
      console.warn(`[nba-scrape] Gate 0 WARN: Best video for game ${gameId} is only ${maxDuration}s — below ${minDurationSecs}s minimum (formType: ${formType || 'long'})`);
      return res.json({
        ok: false,
        gate0: 'fail',
        error: `No valid highlight clips found for game ${gameId} — longest clip is only ${maxDuration}s (minimum: ${minDurationSecs}s for ${isShortFormRequest ? 'short-form' : 'long-form'})`
      });
    }

    // Also extract thumbnail
    const thumbnail = highestDurationVideo.thumbnail || '';

    console.log(`[nba-scrape] ✅ Gate 0 PASS: Selected longest duration video: "${highestDurationVideo.headline || highestDurationVideo.title || 'Game Highlights'}" (${maxDuration}s)`);
    console.log(`[nba-scrape]    URL: ${videoUrl.slice(0, 80)}...`);

    // Download immediately — ESPN CDN URLs expire within seconds
    const tmpPathApi = path.join(__dirname, 'tmp', `nba_highlight_${gameId}_${Date.now()}.mp4`);
    let localPathApi = null;
    try {
      const { execFile } = require('child_process');
      const ffmpegBin = ffmpegPath();
      const ffmpegArgs = ['-i', videoUrl, '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-y', tmpPathApi];
      await new Promise((resolve, reject) => {
        execFile(ffmpegBin, ffmpegArgs, { timeout: 120000 }, (err) => err ? reject(err) : resolve());
      });
      const sizeApi = fs.existsSync(tmpPathApi) ? fs.statSync(tmpPathApi).size : 0;
      if (sizeApi > 1000) {
        localPathApi = tmpPathApi;
        console.log(`[nba-scrape] ✅ Downloaded highlight to ${tmpPathApi} (${(sizeApi/1024/1024).toFixed(1)}MB)`);
      }
    } catch(e) {
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
      source: 'api'
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
    if (!hlsUrl) issues.push('scrapeArticleVideo returned null (no Brightcove embed or yt-dlp failed on embed URL)');
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
  const hasFail = checks.brightcoveReachable === false || checks.ytdlpExtract === false || checks.durationOk === false;
  const hasWarning = checks.dimensionsOk === false || checks.durationOk === 'warning' || checks.ogImageReachable === false;
  const status = hasFail ? 'fail' : hasWarning ? 'warning' : 'ok';

  return { ...v, validation: { status, checks, issues } };
}

// ── AJ Sitemap-driven article discovery ──────────────────────────────────────
// Fetches Al Jazeera's per-day sitemap XML, filters to US-topic news articles.
// Excludes: /liveblog/ /video/ /longform/ /podcasts/ (no video or wrong format)
// Returns array of article URL strings.
async function fetchAjSitemapUrls(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  const sitemapUrl = `https://www.aljazeera.com/sitemap.xml?yyyy=${yyyy}&mm=${mm}&dd=${dd}`;

  console.log(`[fetchAjSitemapUrls] Fetching ${sitemapUrl}`);
  const resp = await axios.get(sitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' }
  });

  const xml = resp.data || '';
  // Extract all <loc> URLs from the sitemap XML
  const locMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
  const allUrls = locMatches
    .map(m => m.replace(/<\/?loc>/g, '').trim())
    .filter(u => u.startsWith('https://www.aljazeera.com/'));

  // Exclude non-article paths — return ALL remaining articles (no topic keyword filter)
  const EXCLUDE_PATHS = ['/liveblog/', '/video/', '/longform/', '/podcasts/', '/program/'];
  const articleUrls = allUrls.filter(u => !EXCLUDE_PATHS.some(p => u.includes(p)));

  console.log(`[fetchAjSitemapUrls] ${allUrls.length} total → ${articleUrls.length} articles (all topics)`);
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
  const hub = String(hubUrl || '').trim().replace(/\/?$/, '/');
  if (!hub) return [];
  const resp = await axios.get(hub, {
    timeout: 25000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
  });
  const $ = cheerio.load(resp.data || '');
  const out = [];
  const badPath = (p) =>
    /\/(features|opinion|longform|podcasts|program|gallery|sport|sports)\b/i.test(p);
  const looksArticle = (p) =>
    ajArticleHasDatedSlugPath(p) &&
    (AJ_ALLOWED_SECTION_PATH_RE.test(p) || /\/news\//i.test(p));
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
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', hlsUrl],
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CWN/1.0)' }
    });
    const text = String(resp.data || '');
    if (!text.includes('#EXTM3U')) return null;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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
        url: variantUrl
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
        sourceHeight: best.h
      };
    }
    variants.sort((a, b) => b.w * b.h - a.w * a.h);
    const best = variants[0];
    return {
      hlsUrl: masterHlsUrl,
      orientation: 'landscape',
      sourceWidth: best.w,
      sourceHeight: best.h
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
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          hlsUrl
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
    if (t === '' || t === '0' || t.toLowerCase() === 'off' || t.toLowerCase() === 'false') return [];
    return t.split(/[\n,]+/).map((s) => stripAjPageFragment(s.trim())).filter(Boolean);
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

  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

  let candidateUrls = [];
  if (Array.isArray(forcedCandidates) && forcedCandidates.length > 0) {
    candidateUrls = forcedCandidates.map((u) => stripAjPageFragment(String(u))).filter(Boolean);
    console.log(`[scrapeAjNewsVideos] Using ${candidateUrls.length} forced candidate URL(s)`);
  } else {
    try {
      const [todayUrls, yestUrls] = await Promise.all([
        fetchAjSitemapUrls(today),
        fetchAjSitemapUrls(yesterday)
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
      const primaryHubUrl = process.env.NEWS_US_PRIMARY_HUB_URL || 'https://www.aljazeera.com/where/united-states/';
      const fallbackHubUrl = process.env.NEWS_US_CANADA_HUB_URL || 'https://www.aljazeera.com/us-canada/';
      let primaryHubUrls = [];
      let fallbackHubUrls = [];
      try {
        primaryHubUrls = await fetchAjHubArticleUrls(primaryHubUrl, 50);
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Primary hub fetch failed (${primaryHubUrl}): ${e.message}`);
      }
      try {
        fallbackHubUrls = await fetchAjHubArticleUrls(fallbackHubUrl, 50);
      } catch (e) {
        console.warn(`[scrapeAjNewsVideos] Fallback hub fetch failed (${fallbackHubUrl}): ${e.message}`);
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
        sitemapAllowed.filter((u) => !/\/where\/united-states\//i.test(u) && !/\/us-canada\//i.test(u))
      );
      const hubUrlSet = new Set(
        [...primaryHubUrls, ...fallbackHubUrls].map((u) => stripAjPageFragment(String(u)))
      );
      candidateUrls = candidateUrls.map((u) => stripAjPageFragment(String(u))).filter((u) => {
        if (!u) return false;
        if (hubUrlSet.has(u)) return ajArticlePathFromHubQueues(u);
        return ajArticlePathFromSitemapStrict(u);
      });
      console.log(
        `[scrapeAjNewsVideos] Candidate order: primaryHub=${primaryHubUrls.length}, fallbackHub=${fallbackHubUrls.length}, ` +
          `sitemap where/united-states=${sitemapWhereUs.length}, sitemap /us-canada/=${sitemapUsCanada.length}, ` +
          `US-first filter (hub=/news|section, sitemap=section only) → ${candidateUrls.length} URL(s)`
      );
      // Thin-pool top-up (CPD-963): when the news cycle is dominated by non-US
      // sections (e.g. Iran war 2026-06-12 → US pool = 0), the strict filter
      // starves the scraper and the operator sees 0 stories. Top up with
      // all-topics sitemap articles, US-first ordering preserved. Puppeteer +
      // Brightcove confirmation still gates what gets returned.
      const MIN_CANDIDATES = Math.max(targetCount * 3, 12);
      if (candidateUrls.length < MIN_CANDIDATES) {
        const seenTopUp = new Set(candidateUrls);
        let added = 0;
        for (const raw of mergedSitemap) {
          if (candidateUrls.length >= MIN_CANDIDATES * 2) break;
          const u = stripAjPageFragment(String(raw));
          if (!u || seenTopUp.has(u) || !ajAljazeeraArticleBaseOk(u)) continue;
          seenTopUp.add(u);
          candidateUrls.push(u);
          added++;
        }
        console.log(`[scrapeAjNewsVideos] Thin US pool — topped up with ${added} all-topics sitemap article(s) → ${candidateUrls.length} total`);
      }
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
    console.log(`[scrapeAjNewsVideos] Prepended ${pinned.length} pinned URL(s) (NEWS_AJ_PINNED_URLS)`);
  }

  if (candidateUrls.length === 0) {
    console.warn('[scrapeAjNewsVideos] No candidate URLs (sitemap + pinned empty)');
    return [];
  }

  console.log(`[scrapeAjNewsVideos] Scanning for ${targetCount} videos (no article cap)...`);

  const browser = await puppeteer.launch(withPuppeteerExecutable({
    headless: 'new',
    // Default 30s protocolTimeout caused "Target.closeTarget timed out" aborts
    // mid-scan (seen 2026-06-12); slow Brightcove pages need more headroom.
    protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }));

  try {
    for (const articleUrl of candidateUrls) {
      // Stop as soon as we have enough confirmed videos
      if (results.length >= targetCount) break;

      let capturedHls   = null;
      let capturedVideoId = null;

      const page = await browser.newPage();
      try {
        // Spoof a real browser UA so AJ doesn't serve a bot-detection page
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        // Pre-accept GDPR/consent so the wall doesn't stall the page load
        await page.setCookie(
          { name: 'OptanonAlertBoxClosed', value: new Date().toISOString(), domain: '.aljazeera.com', path: '/' },
          { name: 'OptanonConsent',        value: 'isGpcEnabled=0&datestamp=' + encodeURIComponent(new Date().toISOString()) + '&version=202209.1.0&isIABGlobal=false&hosts=&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A1&AwaitingReconsent=false', domain: '.aljazeera.com', path: '/' }
        );
        // Intercept requests: block heavy assets to speed up load, let Brightcove API through
        await page.setRequestInterception(true);
        const BLOCK_TYPES = new Set(['image', 'font', 'media']);
        const BLOCK_DOMAINS = ['googlesyndication.com', 'doubleclick.net', 'googletagmanager.com',
          'google-analytics.com', 'facebook.net', 'scorecardresearch.com', 'quantserve.com'];
        page.on('request', req => {
          const url = req.url();
          if (BLOCK_TYPES.has(req.resourceType()) ||
              BLOCK_DOMAINS.some(d => url.includes(d))) {
            req.abort();
          } else {
            req.continue();
          }
        });

        page.on('response', async resp => {
          const url = resp.url();
          // Brightcove playback API returns JSON with HLS sources
          if (url.includes('edge.api.brightcove.com') ||
              url.includes('/accounts/665003303001/videos/')) {
            try {
              const json = await resp.json();
              const sources = json.sources || [];
              // Prefer HLS manifest (application/x-mpegURL or .m3u8)
              const hls = sources.find(s =>
                (s.type === 'application/x-mpegURL' ||
                 (s.src && s.src.includes('.m3u8'))) &&
                s.src && s.src.includes('manifest.prod.boltdns.net')
              );
              if (hls && hls.src && !capturedHls) {
                capturedHls = hls.src;
                capturedVideoId = json.id || url.match(/videos\/(\d+)/)?.[1] || null;
                console.log(`[scrapeAjNewsVideos] Captured HLS for ${articleUrl.slice(-60)}: ${hls.src.slice(0, 80)}`);
              }
            } catch (_) {}
          }
        });

        await page.goto(stripAjPageFragment(articleUrl), { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Scroll to trigger lazy-loaded players
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await new Promise(r => setTimeout(r, 2000));

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
              const dims = resMatches.map(m => ({ w: parseInt(m[1], 10), h: parseInt(m[2], 10) }));
              dims.sort((a, b) => (b.w * b.h) - (a.w * a.h));
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
      console.log(`[scrapeAjNewsVideos] ✅ ${orientation.toUpperCase()} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`);

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
        videoId:        capturedVideoId,
        hlsUrl:         effectiveHls,
        orientation,
        pillarboxFilter,
        sourceWidth:    manifestWidth,
        sourceHeight:   manifestHeight
      });

      console.log(`[scrapeAjNewsVideos] ✅ added ${orientation} ${manifestWidth}x${manifestHeight}: ${articleUrl.slice(-60)}`);
    }
  } finally {
    await browser.close();
  }

  const landscape = results.filter(r => r.orientation === 'landscape').length;
  const portrait  = results.filter(r => r.orientation === 'portrait').length;
  console.log(`[scrapeAjNewsVideos] Done: ${results.length} with video (${landscape} landscape, ${portrait} portrait)`);
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
    `drawbox=x='(${targetW}+iw)/2':y=0:w=4:h=${targetH}:color=0xc7af4f@1.0:t=fill`
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
      console.log('[news/us-canada-videos] Gate 0: 0 videos — asking Gemini to select best candidates for retry...');
      try {
        const [todayUrls, yestUrls] = await Promise.all([
          fetchAjSitemapUrls(new Date()),
          fetchAjSitemapUrls(new Date(Date.now() - 86400000))
        ]);
        const merged = [...todayUrls, ...yestUrls].filter((u) => ajArticlePathFromSitemapStrict(String(u)));
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
          const slugList = allUrls.map((u, i) => `${i + 1}. ${u.split('/').filter(Boolean).pop()}`).join('\n');
          const geminiPrompt = `You are selecting news articles for a video show. From this list of Al Jazeera article slugs, pick the 8 most likely to have an embedded video (breaking news, conflict, politics, interviews tend to have video; opinion/analysis rarely do). Return ONLY a JSON array of the numbers you selected, e.g. [1,3,7,12,15,18,22,25]. No explanation.\n\n${slugList}`;
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            { contents: [{ parts: [{ text: geminiPrompt }] }] },
            { timeout: 15000 }
          );
          const geminiText = ((geminiResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('') || '').trim();
          const match = geminiText.match(/\[[\d,\s]+\]/);
          if (match) {
            const indices = JSON.parse(match[0]).map(n => n - 1).filter(n => n >= 0 && n < allUrls.length);
            const candidateUrls = indices.map(n => allUrls[n]);
            console.log(`[news/us-canada-videos] Gate 0 Gemini picked ${candidateUrls.length} candidates — retrying scrape...`);
            ajVideos = await scrapeAjNewsVideos(5, candidateUrls);
            console.log(`[news/us-canada-videos] Gate 0 retry: ${ajVideos.length} videos found`);
          }
        }
      } catch (e) {
        console.warn(`[news/us-canada-videos] Gate 0 Gemini recovery failed: ${e.message}`);
      }
    }

    // Convert to the video object shape the dashboard expects
    const videos = ajVideos.map(v => {
      const dateMatch = v.articleUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
      let publishedAt = new Date().toISOString();
      if (dateMatch) {
        const [_, yyyy, mm, dd] = dateMatch;
        publishedAt = new Date(`${yyyy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}T23:59:59Z`).toISOString();
      }
      const rawSlug = v.articleUrl.split('/').filter(Boolean).pop() || '';
      const slug = rawSlug.split('?')[0]; // strip ?update=... query params from live-blog URLs
      const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      return {
        url:          v.articleUrl,
        href:         v.articleUrl.replace('https://www.aljazeera.com', ''),
        title:        title || '(untitled)',
        thumbnail:    null,
        publishedAt,
        hlsUrl:       v.hlsUrl,
        orientation:  v.orientation,       // 'landscape' | 'portrait'
        pillarboxFilter: v.pillarboxFilter  // null or FFmpeg filter string
      };
    });

    videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const landscape = videos.filter(v => v.orientation === 'landscape').length;
    const portrait  = videos.filter(v => v.orientation === 'portrait').length;

    const hint = videos.length === 0
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
      source: 'AJ where/united-states first, fallback us-canada — Puppeteer Brightcove — landscape + portrait — duration ≤ NEWS_AJ_MAX_CLIP_SEC',
      landscape,
      portrait
    });
  } catch (err) {
    console.error('[news/us-canada-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// ── BBC news scraper ─────────────────────────────────────────────────────────
// Fetches BBC US/Canada RSS, runs yt-dlp in parallel on each article, returns
// only articles that have an extractable video.
// Returns items in the same shape as /news/us-canada-videos.

const BBC_RSS_URLS = [
  'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
  'https://feeds.bbci.co.uk/news/world/rss.xml'
];
const BBC_YTDLP_CONCURRENCY = 8;   // parallel yt-dlp workers — local machine, no throttle needed
const BBC_FETCH_LIMIT      = 30;   // articles to attempt (40% hit rate → ~12 videos from 30)
const BBC_VIDEO_MIN_SEC    = 8;
const BBC_VIDEO_MAX_SEC    = parseInt(process.env.NEWS_BBC_MAX_CLIP_SEC || '180');

/**
 * Parse a simple RSS feed with axios — no external xml parser needed.
 * Returns [{ title, link, pubDate, description }]
 */
function parseBbcRss(xmlText) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const block = m[1];
    const title   = (block.match(/<title><!\[CDATA\[([^\]]*)\]\]><\/title>/) || block.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const link    = (block.match(/<link>([^<]*)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] || '';
    const desc    = (block.match(/<description><!\[CDATA\[([^\]]*)\]\]><\/description>/) || block.match(/<description>([^<]*)<\/description>/) || [])[1] || '';
    if (link && link.includes('bbc.com/news')) items.push({ title: title.trim(), link: link.trim(), pubDate: pubDate.trim(), description: desc.replace(/<[^>]+>/g,'').trim() });
  }
  return items;
}

/**
 * Run yt-dlp on a single BBC article URL.
 * Returns { url, title, hlsUrl, duration, thumbnail, publishedAt } or null.
 */
async function extractBbcVideo(articleUrl) {
  return new Promise(resolve => {
    let out = '';
    const { execFile } = require('child_process');
    const proc = execFile('yt-dlp', ['--no-download', '--dump-json', articleUrl], { timeout: 14000 });
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      try {
        const d = JSON.parse(out);
        const duration = d.duration || 0;
        if (!duration || duration < BBC_VIDEO_MIN_SEC || duration > BBC_VIDEO_MAX_SEC) return resolve(null);
        // Prefer HLS manifest over DASH for compatibility
        const formats = d.formats || [];
        let hlsUrl = null;
        for (const f of formats) {
          const u = f.url || '';
          if (u.includes('.m3u8') && (f.vcodec !== 'none') && f.height && f.height >= 360) {
            if (!hlsUrl) hlsUrl = u;
          }
        }
        // Fall back to best available URL if no HLS
        if (!hlsUrl) hlsUrl = d.url || null;
        if (!hlsUrl) return resolve(null);

        resolve({
          url:         articleUrl,
          title:       d.title || '',
          hlsUrl,
          duration,
          thumbnail:   d.thumbnail || null,
          publishedAt: d.upload_date
            ? new Date(`${d.upload_date.slice(0,4)}-${d.upload_date.slice(4,6)}-${d.upload_date.slice(6,8)}`).toISOString()
            : new Date().toISOString(),
          orientation: 'landscape',   // BBC is always landscape 16:9 — fits 1920x1080 assembly frame directly
          pillarboxFilter: null,
          source: 'bbc'
        });
      } catch(_) { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Scrape BBC news articles with video. Returns up to `limit` results.
 */
async function scrapeBbcNewsVideos(limit = 10) {
  // Fetch both RSS feeds in parallel, dedupe by URL
  const feeds = await Promise.allSettled(
    BBC_RSS_URLS.map(u => axios.get(u, { timeout: 10000 }))
  );
  const seen = new Set();
  const articles = [];
  for (const r of feeds) {
    if (r.status !== 'fulfilled') continue;
    for (const item of parseBbcRss(r.value.data)) {
      const key = item.link.split('?')[0];
      if (!seen.has(key)) { seen.add(key); articles.push(item); }
    }
  }

  console.log(`[bbc-scraper] ${articles.length} unique articles from RSS — testing ${Math.min(articles.length, BBC_FETCH_LIMIT)} for video...`);

  // Run yt-dlp in batches of BBC_YTDLP_CONCURRENCY
  const candidates = articles.slice(0, BBC_FETCH_LIMIT);
  const results = [];
  for (let i = 0; i < candidates.length && results.length < limit; i += BBC_YTDLP_CONCURRENCY) {
    const batch = candidates.slice(i, i + BBC_YTDLP_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(art => extractBbcVideo(art.link).then(v => {
      if (v) {
        // Merge RSS title/desc (cleaner than URL-slug title) if yt-dlp title is short
        if (!v.title || v.title.length < 10) v.title = art.title;
        v.description = art.description || '';
      }
      return v;
    })));
    for (const v of batchResults) {
      if (v && results.length < limit) results.push(v);
    }
  }

  console.log(`[bbc-scraper] ✅ ${results.length} BBC articles with video (tested ${Math.min(candidates.length, BBC_FETCH_LIMIT)})`);
  return results;
}

// ── AP / Reuters YouTube channel scrapers ────────────────────────────────────
// AP and Reuters block direct article scraping (JS-rendered / bot-blocked).
// Their YouTube channels post the same stories as short clips (20-150s) —
// 100% hit rate since the channel only contains videos.

const YT_NEWS_CHANNELS = {
  ap:      { handle: '@AssociatedPress/videos', label: 'AP',      maxSec: 180 },
  reuters: { handle: '@Reuters/videos',         label: 'Reuters', maxSec: 180 },
};

/**
 * Scrape a YouTube news channel for recent short clips.
 * Returns items in the same shape as the BBC/AJ scrapers.
 */
async function scrapeYtNewsChannel(source, limit = 12) {
  const cfg = YT_NEWS_CHANNELS[source];
  if (!cfg) throw new Error(`Unknown YT news source: ${source}`);

  const channelUrl = `https://www.youtube.com/${cfg.handle}`;

  // Step 1: get playlist metadata (fast, no video download)
  const ids = await new Promise((resolve, reject) => {
    let out = '';
    const { execFile } = require('child_process');
    const proc = execFile('yt-dlp', [
      '--no-download', '--dump-json', '--flat-playlist',
      '--playlist-end', String(Math.min(limit * 3, 40)), // over-fetch to account for long-form
      channelUrl
    ], { timeout: 30000 });
    proc.stdout.on('data', d => out += d);
    proc.on('close', () => {
      const entries = out.trim().split('\n').filter(Boolean).flatMap(line => {
        try {
          const d = JSON.parse(line);
          const dur = d.duration || 0;
          if (dur > 0 && dur <= cfg.maxSec) return [{ id: d.id, title: d.title || '', duration: dur }];
        } catch(_) {}
        return [];
      });
      console.log(`[${source}-yt] Playlist: ${entries.length} clips ≤${cfg.maxSec}s`);
      resolve(entries);
    });
    proc.on('error', reject);
  });

  if (!ids.length) return [];

  // Step 2: extract direct video URLs in parallel batches
  const CONCURRENCY = 6;
  const results = [];
  for (let i = 0; i < ids.length && results.length < limit; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(entry => new Promise(resolve => {
      const { execFile } = require('child_process');
      const ytUrl = `https://www.youtube.com/watch?v=${entry.id}`;
      const proc = execFile('yt-dlp',
        ['--get-url', '-f', 'best[ext=mp4][height<=720]/best[ext=mp4]/best', ytUrl],
        { timeout: 14000 }
      );
      let url = '';
      proc.stdout.on('data', d => url += d);
      proc.on('close', () => {
        const hlsUrl = url.trim().split('\n')[0].trim();
        if (!hlsUrl || hlsUrl.length < 20) return resolve(null);
        resolve({
          url:         ytUrl,
          title:       entry.title,
          hlsUrl,
          duration:    entry.duration,
          thumbnail:   `https://i.ytimg.com/vi/${entry.id}/maxresdefault.jpg`,
          publishedAt: new Date().toISOString(), // channel doesn't give publish date in flat mode
          orientation: 'landscape',   // AP/Reuters YouTube clips are 16:9 — fit 1920x1080 assembly frame directly
          pillarboxFilter: null,
          source
        });
      });
      proc.on('error', () => resolve(null));
    })));
    for (const v of batchResults) { if (v && results.length < limit) results.push(v); }
  }

  console.log(`[${source}-yt] ✅ ${results.length} extractable clips`);
  return results;
}

// GET /news/ap-videos
app.get('/news/ap-videos', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '12'), 20);
    const videos = await scrapeYtNewsChannel('ap', limit);
    return res.json({ ok: true, source: 'ap', videos, recentCount: videos.length, totalFound: videos.length });
  } catch (err) {
    console.error('[news/ap-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// GET /news/reuters-videos
app.get('/news/reuters-videos', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '12'), 20);
    const videos = await scrapeYtNewsChannel('reuters', limit);
    return res.json({ ok: true, source: 'reuters', videos, recentCount: videos.length, totalFound: videos.length });
  } catch (err) {
    console.error('[news/reuters-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// GET /news/bbc-videos — BBC news video scraper endpoint
app.get('/news/bbc-videos', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '12'), 20);
    const videos = await scrapeBbcNewsVideos(limit);
    return res.json({
      ok: true,
      source: 'bbc',
      videos,
      recentCount: videos.length,
      totalFound: videos.length
    });
  } catch (err) {
    console.error('[news/bbc-videos] Error:', err.message);
    return res.status(500).json({ error: err.message, videos: [], recentCount: 0 });
  }
});

// Per-source result cache — protects "All Sources" from transient yt-dlp failures.
// If a source returns 0 results (cold-start rate-limit, network blip), the last
// successful batch is served instead. TTL: 30 min.
const _newsSourceCache = {};
const NEWS_SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;

function _cacheNewsResults(src, videos) {
  if (videos.length > 0) {
    _newsSourceCache[src] = { videos, ts: Date.now() };
  }
}

function _getCachedNewsResults(src) {
  const entry = _newsSourceCache[src];
  if (!entry) return null;
  if (Date.now() - entry.ts > NEWS_SOURCE_CACHE_TTL_MS) return null;
  return entry.videos;
}

// GET /news/stories?source=aljazeera|bbc|all — unified multi-source news endpoint
// Replaces hardcoded /news/us-canada-videos calls when source != aljazeera.
// Returns same video shape as /news/us-canada-videos so dashboard needs minimal change.
app.get('/news/stories', async (req, res) => {
  const source = (req.query.source || 'aljazeera').toLowerCase();
  const limit  = Math.min(parseInt(req.query.limit || '12'), 20);

  try {
    let videos = [];

    // Run all requested sources in parallel — local machine, accuracy > speed
    const fetchTasks = [];

    if (source === 'aljazeera' || source === 'all') {
      fetchTasks.push(
        axios.get(`http://localhost:${process.env.PORT || 3000}/news/us-canada-videos`, { timeout: 180000 })
          .then(r => {
            const v = (r.data?.videos || []).map(v => ({ ...v, source: 'aljazeera' }));
            _cacheNewsResults('aljazeera', v);
            console.log(`[news/stories] AJ: ${v.length} videos`);
            return v;
          })
          .catch(e => {
            console.warn(`[news/stories] AJ failed: ${e.message}`);
            const cached = _getCachedNewsResults('aljazeera');
            if (cached) { console.log(`[news/stories] AJ: using ${cached.length} cached videos`); return cached; }
            return [];
          })
      );
    }

    if (source === 'bbc' || source === 'all') {
      const bbcLimit = source === 'all' ? 8 : limit;
      fetchTasks.push(
        scrapeBbcNewsVideos(bbcLimit)
          .then(v => {
            _cacheNewsResults('bbc', v);
            console.log(`[news/stories] BBC: ${v.length} videos`);
            if (v.length === 0) {
              const cached = _getCachedNewsResults('bbc');
              if (cached) { console.log(`[news/stories] BBC: 0 fresh — using ${cached.length} cached`); return cached; }
            }
            return v;
          })
          .catch(e => {
            console.warn(`[news/stories] BBC failed: ${e.message}`);
            const cached = _getCachedNewsResults('bbc');
            if (cached) { console.log(`[news/stories] BBC: using ${cached.length} cached videos`); return cached; }
            return [];
          })
      );
    }

    if (source === 'ap' || source === 'all') {
      const apLimit = source === 'all' ? 6 : limit;
      fetchTasks.push(
        scrapeYtNewsChannel('ap', apLimit)
          .then(v => {
            _cacheNewsResults('ap', v);
            console.log(`[news/stories] AP: ${v.length} videos`);
            if (v.length === 0) {
              const cached = _getCachedNewsResults('ap');
              if (cached) { console.log(`[news/stories] AP: 0 fresh — using ${cached.length} cached`); return cached; }
            }
            return v;
          })
          .catch(e => {
            console.warn(`[news/stories] AP failed: ${e.message}`);
            const cached = _getCachedNewsResults('ap');
            if (cached) { console.log(`[news/stories] AP: using ${cached.length} cached videos`); return cached; }
            return [];
          })
      );
    }

    if (source === 'reuters' || source === 'all') {
      const reutersLimit = source === 'all' ? 6 : limit;
      fetchTasks.push(
        scrapeYtNewsChannel('reuters', reutersLimit)
          .then(v => {
            _cacheNewsResults('reuters', v);
            console.log(`[news/stories] Reuters: ${v.length} videos`);
            if (v.length === 0) {
              const cached = _getCachedNewsResults('reuters');
              if (cached) { console.log(`[news/stories] Reuters: 0 fresh — using ${cached.length} cached`); return cached; }
            }
            return v;
          })
          .catch(e => {
            console.warn(`[news/stories] Reuters failed: ${e.message}`);
            const cached = _getCachedNewsResults('reuters');
            if (cached) { console.log(`[news/stories] Reuters: using ${cached.length} cached videos`); return cached; }
            return [];
          })
      );
    }

    const results = await Promise.all(fetchTasks);
    for (const batch of results) videos.push(...batch);

    // Sort by recency, then dedupe by normalised title (AJ can return URL variants of same story)
    videos.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    const seenTitles = new Set();
    videos = videos.filter(v => {
      const key = (v.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    if (source === 'all') videos = videos.slice(0, limit);

    return res.json({
      ok: true,
      source,
      videos,
      recentCount: videos.length,
      totalFound: videos.length
    });
  } catch (err) {
    console.error('[news/stories] Error:', err.message);
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


app.post('/generate-full-script',
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
        .filter(it => it.hlsUrl || it.videoUrl)
        .map(it => ({
          articleUrl:      it.link || it.url || '',
          title:           it.title || '',
          hlsUrl:          it.hlsUrl || it.videoUrl || '',
          orientation:     (it.sourceOrientation || it.orientation || 'landscape').toLowerCase(),
          pillarboxFilter: it.pillarboxFilter || null
        }));
      console.log(`[/generate-full-script] ajVideoPool built from request items: ${ajVideoPool.length} videos (no re-scrape)`);
    }
    // Create Job Spec at job start — single document every stage reads
    try {
      const { type: contentType, formType, itemCount, title } = req.body;
      const sourceType = (contentType === 'news' || contentType === 'news-short')
        ? 'site_scrape'
        : 'url_list';
      const sourceUrls = Array.isArray(items)
        ? items
            .map(it => it.videoUrl || it.clipUrl || it.url || it.link || null)
            .filter(Boolean)
        : [];
      req.jobSpec = await createJobSpec({
        customerId: req.body.customerId || 'c0',
        showId: req.body.showId || null,
        templateId: formType === 'short' ? 'short-form' : 'long-form',
        contentType,
        createdBy: 'dashboard',
        expectedSynth: !!req.body.expectedSynth,
        sourceType,
        sourceConfig: sourceType === 'site_scrape'
          ? { siteTarget: contentType }
          : { urls: sourceUrls },
        items: Array.isArray(items) ? items : [],
        title: title || null
      });
    } catch (specErr) {
      console.warn('[/generate-full-script] Job Spec creation failed (non-fatal):', specErr.message);
    }
    // Override deliverySpec platforms if caller specified them (e.g. platform selector modal)
    if (req.jobSpec && req.body.platforms && Array.isArray(req.body.platforms) && req.body.platforms.length > 0) {
      req.jobSpec.deliverySpec.platforms = req.body.platforms;
      console.log(`[/generate-full-script] deliverySpec.platforms overridden by request: ${req.body.platforms.join(', ')}`);
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
      console.log(`[PRE-GENERATE] Form factor:   ${req.jobSpec.order?.output?.formFactor} (${req.jobSpec.order?.output?.aspectRatio})`);
      console.log(`[PRE-GENERATE] Resolution:    ${req.jobSpec.order?.output?.resolution?.width}×${req.jobSpec.order?.output?.resolution?.height}`);
      console.log(`[PRE-GENERATE] Platforms:     ${req.jobSpec.deliverySpec?.platforms?.join(', ') || 'none'}`);
      console.log(`[PRE-GENERATE] Avatar ID:     ${req.jobSpec.designSpec?.avatarId?.slice(0,8) || 'n/a'}...`);
      console.log(`[PRE-GENERATE] Expected clips:${req.jobSpec.designSpec?.expectedClipCount ?? 'n/a'}`);
      console.log(`[PRE-GENERATE] Chrome skin:   ${req.jobSpec.designSpec?.chrome?.skin || 'n/a'}`);
      console.log(`[PRE-GENERATE] Outro line:    ${req.jobSpec.designSpec?.voice?.outroLine || 'from customerConfig'}`);
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
            const readiness = typeof gate.canProduce === 'function'
              ? await Promise.resolve(gate.canProduce(req.jobSpec))
              : { ready: true, missing: [] };

            // commit declaration
            const commitment = typeof gate.commit === 'function'
              ? await Promise.resolve(gate.commit(req.jobSpec))
              : { committed: 'no commit() defined' };

            const ready = readiness.ready !== false;
            commitments[name] = { ready, commitment };

            if (!ready) {
              allReady = false;
              console.log(`[${name.toUpperCase()}] ❌ NOT READY: ${(readiness.missing || readiness.reasons || []).map(m => m.item || m).join(', ')}`);
            } else {
              const summary = commitment?.summary || commitment?.committed || 'ready';
              console.log(`[${name.toUpperCase()}] ✅ SIGNED OFF: ${summary}`);
            }
          } catch(gErr) {
            console.log(`[${name.toUpperCase()}] ⚠️  Sign-off error (non-fatal): ${gErr.message}`);
          }
        }

        console.log(sep);
        if (allReady) {
          console.log(`[PRE-GENERATE] ✅ ALL GATES SIGNED OFF — Job confirmed: ${req.jobSpec.jobId}`);
          console.log(`[PRE-GENERATE] 🚀 Production starting — notifying all QA agents`);
          console.log(`[PRE-GENERATE] QA agents briefed on job: ${req.jobSpec.jobId}`);
          console.log(`[PRE-GENERATE] Gate thresholds: G1≥${req.jobSpec.designSpec?.qaThresholds?.gate1?.pass} G2≥${req.jobSpec.designSpec?.qaThresholds?.gate2?.pass} G3a≥${req.jobSpec.designSpec?.qaThresholds?.gate3a?.pass} G4≥${req.jobSpec.designSpec?.qaThresholds?.gate4?.pass}`);
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
          jobSpec: req.jobSpec,  // full jobSpec for gate prepare() pre-work
          commitments,
          allReady
        });

        // NR: job confirmed event — queryable per customer/content type
        nrJobConfirmed(req.jobSpec, allReady);

        preGenerateAllReady = allReady;
        preGenerateCommitments = commitments;
        try {
          persistJobSpecGateContracts(req.jobSpec, commitments);
        } catch (contractErr) {
          console.warn('[PRE-GENERATE] Failed to persist gate contracts (non-fatal):', contractErr.message);
        }
      } catch(commitErr) {
        console.warn('[PRE-GENERATE] Gate sign-off check failed (non-fatal):', commitErr.message);
      }

      // ── QA generate confirm (monitor + optional enforce) ─────────────────
      // Gate workers sign off above; this tracks whether QA should also ack before generate (policy).
      try {
        const qaGen = require('./lib/qa_generate_confirm');
        qaGen.persistAfterPreGenerate(req.jobSpec.jobId, {
          allReady: preGenerateAllReady,
          commitments: preGenerateCommitments
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
            : 'QA generate confirm not required — set QA_CONFIRM_ON_GENERATE=true to enforce QA ack like gate sign-off'
        });
        nrQaGenerateConfirmPolicy(req.jobSpec, {
          policyEnabled: policyOn,
          gateWorkersAllReady: preGenerateAllReady
        });
        if (policyOn) {
          // Same POST must include qaGenerateConfirmed (each generate creates a new jobId — no separate round-trip yet).
          if (!qaGen.requestSaysConfirmed(req.body)) {
            return res.status(422).json({
              error:
                'QA_CONFIRM_ON_GENERATE is enabled: include qaGenerateConfirmed: true on this POST after QA agents agree (same request as gate sign-off). Optional: POST /job/:jobId/qa-confirm-generate for manual DB ack when reusing a job id.',
              needsQaGenerateConfirm: true,
              jobId: req.jobSpec.jobId,
              gateWorkersAllReady: preGenerateAllReady
            });
          }
          qaGen.markConfirmed(req.jobSpec.jobId, { source: 'request_body' });
        }
      } catch (qaErr) {
        console.warn('[generate-full-script] QA generate confirm hook failed (non-fatal):', qaErr.message);
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

        // 2x VIEWING: Watch each reference video 2 times for style learning
        console.log(`[style-library] Starting 2x viewing analysis for ${url.slice(0,60)}...`);
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
                  contents: [{ parts: [
                    { text: stylePrompt },
                    { file_data: { mime_type: 'video/mp4', file_uri: geminiFile.uri } }
                  ]}],
                  generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
                },
                { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
              );
              break; // success
            } catch(retryErr) {
              const is503 = retryErr.response && retryErr.response.status === 503;
              if (is503 && attempt < 3) {
                const backoff = attempt * 15000; // 15s, 30s
                console.warn(`[style-library]   ⚠️ 503 on viewing ${viewNum} attempt ${attempt} — retrying in ${backoff/1000}s`);
                await new Promise(r => setTimeout(r, backoff));
              } else {
                throw retryErr;
              }
            }
          }

          const observation = (genResp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text||'').join('').trim();
          if (observation.length > 100) {
            multipleViewings.push(`--- VIEWING #${viewNum} ---\n${observation}`);
            console.log(`[style-library]   ✓ Viewing ${viewNum}/2 complete (${observation.length} chars)`);
          }

          // Rate limit pause between viewings (shorter than between videos)
          if (viewNum < 2) await new Promise(r => setTimeout(r, 2000));
        }

        // Synthesize all 2 viewings into a deep per-video analysis
        if (multipleViewings.length >= 1) { // Require at least 1 successful viewing
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
              messages: [{ role: 'user', content: deepSynthesisPrompt }]
            });
            const deepAnalysis = msg.content[0]?.text || multipleViewings.join('\n\n');
            videoAnalyses.push(`--- Reference video (2x viewing): ${url.slice(0,60)} ---\n${deepAnalysis}`);
            console.log(`[style-library] ✅ 2x analysis complete for ${url.slice(0,60)} (${deepAnalysis.length} chars)`);
          } catch(e) {
            // Fallback: concatenate all viewings
            videoAnalyses.push(`--- Reference video (2 viewings): ${url.slice(0,60)} ---\n${multipleViewings.join('\n\n')}`);
            console.log(`[style-library] ✅ 2x analysis complete (fallback) for ${url.slice(0,60)}`);
          }
        } else {
          console.warn(`[style-library] Only ${multipleViewings.length}/2 viewings succeeded, skipping video`);
        }

        // Cleanup
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        try {
          await axios.delete(`https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_APIKEY}`);
        } catch(e) {}

        // Rate limit pause between videos — longer to avoid 503s on rapid succession
        await new Promise(r => setTimeout(r, 5000));

      } catch(e) {
        console.warn(`[style-library] Failed for ${url}: ${e.message}`);
        errors[url] = e.message;
      }
    }

    if (videoAnalyses.length > 0) {
      // Synthesize all analyses into one coherent style guide
      const isShortForm = contentType.endsWith('-short');
      const shortConstraints = isShortForm ? `

SHORT-FORM SPECIFIC RULES (this is a 45-60 second vertical video):
- ONE clip, ONE observation, done — no callbacks, no multi-part builds
- Every sentence must earn its place — cut anything that doesn't land immediately
- No setup longer than 2 sentences before the clip
- Post-clip reaction: maximum 2 sentences
- [beat] used once maximum per script
- Must feel complete in under 60 seconds` : '';

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

    // Pause between content types to avoid Gemini 503 rate limits
    await new Promise(r => setTimeout(r, 15000));
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

app.post('/publish', handlePublish);

// ── prioritizeNewsStories ─────────────────────────────────────────────────────
// Reorders news stories by urgency score before Gemini analysis.
// High-priority keywords get a score bump so they appear first in the script.
// Returns: stories[] sorted by descending priority score (stable sort)

// ── generateShortFormCaption ─────────────────────────────────────────────────
// Generates a platform-optimised short-form caption + hashtags + alt-text.
// Returns: { caption: string, hashtags: string[], altText: string }
// Called by /generate-publish-copy when formType === 'short'.

// POST /generate-publish-copy — generates platform-specific publish metadata
// Body: {
//   contentType: 'nba' | 'news' | 'twitch',
//   formType: 'compilation' | 'short',
//   script: string,             // full script text
//   date: string,               // e.g. "Friday, April 6, 2026"
//   streamers: string[],        // for Twitch only (display names)
//   platforms: string[]         // ['youtube', 'tiktok', 'instagram'] - defaults to ['youtube']
// }
app.post('/generate-publish-copy', handleGeneratePublishCopy);

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
            `https://api.heygen.com/v3/videos/${v.video_id}`,
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

async function bulkDeleteHeyGenVideos({ apiKey, dryRun = false, maxPasses = 100, perPassLimit = 100 }) {
  const headers = { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' };
  const failures = [];
  let totalDeleted = 0;
  let totalSeen = 0;
  let passCount = 0;

  const listVideos = async () => {
    const resp = await axios.get(
      `https://api.heygen.com/v1/video.list?limit=${Math.max(1, Math.min(100, perPassLimit))}`,
      { headers: { 'X-Api-Key': apiKey }, timeout: 30000 }
    );
    return resp.data?.data?.videos || [];
  };

  const deleteOne = async (video) => {
    const v1Body = { video_id: video.video_id };
    const attempts = [
      () => axios.post('https://api.heygen.com/v1/video.delete', v1Body, { headers, timeout: 30000 }),
      () => axios.post(
        'https://api.heygen.com/v1/video.delete',
        { video_id: video.video_id, type: video.type || 'GENERATED' },
        { headers, timeout: 30000 }
      ),
      () => axios.delete(`https://api.heygen.com/v3/videos/${video.video_id}`, {
        headers: { 'X-Api-Key': apiKey },
        timeout: 30000
      })
    ];
    let lastErr = null;
    for (const run of attempts) {
      try {
        return await run();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

  while (passCount < maxPasses) {
    passCount++;
    const videos = await listVideos();
    if (!videos.length) break;
    totalSeen += videos.length;
    if (dryRun) continue;

    for (const video of videos) {
      try {
        await deleteOne(video);
        totalDeleted++;
      } catch (err) {
        failures.push({
          video_id: video.video_id,
          title: video.video_title || null,
          error: err.response?.data || err.message || 'unknown_error'
        });
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  const remaining = (await listVideos()).length;
  return {
    passCount,
    totalSeen,
    totalDeleted,
    remaining,
    failedCount: failures.length,
    failures: failures.slice(0, 50)
  };
}

// POST /admin/heygen/delete-all — dangerous operation; token + explicit confirmation required.
// Header: x-admin-token: <HEYGEN_ADMIN_TOKEN>
// Body: { confirmDeleteAll: "DELETE_ALL_HEYGEN_VIDEOS", dryRun?: boolean, maxPasses?: number, perPassLimit?: number }
app.post('/admin/heygen/delete-all', async (req, res) => {
  const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
  if (!HEYGEN_API_KEY) return res.status(400).json({ ok: false, error: 'HEYGEN_API_KEY not set' });

  const adminToken = process.env.HEYGEN_ADMIN_TOKEN;
  if (!adminToken) {
    return res.status(503).json({
      ok: false,
      error: 'HEYGEN_ADMIN_TOKEN not configured; endpoint disabled'
    });
  }

  const requestToken = req.headers['x-admin-token'];
  if (!requestToken || requestToken !== adminToken) {
    return res.status(403).json({ ok: false, error: 'Forbidden: invalid admin token' });
  }

  const confirm = req.body?.confirmDeleteAll;
  if (confirm !== 'DELETE_ALL_HEYGEN_VIDEOS') {
    return res.status(400).json({
      ok: false,
      error: 'Explicit confirmation required',
      expected: { confirmDeleteAll: 'DELETE_ALL_HEYGEN_VIDEOS' }
    });
  }

  try {
    const result = await bulkDeleteHeyGenVideos({
      apiKey: HEYGEN_API_KEY,
      dryRun: !!req.body?.dryRun,
      maxPasses: Math.max(1, Math.min(500, Number(req.body?.maxPasses) || 100)),
      perPassLimit: Math.max(1, Math.min(100, Number(req.body?.perPassLimit) || 100))
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message || 'delete failed',
      details: err.response?.data || null
    });
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
          `https://api.heygen.com/v3/videos/${videoId}`,
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
        execFile(ffprobePath(), [
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
      avatarId: process.env.HEYGEN_AVATAR_ID || '1a5d4e9130d2467fa01d9e1580aff829',
      dimensions: '1920x1080',
      format: 'landscape',
      useFor: 'YouTube long form compilations'
    },
    portrait: {
      avatarId: process.env.HEYGEN_AVATAR_SHORT_ID || 'ed57439c9c3d4a398f3b247b75714b13',
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
    const gate2Worker = require('./lib/gates/gate2');
    const minJobSpec = {
      jobId: jobId || 'manual-qa',
      customerId: req.body.customerId || 'c0',
      templateId: contentType?.includes('short') ? 'short-form' : 'long-form',
      contentType: contentType || 'twitch',
      state: { gateResults: {}, savedOutputs: {} },
      designSpec: { chrome: {}, audio: {}, resolution: { width: 1920, height: 1080 }, ffmpeg: {} },
      commitments: {}
    };
    const g2Result = await gate2Worker.run(minJobSpec, tmpPaths, {});
    // Translate new gate worker output to legacy dashboard format
    const result = {
      score: g2Result.score,
      passed: g2Result.passed,
      outcome: g2Result.outcome === 'hard_fail' ? 'fail' : g2Result.outcome === 'review' ? 'manual_review' : 'pass',
      outcomeLabel: g2Result.passed ? '✅ PASS' : g2Result.outcome === 'review' ? '🟡 MANUAL REVIEW' : '❌ HARD FAIL',
      deductions: (g2Result.segmentResults || []).filter(s => !s.passed).map(s => ({
        points: 25,
        reason: `Segment failed: ${s.segmentPath ? require('path').basename(s.segmentPath) : 'unknown'}`
      }))
    };
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
              `[1:v]scale=${((contentType === 'news') ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).size}:-1,format=rgba,colorchannelmixer=aa=${((contentType === 'news') ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).opacity || 0.85}[logo];[0:v][logo]overlay=${((contentType === 'news') ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).x}:${((contentType === 'news') ? CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS_NEWS : CONFIG.VISUAL_LAYOUTS.LONG_FORM.LOGO_POS).y}[vout]`,
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
  console.log(`   Output dir:  ${OUTPUT_DIR}`);
  const gateTestMode = process.env.GATE_TEST_MODE === 'true';
  if (gateTestMode) {
    console.log(`   ⏸  GATE_TEST_MODE=true — HeyGen auto-send DISABLED ($0.33/segment protected)\n`);
  } else {
    console.log(`   🔴 GATE_TEST_MODE=false — HeyGen auto-send LIVE (each segment costs $0.33)\n`);
  }
  checkFFmpeg((err, v) => {
    if (err) console.warn('⚠️  FFmpeg not found:', err.message);
    else console.log('✅ FFmpeg:', v);
  });
  startMonitoring(); // Start pipeline event monitoring

  // CPD-924: deferred publish cron — fires Gate 5 for 'publish_scheduled' cards when due
  try {
    const { startSchedulingCron } = require('./lib/services/scheduling_cron');
    startSchedulingCron({
      getCards: () => persistedJobs,
      runGate5: _runGate5ForCard,
      saveCard: saveJobCard,
    });
  } catch (e) {
    console.warn('⚠️  Scheduling cron failed to start:', e.message);
  }

  // CPD-975/976: daily programming windows — Twitch loop 12–6pm ET, Live Grid 6pm–3am ET
  try {
    const { startStreamScheduler } = require('./lib/services/stream_scheduler');
    streamScheduler = startStreamScheduler({ baseUrl: `http://localhost:${PORT}` });
  } catch (e) {
    console.warn('⚠️  Stream scheduler failed to start:', e.message);
  }
});

// Graceful shutdown — waits for both HeyGen pollers and in-flight assembly jobs
async function gracefulShutdown(signal) {
  console.log(`\n[shutdown] ${signal} received — checking in-flight work...`);

  const pollerCount   = activePollers.size;
  const assemblyCount = Object.keys(assemblyJobs).filter(id => assemblyJobs[id].status === 'running').length;

  if (pollerCount === 0 && assemblyCount === 0) {
    console.log('[shutdown] No active pollers or assemblies — exiting cleanly');
    process.exit(0);
  }

  console.log(`[shutdown] ${pollerCount} poller(s), ${assemblyCount} assembly job(s) in flight — waiting up to 35s...`);

  // Hard exit after 35s no matter what
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] 35s timeout — forcing exit');
    process.exit(1);
  }, 35000);
  forceTimer.unref();

  // Wait for all pollers to checkpoint their current poll cycle
  if (pollerCount > 0) {
    await Promise.race([
      Promise.all([...activePollers.values()].map(e => e.done)),
      new Promise(r => setTimeout(r, 33000))
    ]);
    console.log('[shutdown] Pollers checkpointed');
  }

  // Wait for running assembly jobs to finish (polls every 1s)
  if (assemblyCount > 0) {
    await Promise.race([
      new Promise(resolve => {
        const interval = setInterval(() => {
          const still = Object.keys(assemblyJobs).filter(id => assemblyJobs[id].status === 'running').length;
          if (still === 0) { clearInterval(interval); resolve(); }
        }, 1000);
      }),
      new Promise(r => setTimeout(r, 30000))
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
    return res.status(500).json({ ok: false, error: 'Template not found: templates/nba_intro_card.html' });
  }

  let browser;
  try {
    console.log(`[nba-intro-card] Generating card for game ${gameId}...`);

    browser = await puppeteer.launch(withPuppeteerExecutable({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
    }));

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
