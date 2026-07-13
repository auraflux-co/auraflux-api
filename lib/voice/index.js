'use strict';
/**
 * lib/voice/index.js — platform-agnostic voice dial contract.
 *
 * VOICE_PROVIDER env var (default: telnyx).
 */

const ADAPTERS = {
  telnyx: () => require('./adapters/telnyx'),
};

const DEFAULT_PROVIDER = 'telnyx';

function getProvider() {
  return (process.env.VOICE_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
}

function getAdapter() {
  const provider = getProvider();
  const factory = ADAPTERS[provider];
  if (!factory) throw new Error(`[voice] Unknown provider: ${provider}`);
  return factory();
}

function dial(opts) {
  return getAdapter().dial(opts);
}

module.exports = { getProvider, dial };
