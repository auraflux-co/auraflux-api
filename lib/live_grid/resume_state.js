'use strict';
/**
 * Live Grid resume state — survives broadcast-sidecar restarts.
 *
 * When the grid is running, we persist start opts + operator runtime (audio pin,
 * quadrant locks, program mode). On intentional /live-grid/stop or YouTube stale
 * auto-stop, state is cleared. On pm2 restart, sidecar auto-resumes if enabled.
 */

const fs = require('fs');
const path = require('path');
const { isOperatorChannelGrid } = require('./avatar_overlay');

const RESUME_PATH = path.join(__dirname, '..', '..', 'data', 'live_grid_resume.json');

function autoResumeEnabled() {
  return String(process.env.LIVE_GRID_AUTO_RESUME ?? process.env.LIVE_SIDECAR_AUTO_RESUME_GRID ?? 'on')
    .toLowerCase() !== 'off';
}

function resumeMaxAgeMs() {
  return Math.max(3600000, parseInt(process.env.LIVE_GRID_RESUME_MAX_AGE_MS || String(24 * 3600000), 10));
}

function loadResume() {
  try {
    const raw = JSON.parse(fs.readFileSync(RESUME_PATH, 'utf8'));
    if (!raw?.shouldResume) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

function saveResume(data) {
  fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
  fs.writeFileSync(RESUME_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function clearResume() {
  try { fs.unlinkSync(RESUME_PATH); } catch (_) {}
}

function resumeIsStale(state, maxAgeMs = resumeMaxAgeMs()) {
  if (!state?.savedAt) return true;
  return Date.now() - new Date(state.savedAt).getTime() > maxAgeMs;
}

/** Snapshot running grid for resume after sidecar restart. */
function captureResumeSnapshot(mgr) {
  if (!mgr?.running) return null;
  const st = mgr.status();
  return {
    shouldResume: true,
    savedAt: new Date().toISOString(),
    startOpts: sanitizeStartOpts(mgr.opts || {}),
    runtime: {
      audioQuadrant: st.audio?.quadrant ?? 1,
      audioMode: st.audio?.mode || 'auto',
      audioPinSource: st.audio?.pinSource || null,
      operatorMode: !!(mgr.poller?.operatorMode),
      operatorLocks: (st.operatorLocks || []).map((lock) => ({ ...lock })),
      programMode: isOperatorChannelGrid(st.operatorLocks)
        ? 'grid'
        : (st.program?.requestedMode || st.program?.activeMode || 'auto'),
      broadcastId: st.broadcast?.id || null,
      watchUrl: st.broadcast?.watchUrl || null,
    },
  };
}

/** Strip non-serializable / ephemeral fields from start body. */
function sanitizeStartOpts(opts) {
  const o = { ...opts };
  delete o.output;
  delete o.verticalOutput;
  return o;
}

function saveResumeFromManager(mgr) {
  const snap = captureResumeSnapshot(mgr);
  if (!snap) return null;
  saveResume(snap);
  return snap;
}

function buildResumeStartOpts(state) {
  const opts = { ...(state?.startOpts || {}) };
  const locks = state?.runtime?.operatorLocks;
  if (isOperatorChannelGrid(locks)) {
    opts.programMode = 'grid';
    opts.avatarOverlay = false;
  } else {
    const mode = state?.runtime?.programMode;
    if (mode && mode !== 'auto') opts.programMode = mode;
  }
  const bid = state?.runtime?.broadcastId;
  if (bid) {
    opts.broadcastId = bid;
    if (state.runtime.watchUrl) opts.watchUrl = state.runtime.watchUrl;
  }
  return opts;
}

/** Restore operator locks + manual audio after auto-resume start. */
function applyResumeRuntime(mgr, runtime) {
  if (!runtime || !mgr?.running) return;

  for (const lock of runtime.operatorLocks || []) {
    const q = (lock.quadrant ?? 1) - 1;
    if (q < 0 || q > 3) continue;
    try {
      if (lock.type === 'channel' && lock.login) {
        mgr.setQuadrantChannel(q, lock.login);
      } else if (lock.type === 'url' && lock.url) {
        mgr.setQuadrantUrl(q, lock.url, lock.label, {
          title: lock.title,
          login: lock.login,
        });
      } else if (lock.type === 'file' && lock.path) {
        mgr.setQuadrantFile(q, lock.path, lock.label);
      }
    } catch (e) {
      mgr.log(`resume lock Q${q + 1} skipped: ${e.message}`);
    }
  }

  if (runtime.operatorMode) mgr.setOperatorMode(true);

  if (runtime.audioMode === 'manual' && runtime.audioQuadrant >= 1 && runtime.audioQuadrant <= 4) {
    const src = runtime.audioPinSource
      || (runtime.operatorMode ? 'manual' : null);
    if (src === 'chat' || src === 'manual') {
      mgr.setAudio(runtime.audioQuadrant - 1, src);
    } else {
      mgr.setAudio('auto');
    }
  }
}

module.exports = {
  RESUME_PATH,
  autoResumeEnabled,
  resumeMaxAgeMs,
  loadResume,
  saveResume,
  clearResume,
  resumeIsStale,
  captureResumeSnapshot,
  saveResumeFromManager,
  buildResumeStartOpts,
  applyResumeRuntime,
};
