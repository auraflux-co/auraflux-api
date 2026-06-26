'use strict';

// ── Job Card Persistence ──────────────────────────────────────────────────────
// Owns the in-memory persistedJobs map and all read/write helpers.
// Other modules import `persistedJobs` directly — the object is mutated in place
// so all holders share the same live reference throughout the process lifetime.
//
// Persistence: PostgreSQL only (lib/db/postgres.js).
// In-memory is the source of truth at runtime; Postgres is the durable store.

const db = require('./db');
const { logError } = require('./error_logger');

// Central in-memory store — exported by reference (never reassigned after init)
const persistedJobs = {};

// Expose to assembly.js Portal 2 bypass (avoids circular require)
global.persistedJobsRef = persistedJobs;

// ── Postgres initialisation — call once at server startup ─────────────────────
// Loads all jobs from Postgres into the in-memory persistedJobs map.
// Must be awaited before the server begins serving requests.
async function initJobCardPg() {
  try {
    await db.initDb();
    const pgJobs = await db.loadAllJobs();
    if (pgJobs.length > 0) {
      // Clear + repopulate without reassigning the object (preserves shared references)
      for (const key of Object.keys(persistedJobs)) delete persistedJobs[key];
      for (const card of pgJobs) {
        if (card && card.jobId) persistedJobs[card.jobId] = card;
      }
      console.log(`[db] Loaded ${pgJobs.length} jobs from Postgres`);
    } else {
      console.log('[db] Postgres ready — no existing jobs');
    }
  } catch (e) {
    console.error('[db] Postgres init failed — starting with empty job store:', e.message);
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
          clipTimingTargets: Array.isArray(clipData.clipTimingTargets)
            ? clipData.clipTimingTargets
            : [],
          clipTimingFormat: clipData.clipTimingFormat || 'none',
          storyIndex: clipData.storyIndex ?? i,
          status: 'ready',
        };
      });
      console.log(
        `[jobs] Saved ${card.sourceClipSegments.length} source_clip segments to job card ${jobId}`
      );
    }
  }

  persistedJobs[jobId] = { ...card, savedAt: new Date().toISOString() };

  // Keep global ref in sync so assembly.js Portal 2 bypass can read card state
  if (global.persistedJobsRef) global.persistedJobsRef[jobId] = persistedJobs[jobId];

  // Prune jobs older than 7 days to keep the in-memory map lean
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(persistedJobs)) {
    if (new Date(persistedJobs[id].savedAt || 0).getTime() < cutoff) delete persistedJobs[id];
  }

  // SQLite write is sync; Postgres adapter may return a Promise — handle both.
  try {
    const result = db.saveJob(jobId, persistedJobs[jobId]);
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error('[db] saveJob failed:', err.message));
    }
  } catch (err) {
    console.error('[db] saveJob failed:', err.message);
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
  console.log(
    `[checkContentTypeStuckPattern] ${contentType}: ${stuckCount} stuck jobs in last 24h`
  );

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
  stuckPatternLog,
  initJobCardPg,
  inferJobStage,
  saveJobCard,
  markJobStuck,
  checkContentTypeStuckPattern,
};
