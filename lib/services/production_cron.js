'use strict';
/**
 * Production cron (Task #21) — auto-run calendar production slots.
 * Shorts + live scheduling always; long-form only when avatar/HeyGen is unblocked.
 *
 * Disable: PRODUCTION_CRON=off
 */

const TICK_MS = 60 * 1000;
let _timer = null;

function startProductionCron({ baseUrl, getPersistedJobs, saveJobCard } = {}) {
  if (String(process.env.PRODUCTION_CRON || 'on').toLowerCase() === 'off') {
    console.log('[prod-cron] disabled via PRODUCTION_CRON=off');
    return null;
  }

  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
  const { runProductionTick } = require('../calendar/auto_production');

  const tick = () => runProductionTick({
    baseUrl: baseUrl || `http://127.0.0.1:${process.env.PORT || 3000}`,
    getPersistedJobs,
    saveJobCard,
    log,
  }).catch((e) => log(`[prod-cron] tick error: ${e.message}`));

  _timer = setInterval(() => { tick(); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  tick();
  log('[prod-cron] started — calendar production every 60s (shorts always; long-form when avatar ready)');
  return _timer;
}

function stopProductionCron() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startProductionCron, stopProductionCron, TICK_MS };
