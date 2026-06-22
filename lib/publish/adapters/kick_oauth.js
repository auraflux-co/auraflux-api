'use strict';
/**
 * lib/publish/adapters/kick_oauth.js — Kick OAuth 2.1 + PKCE adapter (CPD-353)
 *
 * Kick mandates OAuth 2.1, which requires PKCE for all grants.
 *
 * Auth endpoints: https://id.kick.com/oauth/authorize + /oauth/token
 * User API:       https://api.kick.com/public/v1/user
 */

const crypto = require('crypto');
const fetch  = require('node-fetch');

const CLIENT_ID     = () => process.env.KICK_CLIENT_ID;
const CLIENT_SECRET = () => process.env.KICK_CLIENT_SECRET;
const AUTH_BASE     = 'https://id.kick.com';
const API_BASE      = 'https://api.kick.com/public/v1';
const SCOPES        = ['user:read', 'channel:read'];
const TOKEN_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  Accept:         'application/json',
  'User-Agent':   'AuraFlux/1.0 (+https://auraflux.co)',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableKickTokenError(err) {
  const msg = err?.message || String(err);
  return /premature close|ECONNRESET|ETIMEDOUT|socket hang up|network timeout|fetch failed/i.test(msg);
}

/** POST id.kick.com/oauth/token — retries flaky empty/partial responses from Kick. */
async function postKickToken(body, label) {
  const url = `${AUTH_BASE}/oauth/token`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: TOKEN_HEADERS,
        body:    body.toString(),
      });
      const text = await res.text();
      if (!text) {
        throw new Error(`Kick ${label} empty response (${res.status})`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Kick ${label} non-JSON (${res.status}): ${text.slice(0, 300)}`);
      }
      if (!res.ok) {
        const detail = data?.error_description || data?.error || text.slice(0, 300);
        throw new Error(`Kick ${label} failed (${res.status}): ${detail}`);
      }
      return data;
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

/**
 * Build Kick OAuth 2.1 authorization URL.
 * Returns { url, verifier } — caller must persist verifier for code exchange.
 *
 * @param {string} redirectUri
 * @param {string} state
 * @returns {{ url: string, verifier: string }}
 */
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

/**
 * Exchange auth code for access/refresh tokens.
 *
 * @param {string} code
 * @param {string} redirectUri
 * @param {string} codeVerifier  — from buildAuthUrl()
 * @returns {Promise<object>}    — { access_token, refresh_token, expires_in, scope, ... }
 */
async function exchangeCode(code, redirectUri, codeVerifier) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    redirect_uri:  redirectUri,
    code_verifier: codeVerifier,
  });
  return postKickToken(body, 'token exchange');
}

/**
 * Refresh an expired access token using a stored refresh token.
 *
 * @param {string} refreshToken
 * @returns {Promise<object>}   — { access_token, refresh_token, expires_in, ... }
 */
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken,
  });
  return postKickToken(body, 'token refresh');
}

/**
 * Get the authenticated user's Kick profile.
 * Returns shape compatible with token_store: { platformUserId, platformHandle }.
 *
 * @param {string} accessToken
 * @returns {Promise<{ platformUserId: string, platformHandle: string }>}
 */
async function getUserInfo(accessToken) {
  const res = await fetch(`${API_BASE}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Kick GET /user failed (${res.status})`);
  }
  const body = await res.json();
  // Shape: { data: { id, username, slug, profile_pic, ... } }
  const user = body?.data || body;
  return {
    platformUserId: String(user.id || user.user_id || ''),
    platformHandle: user.username || user.slug || null,
  };
}

module.exports = { buildAuthUrl, exchangeCode, refreshAccessToken, getUserInfo, API_BASE };
