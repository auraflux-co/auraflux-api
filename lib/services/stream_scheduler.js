/**
 * Stream scheduler (CPD-975 / CPD-976) — daily programming windows for the
 * two always-on channels, locked with Rob 2026-06-12:
 *
 *   ClipzWorld TV (Twitch loop):  12:00pm – 6:00pm ET   (LIVE_TV_WINDOW)
 *   Live Grid (YouTube):           6:00pm – 3:00am ET   (LIVE_GRID_WINDOW)
 *                                  or 00:00-24:00 ET for 24h measurement runs
 *
 * Semantics (deliberately simple):
 *   - Auto-start: fires once per window. If the operator stops the stream
 *     mid-window, the scheduler does NOT restart it (the window already had
 *     its start). Failed starts retry next tick, max MAX_START_ATTEMPTS.
 *   - Auto-stop: fires only on the inside→outside boundary crossing. A stream
 *     the operator runs entirely outside its window is never touched.
 *   - Disable with STREAM_SCHEDULER=off.
 *
 * Start/stop goes through the server's own HTTP endpoints so the scheduler
 * reuses the exact handler logic (manager lifecycle, error paths) instead of
 * duplicating it.
 */

const axios = require('axios');

const TICK_MS = 60 * 1000;
const MAX_START_ATTEMPTS = 5;
const TZ = 'America/New_York';

const log = (msg) => console.log(`[${new Date().toISOString()}] [stream-sched] ${msg}`);

/** Parse "HH:MM-HH:MM" → { start, end } in minutes since midnight.
 *  "off" → null (stream excluded from scheduling entirely — CPD-994). */
function parseWindow(str, fallback) {
  if (String(str || '').trim().toLowerCase() === 'off') return null;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return fallback;
  const start = Number(m[1]) * 60 + Number(m[2]);
  let end = Number(m[3]) * 60 + Number(m[4]);
  if (end >= 24 * 60) end = 24 * 60; // 00:00-24:00 = full day (CPD-1024 measurement)
  return { start, end };
}

/** Minutes since midnight + date parts in ET. */
function nowET(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Is minute-of-day m inside the window? Supports overnight windows (start > end). */
function inWindow(m, w) {
  if (w.start === w.end) return false;
  return w.start < w.end ? (m >= w.start && m < w.end) : (m >= w.start || m < w.end);
}

/**
 * Key identifying the window occurrence (the ET date the window STARTED).
 * For overnight windows, minutes past midnight belong to yesterday's window.
 */
function windowKey(m, w, dateKey) {
  if (w.start > w.end && m < w.end) {
    const d = new Date(`${dateKey}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return dateKey;
}

/**
 * Pure tick decision for one stream.
 * state: { lastStartKey, startAttempts, wasInWindow }
 * returns 'start' | 'stop' | null and mutates state.wasInWindow.
 */
function decide(now, w, running, state) {
  const inside = inWindow(now.minutes, w);
  const key = windowKey(now.minutes, w, now.dateKey);
  let action = null;

  if (inside && !running && state.lastStartKey !== key) {
    if ((state.startAttempts[key] || 0) < MAX_START_ATTEMPTS) action = 'start';
  } else if (!inside && state.wasInWindow && running) {
    action = 'stop';
  }

  state.wasInWindow = inside;
  return action;
}

/** Next boundary (start or stop) for status display. */
function nextBoundary(now, w) {
  const inside = inWindow(now.minutes, w);
  const target = inside ? w.end : w.start;
  let delta = target - now.minutes;
  if (delta <= 0) delta += 24 * 60;
  return { action: inside ? 'stop' : 'start', inMinutes: delta };
}

function startStreamScheduler({ baseUrl, windows = {} } = {}) {
  if (String(process.env.STREAM_SCHEDULER || 'on').toLowerCase() === 'off') {
    log('disabled via STREAM_SCHEDULER=off');
    return null;
  }

  const streams = [
    {
      name: 'live-tv',
      window: windows.tv || parseWindow(process.env.LIVE_TV_WINDOW, { start: 12 * 60, end: 18 * 60 }),
      statusPath: '/live-tv/status', startPath: '/live-tv/start', stopPath: '/live-tv/stop',
      state: { lastStartKey: null, startAttempts: {}, wasInWindow: null },
    },
    {
      name: 'live-grid',
      window: windows.grid || parseWindow(process.env.LIVE_GRID_WINDOW, { start: 18 * 60, end: 3 * 60 }),
      statusPath: '/live-grid/status', startPath: '/live-grid/start', stopPath: '/live-grid/stop',
      state: { lastStartKey: null, startAttempts: {}, wasInWindow: null },
    },
  ].filter((s) => {
    if (!s.window) log(`${s.name}: window=off — excluded from scheduling`);
    return !!s.window;
  });

  async function tick() {
    const now = nowET();
    for (const s of streams) {
      try {
        const running = !!(await axios.get(`${baseUrl}${s.statusPath}`)).data.running;

        // First tick after boot: adopt current reality without acting on a
        // boundary we never observed (prevents stopping a manually-started
        // stream the instant the server boots outside the window).
        if (s.state.wasInWindow === null) {
          s.state.wasInWindow = inWindow(now.minutes, s.window);
          if (s.state.wasInWindow && running) s.state.lastStartKey = windowKey(now.minutes, s.window, now.dateKey);
          continue;
        }

        const action = decide(now, s.window, running, s.state);
        if (!action) continue;

        const key = windowKey(now.minutes, s.window, now.dateKey);
        if (action === 'start') {
          s.state.startAttempts[key] = (s.state.startAttempts[key] || 0) + 1;
          log(`${s.name}: window open — starting (attempt ${s.state.startAttempts[key]})`);
          await axios.post(`${baseUrl}${s.startPath}`, {});
          s.state.lastStartKey = key;
          log(`${s.name}: started for window ${key}`);
        } else {
          log(`${s.name}: window closed — stopping`);
          await axios.post(`${baseUrl}${s.stopPath}`, {});
          log(`${s.name}: stopped`);
        }
      } catch (e) {
        log(`${s.name}: tick error — ${e.response?.data?.error || e.message}`);
      }
    }
  }

  const timer = setInterval(() => tick().catch((e) => log(`tick failed: ${e.message}`)), TICK_MS);
  timer.unref?.();
  tick().catch((e) => log(`initial tick failed: ${e.message}`));

  const fmt = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  for (const s of streams) log(`${s.name}: window ${fmt(s.window.start)}–${fmt(s.window.end)} ET`);

  return {
    status() {
      const now = nowET();
      return streams.map((s) => ({
        name: s.name,
        window: s.window,
        inWindow: inWindow(now.minutes, s.window),
        next: nextBoundary(now, s.window),
      }));
    },
    stop() { clearInterval(timer); },
  };
}

module.exports = { startStreamScheduler, parseWindow, inWindow, windowKey, decide, nextBoundary, nowET };
