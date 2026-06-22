'use strict';
/** Shared Kick live-grid env helpers (CPD-1065) — no cross-imports. */

/** Kick ingest mode — Render must use signed HLS (streamlink exits code 2 on datacenter IPs). */
function kickStreamlinkIngestEnabled() {
  const mode = String(process.env.LIVE_GRID_KICK_INGEST || '').trim().toLowerCase();
  if (mode === 'hls') return false;
  if (mode === 'streamlink') return true;
  // Default: HLS on Render; streamlink only on local/dev where it works.
  if (process.env.RENDER === 'true') return false;
  return false;
}

function kickPageUrl(slug) {
  const s = String(slug || '').trim().toLowerCase();
  return s ? `https://kick.com/${s}` : null;
}

module.exports = { kickStreamlinkIngestEnabled, kickPageUrl };
