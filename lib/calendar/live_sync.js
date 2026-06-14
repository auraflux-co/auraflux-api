/**
 * Sync YouTube Live Grid program mode when calendar daypart changes (8pm, 11pm ET).
 * Hot-switches layout in-place — never stop/start (kills RTMP).
 */

const axios = require('axios');

const log = (msg) => console.log(`[${new Date().toISOString()}] [calendar-live] ${msg}`);

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
      const mode = today.youtubeNow?.mode || null;
      if (!mode) return;

      if (lastMode === null) {
        lastMode = mode;
        return;
      }

      if (lastMode !== mode) {
        switching = true;
        log(`daypart change ${lastMode} → ${mode} — hot switch (no restart)`);
        await axios.post(`${baseUrl}/live-grid/program-mode`, { mode });
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

module.exports = { startCalendarLiveSync };
