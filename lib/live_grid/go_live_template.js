'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildGridLiveDescription,
  buildYoutubeTags,
  buildGridLiveTitleHashtag,
  displayName,
  withLiveTitleDate,
  formatAudioInstructions,
} = require('./seo');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_go_live.json');

function loadGoLiveConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function streamersFromLocks(locks = []) {
  return locks
    .filter((l) => l && l.login)
    .map((l) => ({
      login: l.login,
      displayName: displayName(l.login),
      role: 'co-stream',
      quadrant: Number.isInteger(l.quadrant) ? l.quadrant : undefined,
    }))
    .sort((a, b) => (a.quadrant ?? 99) - (b.quadrant ?? 99));
}

function streamersFromAssignments(assignments = []) {
  return (assignments || [])
    .map((login, i) => (login ? {
      login: String(login).toLowerCase(),
      displayName: displayName(login),
      role: 'co-stream',
      quadrant: i + 1,
    } : null))
    .filter(Boolean);
}

/** Hardcoded nightly template — operator locks drive names, not live poller roulette. */
function buildGoLiveSeo(cfg = {}, opts = {}) {
  const cfgLoaded = cfg?.seo ? cfg : loadGoLiveConfig();
  if (!cfgLoaded?.seo) return { fromTemplate: false };
  const locks = cfgLoaded.operatorLocks?.length
    ? cfgLoaded.operatorLocks
    : (opts.operatorLocks || opts._resumeRuntime?.operatorLocks || []);
  let streamers = streamersFromLocks(locks);
  if (!streamers.length && opts.assignments?.length) {
    streamers = streamersFromAssignments(opts.assignments);
  }
  const names = streamers.map((s) => s.displayName);
  const titleSuffix = names.length ? names.join(', ') : 'ClipzWorld';
  const hookLine = names.length
    ? `🔴 LIVE NOW — ${titleSuffix} | 4-Up Twitch Multiview`
    : '🔴 LIVE NOW — ClipzWorld 4-Up Twitch Multiview Grid';

  const seoCfg = cfgLoaded.seo || {};
  const titleStyle = seoCfg.titleStyle || 'hashtag_short_date';
  const title = titleStyle === 'hashtag_short_date'
    ? buildGridLiveTitleHashtag(streamers)
    : withLiveTitleDate(seoCfg.title || `🔴 LIVE: ${titleSuffix}`).slice(0, 100);
  const description = seoCfg.description || buildGridLiveDescription({ streamers, hookLine });
  const tags = seoCfg.tags?.length ? seoCfg.tags : buildYoutubeTags(streamers, { mode: 'grid' });

  return {
    seo: {
      title: title.slice(0, 100),
      description,
      tags,
      hashtags: seoCfg.hashtags || ['LiveStream', 'Twitch', 'WatchParty', 'Multiview', 'ClipzWorldNews'],
      thumbnailHeadline: seoCfg.thumbnailHeadline || 'Twitch Multiview',
      thumbnailSubline: seoCfg.thumbnailSubline || titleSuffix.replace(/,/g, ' ·'),
    },
    streamers,
    programMode: opts.programMode || cfgLoaded.programMode || 'grid',
    fromTemplate: true,
  };
}

function applyGoLiveDefaults(opts = {}) {
  const cfg = loadGoLiveConfig();
  const out = { ...opts };
  // Dashboard GO LIVE defaults to autopilot unless operator explicitly requested.
  if (out.operatorMode !== true) {
    out.autoPilot = true;
    out.operatorMode = false;
    out._stickTemplateLocks = false;
    if (out._resumeRuntime) {
      out._resumeRuntime = {
        ...out._resumeRuntime,
        operatorMode: false,
        operatorLocks: [],
      };
    }
  }
  try {
    const { trustEnvBroadcast } = require('./ingest_stream');
    if (out.createListing == null && trustEnvBroadcast()
      && (out.broadcastId || process.env.LIVE_GRID_BROADCAST_ID)) {
      out.createListing = false;
    }
  } catch (_) { /* non-fatal */ }
  if (!cfg) return out;
  if (!out.programMode && cfg.programMode) out.programMode = cfg.programMode;
  if (out.operatorMode === false || out.autoPilot === true) {
    out._stickTemplateLocks = false;
    return out;
  }
  if (!out._resumeRuntime?.operatorLocks?.length && cfg.operatorLocks?.length) {
    out._resumeRuntime = {
      ...(out._resumeRuntime || {}),
      operatorMode: cfg.operatorMode !== false,
      operatorLocks: cfg.operatorLocks,
      programMode: cfg.programMode || 'grid',
      audioMode: out._resumeRuntime?.audioMode || 'auto',
    };
    out._stickTemplateLocks = true;
  }
  return out;
}

module.exports = {
  loadGoLiveConfig,
  buildGoLiveSeo,
  applyGoLiveDefaults,
  streamersFromLocks,
  streamersFromAssignments,
  CONFIG_PATH,
};
