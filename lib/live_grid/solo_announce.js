'use strict';

/**
 * CPD-1047 — YouTube chat lineup announcements (main grid + solo seat URLs).
 */

const DEBOUNCE_MS = parseInt(process.env.LIVE_GRID_SOLO_CHAT_DEBOUNCE_MS || '45000', 10);

function soloChatAnnounceEnabled() {
  return String(process.env.LIVE_GRID_SOLO_CHAT_ANNOUNCE ?? 'on').toLowerCase() !== 'off';
}

function buildLineupMessage({ mainWatchUrl, assignments = [], solos = [] }) {
  const { streamerLockEnabled, watchUrlForLogin, getBinding, syncBindingsForAssignments } = require('./solo_streamer_registry');
  const locked = streamerLockEnabled();
  const lines = ['📺 Grid update — watch on ClipzWorld (not Twitch):'];
  if (mainWatchUrl) lines.push(`Main 2×2: ${mainWatchUrl}`);

  if (locked) {
    syncBindingsForAssignments(assignments);
    const seen = new Set();
    for (let q = 0; q < 4; q++) {
      const login = assignments[q];
      if (!login || seen.has(login)) continue;
      seen.add(login);
      const url = watchUrlForLogin(login) || solos.find((s) => s.login === login)?.watchUrl;
      const screen = getBinding(login)?.currentQuadrant;
      lines.push(`@${login} full-screen${screen ? ` (Screen ${screen})` : ''}${url ? `: ${url}` : ''}`);
    }
    for (let q = 0; q < 4; q++) {
      if (!assignments[q]) lines.push(`Q${q + 1} slate`);
    }
    return lines.join('\n');
  }

  const seats = [0, 1, 2, 3].map((q) => {
    const login = assignments[q] || 'slate';
    const solo = solos.find((s) => s.quadrant === q + 1);
    const soloUrl = solo?.watchUrl;
    return `Q${q + 1} ${login}${soloUrl ? ` → ${soloUrl}` : ''}`;
  });
  lines.push(...seats);
  return lines.join('\n');
}

function createSoloAnnouncer({ log, postMessage, getSnapshot }) {
  let lastKey = '';
  let timer = null;

  async function flush() {
    timer = null;
    if (!soloChatAnnounceEnabled() || !postMessage) return;
    const snap = getSnapshot?.();
    if (!snap?.running) return;
    const assignments = snap.assignments || [];
    const key = assignments.join('|');
    if (key === lastKey) return;
    lastKey = key;
    const text = buildLineupMessage({
      mainWatchUrl: snap.mainWatchUrl,
      assignments,
      solos: snap.solos || [],
    });
    try {
      await postMessage(text);
      log?.('solo lineup announced in chat');
    } catch (e) {
      log?.(`solo chat announce failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  function schedule() {
    if (!soloChatAnnounceEnabled()) return;
    if (timer) return;
    timer = setTimeout(() => { flush().catch(() => {}); }, DEBOUNCE_MS);
    timer.unref?.();
  }

  function reset() {
    lastKey = '';
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { schedule, flush, reset, buildLineupMessage };
}

module.exports = {
  soloChatAnnounceEnabled,
  buildLineupMessage,
  createSoloAnnouncer,
};
