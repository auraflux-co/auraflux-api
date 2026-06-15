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

/** Redirect URI registered in Kick Developer Portal — must match byte-for-byte. */
function getOAuthRedirectUri(req) {
  if (process.env.KICK_OAUTH_REDIRECT_URI) return process.env.KICK_OAUTH_REDIRECT_URI;
  const base = process.env.API_BASE_URL
    || (req ? `${req.protocol}://${req.get('host')}` : null)
    || `http://localhost:${process.env.PORT || 3000}`;
  return `${String(base).replace(/\/$/, '')}/channels/callback/kick`;
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
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kick token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
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
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kick token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Get the authenticated user's Kick profile.
 * Returns shape compatible with token_store: { platformUserId, platformHandle }.
 *
 * @param {string} accessToken
 * @returns {Promise<{ platformUserId: string, platformHandle: string }>}
 */
async function getUserInfo(accessToken) {
  const res = await fetch(`${API_BASE}/users`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Kick GET /users failed (${res.status})`);
  }
  const body = await res.json();
  const user = Array.isArray(body?.data) ? body.data[0] : (body?.data || body);
  return {
    platformUserId: String(user.user_id || user.id || ''),
    platformHandle: user.username || user.slug || user.name || null,
    email: user.email || null,
    profilePicture: user.profile_picture || null,
  };
}

async function revokeToken(token, tokenHintType = 'access_token') {
  if (!token) return;
  const params = new URLSearchParams({ token, token_hint_type: tokenHintType });
  await fetch(`${AUTH_BASE}/oauth/revoke?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).catch(() => {});
}

module.exports = {
  buildAuthUrl, exchangeCode, refreshAccessToken, getUserInfo, revokeToken,
  getOAuthRedirectUri, API_BASE,
};
