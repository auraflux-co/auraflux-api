'use strict';
/** Pool size for solo encoders on this sidecar (5 in solo_roster fleet mode). */

function isSoloRosterMode(opts = {}) {
  const mode = opts.programMode || process.env.LIVE_GRID_PROGRAM_MODE || '';
  return String(mode).toLowerCase() === 'solo_roster';
}

function fleetPoolSize(opts = {}) {
  if (isSoloRosterMode(opts)) {
    const n = parseInt(process.env.LIVE_GRID_FLEET_POOL_SIZE || '5', 10);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 5;
  }
  return 4;
}

function assertPoolIndex(q, opts = {}) {
  const max = fleetPoolSize(opts);
  if (!Number.isInteger(q) || q < 0 || q >= max) {
    throw new Error(`pool index must be 0-${max - 1}`);
  }
}

module.exports = { isSoloRosterMode, fleetPoolSize, assertPoolIndex };
