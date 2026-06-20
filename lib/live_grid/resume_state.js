'use strict';
/**
 * Live Grid resume state — survives broadcast-sidecar restarts.
 *
 * On Render, resume JSON lives on /app/tmp (persistent disk). When the file is
 * missing, env fallback (LIVE_GRID_WAS_LIVE + listing vars) reconnects RTMP.
 */

const fs = require('fs');
const path = require('path');
const { isOperatorChannelGrid } = require('./avatar_overlay');

function getResumePath() {
  const dir = process.env.LIVE_GRID_RESUME_DIR
    || (process.env.RENDER ? '/app/tmp' : path.join(__dirname, '..', '..', 'data'));
  return path.join(dir, 'live_grid_resume.json');
}

function autoResumeEnabled() {
  return String(process.env.LIVE_GRID_AUTO_RESUME ?? process.env.LIVE_SIDECAR_AUTO_RESUME_GRID ?? 'on')
    .toLowerCase() !== 'off';
}

function resumeMaxAgeMs() {
  return Math.max(3600000, parseInt(process.env.LIVE_GRID_RESUME_MAX_AGE_MS || String(24 * 3600000), 10));
}

/** Env-based resume when JSON file was lost (Render deploy). */
function buildEnvResumeFallback() {
  const { wasLiveFlagged } = require('./was_live_env');
  if (!wasLiveFlagged()) return null;
  const { readYoutubeListing } = require('./youtube_listing_env');
  const listing = readYoutubeListing();
  if (!listing.broadcastId || listing.stale || !listing.rtmpUrl) return null;
  return {
    shouldResume: true,
    savedAt: new Date().toISOString(),
    source: 'env_fallback',
    startOpts: {
      autoPilot: true,
      operatorMode: false,
      broadcastId: listing.broadcastId,
      watchUrl: listing.watchUrl,
      _rtmpGo: true,
    },
    runtime: {
      audioQuadrant: 1,
      audioMode: 'auto',
      audioPinSource: null,
      operatorMode: false,
      operatorLocks: [],
      programMode: 'auto',
      broadcastId: listing.broadcastId,
      watchUrl: listing.watchUrl,
      rtmpEncoderStarted: true,
    },
  };
}

function loadResume() {
  try {
    const raw = JSON.parse(fs.readFileSync(getResumePath(), 'utf8'));
    if (raw?.shouldResume) return raw;
  } catch (_) {}
  return buildEnvResumeFallback();
}

function saveResume(data) {
  const resumePath = getResumePath();
  fs.mkdirSync(path.dirname(resumePath), { recursive: true });
  fs.writeFileSync(resumePath, `${JSON.stringify(data, null, 2)}\n`);
}

function clearResume() {
  try { fs.unlinkSync(getResumePath()); } catch (_) {}
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
    source: 'manager',
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
      rtmpEncoderStarted: !!mgr._rtmpEncoderStarted,
      soloStreamsStarted: !!mgr.soloPublishers?.started,
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
  if (state?.runtime?.rtmpEncoderStarted) {
    opts._rtmpGo = true;
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
  getResumePath,
  autoResumeEnabled,
  resumeMaxAgeMs,
  buildEnvResumeFallback,
  loadResume,
  saveResume,
  clearResume,
  resumeIsStale,
  captureResumeSnapshot,
  saveResumeFromManager,
  buildResumeStartOpts,
  applyResumeRuntime,
};
