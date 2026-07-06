'use strict';
/**
 * lib/publish/adapters/twitch_oauth.js — Twitch OAuth for source channel connect (CPD-353b)
 *
 * Optional alongside username-only twitchLogin save. Active when TWITCH_CLIENT_SECRET
 * or TWITCH_OAUTH_CLIENT_SECRET is configured.
 */

const axios = require('axios');

const CLIENT_ID = () => process.env.TWITCH_CLIENT_ID || process.env.TWITCH_OAUTH_CLIENT_ID;
const CLIENT_SECRET = () => process.env.TWITCH_CLIENT_SECRET || process.env.TWITCH_OAUTH_CLIENT_SECRET;
const AUTH_BASE = 'https://id.twitch.tv/oauth2';
const SCOPES = ['user:read:email'];

function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID(),
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES.join(' '),
    state,
  });
  return { url: `${AUTH_BASE}/authorize?${params}`, verifier: null };
}

async function exchangeCode(code, redirectUri) {
  const secret = CLIENT_SECRET();
  if (!secret) throw new Error('TWITCH_CLIENT_SECRET not configured');

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     CLIENT_ID(),
    client_secret: secret,
    redirect_uri:  redirectUri,
  });

  const resp = await axios.post(`${AUTH_BASE}/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
  });
  return resp.data;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
  });
  const resp = await axios.post(`${AUTH_BASE}/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
  });
  return resp.data;
}

async function getUserInfo(accessToken) {
  const resp = await axios.get(`${AUTH_BASE}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
    timeout: 15000,
  });
  const data = resp.data || {};
  return {
    platformUserId: data.user_id != null ? String(data.user_id) : '',
    platformHandle: data.login || null,
  };
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getUserInfo,
};
