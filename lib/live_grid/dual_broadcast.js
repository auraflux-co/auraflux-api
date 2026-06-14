'use strict';

/**
 * CPD-1029 — Portrait for mobile viewers comes from YouTube native dual-format
 * (landscape ingest + Studio "horizontal + vertical automatic"). Legacy CPD-1005
 * second broadcast + ffmpeg 9:16 leg is opt-in only via LIVE_GRID_DUAL_BROADCAST=on.
 */

function isTruthy(v) {
  const s = String(v || '').toLowerCase();
  return s === 'on' || s === '1' || s === 'true' || s === 'yes';
}

/** @deprecated LIVE_GRID_VERTICAL=auto — use LIVE_GRID_DUAL_BROADCAST=on for legacy dual YT listings */
function legacyVerticalEnvEnabled() {
  const mode = String(process.env.LIVE_GRID_VERTICAL || 'off').toLowerCase();
  return mode === 'auto' || mode === 'on';
}

function isLegacyDualBroadcastEnabled() {
  if (isTruthy(process.env.LIVE_GRID_DUAL_BROADCAST)) return true;
  if (legacyVerticalEnvEnabled()) {
    return true;
  }
  return false;
}

/**
 * @param {{ verticalOutput?: string|null }} [opts]
 * @returns {{ verticalOutput: string|null, createVerticalBroadcast: boolean, legacyDual: boolean }}
 */
function resolveVerticalStream(opts = {}) {
  const explicit = opts.verticalOutput || process.env.LIVE_GRID_VERTICAL_OUTPUT || null;
  if (explicit) {
    return {
      verticalOutput: explicit,
      createVerticalBroadcast: false,
      legacyDual: true,
    };
  }

  if (!isLegacyDualBroadcastEnabled()) {
    return { verticalOutput: null, createVerticalBroadcast: false, legacyDual: false };
  }

  return { verticalOutput: null, createVerticalBroadcast: true, legacyDual: true };
}

module.exports = {
  isLegacyDualBroadcastEnabled,
  resolveVerticalStream,
};
