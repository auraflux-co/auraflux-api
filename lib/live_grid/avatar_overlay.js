/**
 * Resolve Bobby G avatar reaction loop for live grid PIP (CPD-1025).
 */

const fs = require('fs');
const path = require('path');
const { listMp4Files, pickNewest, isAllowedFilePath } = require('./file_sources');

const REPO_ROOT = path.join(__dirname, '..', '..');

function resolveAvatarOverlay(opts = {}) {
  const explicit = opts.path || process.env.LIVE_GRID_AVATAR_OVERLAY;
  if (explicit) {
    const p = path.resolve(explicit);
    if (fs.existsSync(p)) return p;
  }
  if (String(process.env.LIVE_GRID_AVATAR_PIP || 'auto').toLowerCase() === 'off') return null;

  const files = listMp4Files(path.join(REPO_ROOT, 'output'))
    .filter(({ f }) => isAllowedFilePath(f));
  const prefer = ['heygen', 'avatar', 'script_twitch', 'script_news', 'because'];
  const picked = pickNewest(files, prefer);
  return picked;
}

module.exports = { resolveAvatarOverlay };
