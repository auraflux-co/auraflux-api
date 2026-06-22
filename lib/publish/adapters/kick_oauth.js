'use strict';
/**
 * lib/publish/adapters/kick_oauth.js — Kick OAuth 2.1 + PKCE adapter (CPD-353)
 *
 * Kick mandates OAuth 2.1, which requires PKCE for all grants.
 *
 * Auth endpoints: https://id.kick.com/oauth/authorize + /oauth/token
 * User API:       https://api.kick.com/public/v1/users + /channels (not /user — 404)
 */

const crypto = require('crypto');
const https  = require('https');
const fetch  = require('node-fetch');

const CLIENT_ID     = () => process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = () => process.env.KICK_CLIENT_SECRET;
const AUTH_BASE     = 'https://id.kick.com';
const TOKEN_PATH    = '/oauth/token';
const API_BASE      = 'https://api.kick.com/public/v1';
const SCOPES        = ['user:read', 'channel:read'];
const TOKEN_AGENT   = new https.Agent({ keepAlive: false, maxSockets: 1 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableKickTokenError(err) {
  const msg = err?.message || String(err);
  if (/authorization code invalid|already used|failed \(\d{3}\)/i.test(msg)) return false;
  return /premature close|ECONNRESET|ETIMEDOUT|socket hang up|network timeout|fetch failed|timeout/i.test(msg);
}

function formatKickTokenHttpError(status, text, label) {
  if (status === 401 && !text) {
    return 'Kick authorization code invalid or already used — click Connect with Kick once (do not refresh the callback page). '
      + 'If it keeps failing, confirm Kick app redirect URI matches exactly: '
      + (process.env.KICK_OAUTH_REDIRECT_URI || process.env.API_BASE_URL || 'API_BASE_URL')
      + '/channels/callback/kick';
  }
  if (status === 401) {
    return `Kick ${label} unauthorized (401) — code expired or redirect_uri mismatch. Try Connect again once.`;
  }
  if (!text) return `Kick ${label} empty response (${status})`;
  try {
    const data = JSON.parse(text);
    const detail = data?.error_description || data?.error || text.slice(0, 300);
    return `Kick ${label} failed (${status}): ${detail}`;
  } catch {
    return `Kick ${label} non-JSON (${status}): ${text.slice(0, 300)}`;
  }
}

/** Native https POST — avoids node-fetch Premature close on id.kick.com from Render. */
function postKickTokenHttps(bodyStr, label) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'id.kick.com',
        path:     TOKEN_PATH,
        method:   'POST',
        agent:    TOKEN_AGENT,
        headers:  {
          'Content-Type':   'application/x-www-form-urlencoded',
          Accept:           'application/json',
          'User-Agent':     'AuraFlux/1.0 (+https://auraflux.co)',
          Connection:       'close',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            reject(new Error(formatKickTokenHttpError(status, text, label)));
            return;
          }
          if (!text) {
            reject(new Error(formatKickTokenHttpError(status, text, label)));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(formatKickTokenHttpError(status, text, label)));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy(new Error('Kick token request timeout'));
    });
    req.write(bodyStr);
    req.end();
  });
}

async function postKickTokenOnce(body, label) {
  return postKickTokenHttps(body.toString(), label);
}

/** Auth-code exchange: one network retry max (codes are single-use on HTTP 401). */
async function postKickTokenExchange(body, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await postKickTokenOnce(body, label);
    } catch (err) {
      lastErr = err;
      if (!isRetryableKickTokenError(err) || attempt === 2) throw err;
      await sleep(600);
    }
  }
  throw lastErr;
}

async function postKickTokenWithRetry(body, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await postKickTokenOnce(body, label);
    } catch (err) {
      lastErr = err;
      if (!isRetryableKickTokenError(err) || attempt === 3) throw err;
      await sleep(attempt * 400);
    }
  }
  throw lastErr;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthUrl(redirectUri, state) {
  const { verifier, challenge } = generatePKCE();
  const params = new URLSearchParams({
    client_id:             CLIENT_ID(),
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPES.join(' '),
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_BASE}/oauth/authorize?${params}`, verifier };
}

async function exchangeCode(code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
  });
  return postKickTokenExchange(body, 'token exchange');
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken,
  });
  return postKickTokenWithRetry(body, 'token refresh');
}

function firstItem(body) {
  if (Array.isArray(body)) return body[0] || null;
  if (Array.isArray(body?.data)) return body.data[0] || null;
  return body?.data || body || null;
}

/** Parse Kick public API v1 user/channel payloads into platform metadata. */
function parseKickProfile(body) {
  const channel = firstItem(body);
  if (!channel) return null;
  const slug = channel.slug || channel.username || null;
  const userId = channel.broadcaster_user_id || channel.user_id || channel.id || null;
  const name = channel.name || channel.username || slug || null;
  const handle = slug || (name ? String(name).replace(/^@/, '') : null);
  if (!handle && !userId) return null;
  return {
    platformUserId: userId != null ? String(userId) : '',
    platformHandle: handle,
  };
}

async function kickApiGet(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept:        'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kick GET ${path} failed (${res.status})${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  return res.json();
}

/**
 * Resolve authenticated Kick channel identity.
 * Official API: GET /public/v1/channels (own channel slug) then GET /public/v1/users.
 * Legacy /user (singular) returns 404 — do not use.
 */
async function getUserInfo(accessToken) {
  const attempts = ['/channels', '/users'];
  let lastErr;
  for (const path of attempts) {
    try {
      const body = await kickApiGet(accessToken, path);
      const parsed = parseKickProfile(body);
      if (parsed?.platformHandle || parsed?.platformUserId) return parsed;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Kick profile lookup returned no handle');
}

/**
 * Backfill missing Kick handle/userId on stored OAuth tokens + source_channels.
 */
async function syncKickProfile(customerId, storedTokens) {
  if (!storedTokens?.accessToken) return storedTokens;
  if (storedTokens.platformHandle && storedTokens.platformUserId) return storedTokens;
  try {
    const info = await getUserInfo(storedTokens.accessToken);
    const tokenStore = require('../../services/token_store');
    const { query: dbQuery } = require('../../db/postgres');
    await tokenStore.updateTokenChannelMeta(customerId, null, 'kick', {
      platformUserId: info.platformUserId || storedTokens.platformUserId,
      platformHandle: info.platformHandle || storedTokens.platformHandle,
    });
    if (info.platformHandle) {
      const clean = String(info.platformHandle).replace(/^@/, '').toLowerCase();
      await dbQuery(
        `UPDATE client_plans
            SET source_channels = source_channels || $1::jsonb
          WHERE client_id = $2 AND active = TRUE`,
        [JSON.stringify({ kickUsername: clean }), customerId],
      ).catch(() => {});
    }
    return {
      ...storedTokens,
      platformUserId: info.platformUserId || storedTokens.platformUserId,
      platformHandle: info.platformHandle || storedTokens.platformHandle,
    };
  } catch (err) {
    console.warn('[kick_oauth] syncKickProfile failed (non-fatal):', err.message);
    return storedTokens;
  }
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getUserInfo,
  syncKickProfile,
  parseKickProfile,
  API_BASE,
  isRetryableKickTokenError,
};
