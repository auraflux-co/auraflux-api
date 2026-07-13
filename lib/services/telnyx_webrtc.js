'use strict';
/**
 * Telnyx WebRTC — per-agent telephony credentials, JWT tokens, presence.
 */

const { Telnyx } = require('telnyx');
const { query } = require('../db');
const { logError } = require('../error_logger');

const PRESENCE_TTL_MS = 45_000;
const SIP_DOMAIN = 'sip.telnyx.com';

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.TELNYX_API_KEY;
  if (!key) return null;
  _client = new Telnyx(key);
  return _client;
}

function getWebrtcConnectionId() {
  return process.env.TELNYX_WEBRTC_CONNECTION_ID
    || process.env.TELNYX_CREDENTIAL_CONNECTION_ID
    // AuraFlux WebRTC Phone — has outbound voice profile (not Forward Only)
    || '3003322211936241113';
}

function sipUri(sipUsername) {
  const user = String(sipUsername || '').trim();
  if (!user) return null;
  return `sip:${user}@${SIP_DOMAIN}`;
}

function getAppPublicUrl() {
  return (process.env.APP_PUBLIC_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || 'https://app.auraflux.co').replace(/\/$/, '');
}

function phonePageUrl({ dial, line } = {}) {
  const base = `${getAppPublicUrl()}/phone`;
  const params = new URLSearchParams();
  if (dial) params.set('dial', dial);
  if (line) params.set('line', line);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

async function getStoredCredential(clerkUserId) {
  const { rows } = await query(
    `SELECT clerk_user_id, credential_id, sip_username, display_name
       FROM telnyx_webrtc_credentials
      WHERE clerk_user_id = $1`,
    [clerkUserId],
  );
  return rows[0] || null;
}

async function saveCredential(clerkUserId, { credentialId, sipUsername, displayName }) {
  const { rows } = await query(
    `INSERT INTO telnyx_webrtc_credentials
       (clerk_user_id, credential_id, sip_username, display_name, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (clerk_user_id) DO UPDATE SET
       credential_id = EXCLUDED.credential_id,
       sip_username = EXCLUDED.sip_username,
       display_name = COALESCE(EXCLUDED.display_name, telnyx_webrtc_credentials.display_name),
       updated_at = NOW()
     RETURNING *`,
    [clerkUserId, credentialId, sipUsername, displayName || null],
  );
  return rows[0];
}

async function credentialMatchesConnection(credentialId, connectionId) {
  const client = getClient();
  if (!client || !credentialId || !connectionId) return false;
  try {
    const resp = await client.telephonyCredentials.retrieve(credentialId);
    const data = resp.data || resp;
    const resource = String(data.resource_id || data.resourceId || '');
    return resource.includes(connectionId);
  } catch {
    return false;
  }
}

async function deleteStoredCredential(clerkUserId) {
  await query(
    `DELETE FROM telnyx_webrtc_credentials WHERE clerk_user_id = $1`,
    [clerkUserId],
  );
  await query(
    `DELETE FROM voice_agent_presence WHERE clerk_user_id = $1`,
    [clerkUserId],
  );
}

async function getOrCreateCredential(clerkUserId, displayName) {
  const client = getClient();
  const connectionId = getWebrtcConnectionId();
  if (!client || !connectionId) {
    throw new Error('Telnyx WebRTC not configured (API key or connection id)');
  }

  const existing = await getStoredCredential(clerkUserId);
  if (existing) {
    const ok = await credentialMatchesConnection(existing.credential_id, connectionId);
    if (ok) return existing;
    // Stale credential from old Forward Only connection — recreate on WebRTC Phone
    await deleteStoredCredential(clerkUserId);
  }

  const name = `auraflux-${String(clerkUserId).slice(0, 24)}`;
  const resp = await client.telephonyCredentials.create({
    connection_id: connectionId,
    name,
  });
  const data = resp.data || resp;
  const credentialId = data.id;
  const sipUsername = data.sip_username || data.sipUsername;
  if (!credentialId || !sipUsername) {
    throw new Error('Telnyx credential create returned incomplete data');
  }

  return saveCredential(clerkUserId, {
    credentialId,
    sipUsername,
    displayName,
  });
}

async function createLoginToken(clerkUserId, displayName) {
  const cred = await getOrCreateCredential(clerkUserId, displayName);
  const client = getClient();
  if (!client) throw new Error('Telnyx client missing');

  const tokenResp = await client.telephonyCredentials.createToken(cred.credential_id);
  const token = typeof tokenResp === 'string'
    ? tokenResp
    : (tokenResp.data || tokenResp);

  if (!token || typeof token !== 'string') {
    throw new Error('Telnyx token response invalid');
  }

  return {
    token,
    credentialId: cred.credential_id,
    sipUsername: cred.sip_username,
    expiresInSec: 86_400,
  };
}

async function touchPresence(clerkUserId, { status = 'online', displayName } = {}) {
  const cred = await getStoredCredential(clerkUserId);
  if (!cred) return null;

  const { rows } = await query(
    `INSERT INTO voice_agent_presence
       (clerk_user_id, credential_id, sip_username, display_name, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (clerk_user_id) DO UPDATE SET
       status = EXCLUDED.status,
       display_name = COALESCE(EXCLUDED.display_name, voice_agent_presence.display_name),
       last_seen_at = NOW()
     RETURNING *`,
    [clerkUserId, cred.credential_id, cred.sip_username, displayName || cred.display_name, status],
  );
  return rows[0];
}

async function clearPresence(clerkUserId) {
  await query(
    `UPDATE voice_agent_presence SET status = 'offline', last_seen_at = NOW()
      WHERE clerk_user_id = $1`,
    [clerkUserId],
  );
}

async function getOnlineAgents() {
  const cutoff = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
  const { rows } = await query(
    `SELECT clerk_user_id, credential_id, sip_username, display_name, status, last_seen_at
       FROM voice_agent_presence
      WHERE status = 'online'
        AND last_seen_at >= $1
      ORDER BY last_seen_at DESC`,
    [cutoff],
  );
  return rows;
}

async function safeCreateLoginToken(clerkUserId, displayName) {
  try {
    return await createLoginToken(clerkUserId, displayName);
  } catch (err) {
    logError('[telnyx_webrtc] token failed', err, { clerkUserId });
    throw err;
  }
}

module.exports = {
  PRESENCE_TTL_MS,
  SIP_DOMAIN,
  sipUri,
  getAppPublicUrl,
  phonePageUrl,
  getWebrtcConnectionId,
  getOrCreateCredential,
  createLoginToken: safeCreateLoginToken,
  touchPresence,
  clearPresence,
  getOnlineAgents,
};
