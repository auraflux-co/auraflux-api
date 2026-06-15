'use strict';
/**
 * Fill missing shared OAuth credentials from Doppler (auraflux/prd) when DOPPLER_TOKEN is set.
 * Local .env holds bootstrap + localhost-only vars; shared secrets live in Doppler.
 */

const { execFileSync } = require('child_process');

const DOPPLER_OAUTH_KEYS = ['KICK_CLIENT_ID', 'KICK_CLIENT_SECRET'];

function ensureOAuthFromDoppler() {
  if (!process.env.DOPPLER_TOKEN) return { filled: [] };
  const missing = DOPPLER_OAUTH_KEYS.filter((k) => !process.env[k]);
  if (!missing.length) return { filled: [] };

  try {
    const out = execFileSync(
      'doppler',
      ['secrets', 'download', '--project', 'auraflux', '--config', 'prd', '--format', 'json', '--no-file'],
      { encoding: 'utf8', env: process.env, timeout: 15000 },
    );
    const secrets = JSON.parse(out);
    const filled = [];
    for (const key of missing) {
      if (secrets[key]) {
        process.env[key] = secrets[key];
        filled.push(key);
      }
    }
    if (filled.length) console.log('[doppler] filled missing OAuth env:', filled.join(', '));
    return { filled };
  } catch (e) {
    console.warn('[doppler] could not fill OAuth env:', e.message);
    return { filled: [], error: e.message };
  }
}

function kickCredentialsConfigured() {
  return !!(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET);
}

module.exports = { ensureOAuthFromDoppler, kickCredentialsConfigured, DOPPLER_OAUTH_KEYS };
