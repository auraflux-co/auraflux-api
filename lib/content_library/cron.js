'use strict';

const { runClipIngest } = require('./ingest_clips');
const { runPurge } = require('./purge');
const { etYmd } = require('./time_et');

const TICK_MS = 60 * 1000;
let _timer = null;
let _lastIngestYmd = null;
let _lastPurgeWeek = null;

function isSundayNightEt(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const wd = fmt.find((p) => p.type === 'weekday')?.value;
  const hour = Number(fmt.find((p) => p.type === 'hour')?.value);
  return wd === 'Sun' && hour === 23;
}

function isNoonEt(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(fmt.find((p) => p.type === 'hour')?.value);
  return hour === 12;
}

function weekKey(date = new Date()) {
  return etYmd(date).slice(0, 7) + '-W' + Math.floor(date.getDate() / 7);
}

function startContentLibraryCron({ log = console.log } = {}) {
  if (String(process.env.CONTENT_LIBRARY_CRON || 'on').toLowerCase() === 'off') {
    log('[content-library-cron] disabled via CONTENT_LIBRARY_CRON=off');
    return null;
  }

  const tick = async () => {
    const now = new Date();
    try {
      if (isNoonEt(now)) {
        const ymd = etYmd(now);
        if (_lastIngestYmd !== ymd) {
          _lastIngestYmd = ymd;
          log('[content-library-cron] 12pm ET — starting daily ingest');
          await runClipIngest({ log });
        }
      }
      if (isSundayNightEt(now)) {
        const wk = weekKey(now);
        if (_lastPurgeWeek !== wk) {
          _lastPurgeWeek = wk;
          log('[content-library-cron] Sunday 11pm ET — purge unused');
          await runPurge({ log });
        }
      }
    } catch (e) {
      log(`[content-library-cron] tick error: ${e.message}`);
    }
  };

  _timer = setInterval(() => { tick(); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  log('[content-library-cron] started — noon ET ingest, Sunday 11pm ET purge');
  return _timer;
}

function stopContentLibraryCron() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startContentLibraryCron, stopContentLibraryCron, isNoonEt, isSundayNightEt };
