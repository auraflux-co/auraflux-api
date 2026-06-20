'use strict';

/**
 * Live Grid middleware feature flags (default off — safe while production stream runs).
 * Enable after stream ends: LIVE_GRID_OUTPUT_MIDDLEWARE=on LIVE_GRID_STAGED_SWAP=on
 */

function envOn(key, defaultOff = 'off') {
  return String(process.env[key] ?? defaultOff).toLowerCase() === 'on';
}

function outputMiddlewareEnabled() {
  return envOn('LIVE_GRID_OUTPUT_MIDDLEWARE');
}

function stagedSwapEnabled() {
  return envOn('LIVE_GRID_STAGED_SWAP');
}

function restreamerHoldEnabled() {
  return envOn('LIVE_GRID_RESTREAMER_HOLD');
}

function swapDebounceMs() {
  return parseInt(process.env.LIVE_GRID_SWAP_DEBOUNCE_MS || '8000', 10);
}

function swapStableMs() {
  return parseInt(process.env.LIVE_GRID_SWAP_STABLE_MS || '3000', 10);
}

function swapStableProbeMs() {
  return parseInt(process.env.LIVE_GRID_SWAP_STABLE_PROBE_MS || '1000', 10);
}

function middlewareStatus() {
  return {
    outputMiddleware: outputMiddlewareEnabled(),
    stagedSwap: stagedSwapEnabled(),
    restreamerHold: restreamerHoldEnabled(),
    swapDebounceMs: swapDebounceMs(),
    swapStableMs: swapStableMs(),
  };
}

module.exports = {
  outputMiddlewareEnabled,
  stagedSwapEnabled,
  restreamerHoldEnabled,
  swapDebounceMs,
  swapStableMs,
  swapStableProbeMs,
  middlewareStatus,
};
