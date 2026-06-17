/**
 * Sync YouTube Live Grid program mode when calendar daypart changes (8pm, 11pm ET).
 * Hot-switches layout in-place — never stop/start (kills RTMP).
 *
 * news_desk is skipped when no day-fresh produced news VOD exists (NEWS_DESK_MAX_AGE_HOURS).
 * Set CALENDAR_LIVE_SYNC=off to hand-steer dayparts until the news library is ready.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const log = (msg) => console.log(`[${new Date().toISOString()}] [calendar-live] ${msg}`);

function effectiveYoutubeMode(calendarMode) {
  if (calendarMode !== 'news_desk') return calendarMode;
  try {
    const { loadPrograms } = require('../live_grid/program_director');
    const { hasFreshNewsVod } = require('../live_grid/file_sources');
    const configPath = process.env.LIVE_GRID_PROGRAM_CONFIG
      || path.join(__dirname, '..', '..', 'config', 'live_grid_programs.json');
    if (!fs.existsSync(configPath)) return calendarMode;
    const config = loadPrograms(configPath);
    const { fresh, ageHours, maxAgeHours } = hasFreshNewsVod(config);
    if (fresh) return 'news_desk';
    log(`news_desk blocked — newest news VOD is ${ageHours?.toFixed(1) ?? '?'}h old (max ${maxAgeHours}h); staying on grid`);
    return 'grid';
  } catch (e) {
    log(`news_desk freshness check failed (${e.message}) — defaulting to grid`);
    return 'grid';
  }
}

function startCalendarLiveSync({ baseUrl, getPersistedJobs, intervalMs = 60 * 1000 } = {}) {
  if (String(process.env.CALENDAR_LIVE_SYNC || 'on').toLowerCase() === 'off') {
    log('disabled via CALENDAR_LIVE_SYNC=off');
    return null;
  }

  let lastMode = null;
  let switching = false;

  async function tick() {
    if (switching) return;
    try {
      const status = (await axios.get(`${baseUrl}/live-grid/status`)).data;
      if (!status?.running) {
        lastMode = null;
        return;
      }
      const { buildBroadcastToday } = require('./master_plan');
      const jobs = typeof getPersistedJobs === 'function' ? getPersistedJobs() : {};
      const today = buildBroadcastToday({ persistedJobs: jobs });
      const mode = effectiveYoutubeMode(today.youtubeNow?.mode || null);
      if (!mode) return;

      if (lastMode === null) {
        lastMode = mode;
        return;
      }

      if (lastMode !== mode) {
        switching = true;
        log(`daypart change ${lastMode} → ${mode} — hot switch (no restart)`);
        let body = { mode };
        if (mode === 'news_desk') {
          try {
            const { loadNewsDeskQueue } = require('./live_also');
            const latest = loadNewsDeskQueue().items?.[0];
            if (latest?.path) {
              body.fileOverrides = { produced_news: latest.path };
              body.headline = latest.title;
            }
          } catch (_) {}
        }
        await axios.post(`${baseUrl}/live-grid/program-mode`, body);
        log(`program mode now ${mode}`);
      }
      lastMode = mode;
    } catch (e) {
      log(`tick error: ${e.response?.data?.error || e.message}`);
    } finally {
      switching = false;
    }
  }

  const timer = setInterval(() => tick().catch(() => {}), intervalMs);
  timer.unref?.();
  tick().catch(() => {});
  log('calendar live sync started (hot daypart switches)');
  return { stop: () => clearInterval(timer) };
}

module.exports = { startCalendarLiveSync, effectiveYoutubeMode };
