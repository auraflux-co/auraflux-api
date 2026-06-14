/**
 * Resolve Bobby G avatar reaction loop for live grid PIP (CPD-1025).
 * Must NOT pick produced shorts/comps — those match script_twitch and cover Q3.
 */

const fs = require('fs');
const path = require('path');
const { listMp4Files, pickNewest, isAllowedFilePath } = require('./file_sources');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Files unsuitable for a small reaction-loop PIP overlay. */
function isExcludedAvatarCandidate(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (/clips_comp|[-_]short|twitch-short|cwn_short|script_news|news_0clips|because_the_light/.test(base)) {
    return true;
  }
  // Full productions (NBA/news multi-clip) — not a small reaction loop for PIP.
  if (/script_nba|\d+clips_script|_clip_\d+clip|^nba_.*avatar/.test(base)) return true;
  if (base.startsWith('cwn_') && base.includes('news')) return true;
  return false;
}

/** Avatar PIP only on news_desk (Q3 slate) unless explicitly configured. */
function shouldUseAvatarPip(programMode, opts = {}) {
  if (opts.path || process.env.LIVE_GRID_AVATAR_OVERLAY) return true;
  if (opts.avatarOverlay === false) return false;
  if (String(process.env.LIVE_GRID_AVATAR_PIP || 'auto').toLowerCase() === 'off') return false;
  return programMode === 'news_desk';
}

function resolveAvatarOverlay(opts = {}) {
  if (opts.avatarOverlay === false) return null;
  const explicit = opts.path || process.env.LIVE_GRID_AVATAR_OVERLAY;
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(p) && isAllowedFilePath(p)) return p;
  }

  if (!shouldUseAvatarPip(opts.programMode, opts)) return null;

  const files = listMp4Files(path.join(REPO_ROOT, 'output'))
    .filter(({ f }) => isAllowedFilePath(f))
    .filter(({ f }) => !isExcludedAvatarCandidate(f));

  const prefer = ['heygen', 'avatar', 'reaction', 'bobby'];
  return pickNewest(files, prefer);
}

module.exports = { resolveAvatarOverlay, shouldUseAvatarPip, isExcludedAvatarCandidate };
