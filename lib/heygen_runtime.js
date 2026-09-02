'use strict';

/**
 * HeyGen live-call gate — keeps HeyGen modules in the repo but OFF the production path.
 *
 * Default: OFF. Assemble / poller / send-approved must not hit api.heygen.com unless
 * the operator explicitly sets HEYGEN_LIVE=on (Avatar VOD / Talk Soup only).
 *
 * Clip-comp Shorts never need this — they assemble from source clips only.
 */

function envFlagOn(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** True only when HEYGEN_LIVE is explicitly enabled. */
function isHeyGenLiveEnabled() {
  return envFlagOn('HEYGEN_LIVE');
}

function heygenLiveDisabledReason() {
  if (isHeyGenLiveEnabled()) return null;
  return 'HeyGen live calls disabled (set HEYGEN_LIVE=on to re-enable Avatar VOD / Talk Soup). Clip-comp assemble does not need HeyGen.';
}

module.exports = {
  isHeyGenLiveEnabled,
  heygenLiveDisabledReason,
};
