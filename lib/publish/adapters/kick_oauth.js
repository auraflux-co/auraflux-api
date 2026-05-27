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
