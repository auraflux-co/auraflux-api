'use strict';
/** Shared Kick live-grid env helpers (CPD-1065) — no cross-imports. */

/** streamlink on kick.com/{slug} — default on Render; set LIVE_GRID_KICK_INGEST=hls to force signed CDN HLS. */
function kickStreamlinkIngestEnabled() {
  const mode = String(process.env.LIVE_GRID_KICK_INGEST || '').trim().toLowerCase();
  if (mode === 'hls') return false;
  if (mode === 'streamlink') return true;
  return process.env.RENDER === 'true';
}

function kickPageUrl(slug) {
  const s = String(slug || '').trim().toLowerCase();
  return s ? `https://kick.com/${s}` : null;
}

module.exports = { kickStreamlinkIngestEnabled, kickPageUrl };
