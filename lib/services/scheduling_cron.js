'use strict';
/**
 * lib/services/scheduling_cron.js — Deferred publish cron (CPD-924)
 *
 * C0 adaptation of production's scheduling_cron.js (CPD-48). Production's
 * version is Postgres-coupled; C0 jobs live in persistedJobs (JSON-file
 * backed, survives restarts), so the cron scans the in-memory card map.
 *
 * Flow:
 *   1. Operator sets a publish time:  POST /job/:id/schedule { scheduledAt }
 *   2. Assembly completes → Gate 4 passes → Gate 5 sees a future
 *      scheduledPublishAt and HOLDS (card.stage = 'publish_scheduled').
 *   3. This cron fires every CRON_INTERVAL_MS; when a held card's time is
 *      due it clears the schedule and runs Gate 5 (same path as run-gate5).
 *
 * Only `publish_scheduled` cards are touched — everything else is ignored.
 */

const CRON_INTERVAL_MS = 60 * 1000;

let _timer = null;

/**
 * @param {Object}   deps
 * @param {Function} deps.getCards  — () => persistedJobs map
 * @param {Function} deps.runGate5  — async (jobId) => void  (server's _runGate5ForCard)
 * @param {Function} [deps.saveCard] — (jobId, card) => void  (server's saveJobCard)
 */
function startSchedulingCron({ getCards, runGate5, saveCard }) {
  if (_timer) return _timer;

  const tick = async () => {
    let cards;
    try { cards = getCards() || {}; } catch { return; }

    const now = Date.now();
    for (const [jobId, card] of Object.entries(cards)) {
      if (!card || card.stage !== 'publish_scheduled') continue;
      const at = card.scheduledPublishAt || card.deliverySpec?.scheduledAt;
      if (!at) continue;
      const due = new Date(at).getTime();
      if (isNaN(due) || due > now) continue;
      if (card._schedFiring) continue; // already firing — don't double-publish

      card._schedFiring = true;
      // Clear the schedule BEFORE firing so Gate 5's pre-publish validation
      // doesn't reject a now-past scheduledAt as "must be a future date".
      card.scheduledPublishAt = null;
      if (card.deliverySpec) card.deliverySpec.scheduledAt = null;
      card.stage = 'gate5_forced';
      if (saveCard) { try { saveCard(jobId, card); } catch {} }

      console.log(`[sched-cron] ${jobId}: scheduled time ${at} reached — firing Gate 5`);
      try {
        await runGate5(jobId);
      } catch (err) {
        console.error(`[sched-cron] ${jobId}: Gate 5 failed — ${err.message}`);
        try {
          const { logError } = require('../error_logger');
          logError('SCHED_CRON_GATE5_FAIL', err, { jobId });
        } catch {}
      } finally {
        // CPD-971: saveJobCard replaces the map entry with a CLONE on every save,
        // so `card` is stale after runGate5 persisted its result — saving it here
        // overwrote stage='published' back to 'gate5_forced'. Clear the firing
        // flag on the FRESH object instead.
        let fresh = null;
        try { fresh = (getCards() || {})[jobId]; } catch { /* ignore */ }
        const target = fresh || card;
        delete target._schedFiring;
        if (saveCard) { try { saveCard(jobId, target); } catch {} }
      }
    }
  };

  _timer = setInterval(() => { tick().catch(() => {}); }, CRON_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  console.log(`[sched-cron] Started — checking for due scheduled publishes every ${CRON_INTERVAL_MS / 1000}s`);
  return _timer;
}

function stopSchedulingCron() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startSchedulingCron, stopSchedulingCron, CRON_INTERVAL_MS };
