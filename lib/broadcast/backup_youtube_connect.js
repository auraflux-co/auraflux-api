'use strict';
/**
 * Persist backup YouTube refresh token after /connect/youtube/backup OAuth.
 * Writes to Render env (immediate) and Doppler prd (source of truth) when credentials allow.
 */

const axios = require('axios');
const { execSync } = require('child_process');

const DEFAULT_BROADCAST_SERVICE_ID = 'srv-d8qs41ernols73ej7720';

async function setRenderEnvVar(key, value, serviceId = process.env.BROADCAST_RENDER_SERVICE_ID || DEFAULT_BROADCAST_SERVICE_ID) {
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) return false;
  await axios.put(
    `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    { value: String(value) },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );
  return true;
}

function setDopplerSecret(key, value) {
  if (!process.env.DOPPLER_TOKEN) return false;
  execSync(
    `doppler secrets set ${key}="${String(value).replace(/"/g, '\\"')}" --project auraflux --config prd --silent`,
    { stdio: 'pipe', env: process.env },
  );
  return true;
}

/** @returns {{ render: boolean, doppler: boolean }} */
async function persistBackupRefreshToken(refreshToken) {
  const out = { render: false, doppler: false };
  if (!refreshToken) return out;
  try {
    out.render = await setRenderEnvVar('YOUTUBE_BACKUP_REFRESH_TOKEN', refreshToken);
  } catch (e) {
    console.warn('[backup_youtube_connect] Render env update failed:', e.response?.data || e.message);
  }
  try {
    out.doppler = setDopplerSecret('YOUTUBE_BACKUP_REFRESH_TOKEN', refreshToken);
  } catch (e) {
    console.warn('[backup_youtube_connect] Doppler update failed:', e.message);
  }
  return out;
}

module.exports = { persistBackupRefreshToken, setRenderEnvVar, setDopplerSecret };
