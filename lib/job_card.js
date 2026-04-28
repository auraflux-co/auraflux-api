'use strict';

// ── Job Card Persistence ──────────────────────────────────────────────────────
// Owns the in-memory persistedJobs map and all read/write helpers.
// Other modules import `persistedJobs` directly — the object is mutated in place
// so all holders share the same live reference throughout the process lifetime.

const path = require('path');
const fs = require('fs');
const db = require('./db');
const { logError } = require('./error_logger');

const JOBS_FILE = path.join(__dirname, '..', 'data', 'jobs.json');

// Central in-memory store — exported by reference (never reassigned after init)
const persistedJobs = {};

// Load from disk immediately on require
try {
  const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  Object.assign(persistedJobs, raw);
  console.log(`[jobs] Loaded ${Object.keys(persistedJobs).length} persisted jobs from disk`);
} catch (_e) {
  // No jobs file yet — start empty
}

// Expose to assembly.js Gate 2 bypass (avoids circular require)
global.persistedJobsRef = persistedJobs;

// ── SQLite initialisation — call once at server startup ───────────────────────
// Mutates persistedJobs in place so all existing references remain valid.
function initJobCardSQLite() {
  try {
    db.initDb();
    const sqliteJobs = db.loadAllJobs();
    if (sqliteJobs.length > Object.keys(persistedJobs).length) {
      console.log(
        `[db] SQLite has ${sqliteJobs.length} jobs vs JSON ${Object.keys(persistedJobs).length} — using SQLite as primary`
      );
      // Clear + repopulate without reassigning the object (preserves shared references)
      for (const key of Object.keys(persistedJobs)) delete persistedJobs[key];
      for (const card of sqliteJobs) {
        if (card && card.jobId) persistedJobs[card.jobId] = card;
      }
    } else {
      console.log(`[db] SQLite ready (${sqliteJobs.length} jobs). JSON file is primary for now.`);
    }
  } catch (e) {
    console.error('[db] SQLite init failed — falling back to jobs.json only:', e.message);
  }
}

// ── In-memory stuck-pattern log ───────────────────────────────────────────────
const stuckPatternLog = {}; // { contentType: [timestamp1, timestamp2, ...] }

// Infer job stage from card fields for legacy jobs that predate the explicit stage field.
function inferJobStage(job) {
  if (job.finalUrl) return 'assembled';
  if (job.assembly?.url || job.assembledUrl) return 'assembled';
  const videoJobs = job.heygen?.videoJobs || [];
  if (videoJobs.length > 0) {
    const allComplete = videoJobs.every((vj) => vj.status === 'completed' && vj.video_url);
    if (allComplete) return 'all_sent';
    const anyStarted = videoJobs.some((vj) => vj.video_id);
    if (anyStarted) return 'all_sent';
  }
  if (job.script) return 'script_ready';
  return '';
}

function saveJobCard(jobId, card) {
  // Extract source_clip segments from script and persist on the card
  if (card.script && card.orderedClipUrls) {
    const sourceClipScenes = (card.script.scenes || []).filter((s) => s.type === 'source_clip');
    if (sourceClipScenes.length > 0) {
      card.sourceClipSegments = sourceClipScenes.map((scene, i) => {
        const clipData = card.orderedClipUrls[i] || {};
        return {
          type: 'source_clip',
          sceneId: scene.name,
          label: scene.name || `STORY${i + 1}_CLIP`,
          clipUrl: clipData.clipUrl || clipData.url || '',
          pageUrl: clipData.pageUrl || '',
          clipTimingTargets: Array.isArray(clipData.clipTimingTargets) ? clipData.clipTimingTargets : [],
          clipTimingFormat: clipData.clipTimingFormat || 'none',
          storyIndex: clipData.storyIndex ?? i,
          status: 'ready',
        };
      });
      console.log(`[jobs] Saved ${card.sourceClipSegments.length} source_clip segments to job card ${jobId}`);
    }
  }

  persistedJobs[jobId] = { ...card, savedAt: new Date().toISOString() };

  // Keep global ref in sync so assembly.js Gate 2 bypass can read card state
  if (global.persistedJobsRef) global.persistedJobsRef[jobId] = persistedJobs[jobId];

  // Prune jobs older than 7 days to keep the JSON file small
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(persistedJobs)) {
    if (new Date(persistedJobs[id].savedAt || 0).getTime() < cutoff) delete persistedJobs[id];
  }

  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(persistedJobs, null, 2));
  } catch (e) {
    console.error('[jobs] Failed to save jobs.json:', e.message);
  }

  // SQLite write (additive — runs alongside JSON during transition)
  try {
    db.saveJob(jobId, persistedJobs[jobId]);
  } catch (e) {
    console.error('[db] Failed to save job to SQLite:', e.message);
  }
}

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

  saveJobCard(jobId, card);
  logError(jobId, gate, reason, detail);

  checkContentTypeStuckPattern(card.contentType || 'twitch', jobId);
}

function checkContentTypeStuckPattern(contentType, jobId) {
  const now = Date.now();
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const THRESHOLD = 3;

  if (!stuckPatternLog[contentType]) stuckPatternLog[contentType] = [];

  stuckPatternLog[contentType] = stuckPatternLog[contentType].filter((ts) => now - ts < WINDOW_MS);
  stuckPatternLog[contentType].push(now);

  const stuckCount = stuckPatternLog[contentType].length;
  console.log(`[checkContentTypeStuckPattern] ${contentType}: ${stuckCount} stuck jobs in last 24h`);

  if (stuckCount >= THRESHOLD) {
    if (!global.disabledContentTypes) global.disabledContentTypes = {};
    const reason = `Auto-disabled: ${stuckCount} stuck jobs in 24h (last: ${jobId})`;
    global.disabledContentTypes[contentType] = {
      disabledAt: new Date().toISOString(),
      reason,
      stuckCount,
      lastJobId: jobId,
    };
    console.error(`[checkContentTypeStuckPattern] 🚫 AUTO-DISABLED ${contentType}: ${reason}`);
    logError('SYSTEM', 'AUTO_DISABLE', reason, { contentType, stuckCount, jobId });
  }
}

module.exports = {
  persistedJobs,
  JOBS_FILE,
  stuckPatternLog,
  initJobCardSQLite,
  inferJobStage,
  saveJobCard,
  markJobStuck,
  checkContentTypeStuckPattern,
};
