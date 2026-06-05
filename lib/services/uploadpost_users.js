'use strict';
/**
 * lib/services/uploadpost_users.js — Upload-Post white-label profile management
 *
 * Each AuraFlux customer gets their own Upload-Post profile (username = Clerk user ID).
 * TikTok and Instagram are connected via Upload-Post's hosted OAuth page rather than
 * requiring our own TikTok/Meta developer app approval.
 *
 * Docs: https://docs.upload-post.com (White-label Integration Guide)
 */

const axios = require('axios');

const UP_BASE = 'https://api.upload-post.com';

function headers() {
  const key = process.env.UPLOADPOST_API_KEY;
  if (!key) throw new Error('UPLOADPOST_API_KEY is not set');
  return { Authorization: `Apikey ${key}`, 'Content-Type': 'application/json' };
}

/**
 * Ensure an Upload-Post profile exists for this customer.
 * Creates it on first call; swallows 409 (already exists).
 * @param {string} customerId — Clerk user ID (used as the Upload-Post username)
 */
async function ensureProfile(customerId) {
  try {
    await axios.post(
      `${UP_BASE}/api/uploadposts/users`,
      { username: customerId },
      { headers: headers() }
    );
  } catch (err) {
    if (err.response?.status === 409) return; // already exists — fine
    throw err;
  }
}

/**
 * Generate a secure Upload-Post connect URL for a customer.
 * Redirect the browser to the returned access_url.
 *
 * @param {string} customerId
 * @param {object} opts
 * @param {string}   opts.redirectUrl   — where Upload-Post sends the user after connecting
 * @param {string[]} [opts.platforms]   — limit which platforms are shown (e.g. ['tiktok'])
 * @returns {Promise<string>} access_url
 */
async function generateConnectUrl(customerId, { redirectUrl, platforms } = {}) {
  await ensureProfile(customerId);

  // Pre-disconnect any platform being (re)connected so Upload-Post starts with a
  // clean PKCE session. Without this, a stale linked account causes Upload-Post to
  // serve an expired PKCE verifier → "missing code or verifier" on the next connect.
  if (platforms?.length) {
    for (const platform of platforms) {
      await disconnectPlatform(customerId, platform).catch((err) => {
        // Best-effort — if the pre-disconnect fails we still attempt the connect
        console.warn(`[uploadpost] pre-disconnect ${platform} failed (non-fatal): ${err?.message}`);
      });
    }
  }

  const body = {
    username:              customerId,
    redirect_url:          redirectUrl,
    redirect_button_text:  'Back to AuraFlux',
    connect_title:         'Connect your social accounts',
    connect_description:   'Link your TikTok or Instagram so AuraFlux can publish on your behalf.',
    logo_image:            process.env.NEXT_PUBLIC_APP_URL
                             ? `${process.env.NEXT_PUBLIC_APP_URL}/brand/logo-512.png`
                             : 'https://auraflux-app.onrender.com/brand/logo-512.png',
    show_calendar:         false,
  };
  if (platforms?.length) body.platforms = platforms;

  const res = await axios.post(
    `${UP_BASE}/api/uploadposts/users/generate-jwt`,
    body,
    { headers: headers() }
  );
  return res.data.access_url;
}

/**
 * Fetch a customer's Upload-Post profile including connected social accounts.
 * Returns null if the profile doesn't exist yet.
 *
 * social_accounts shape: { tiktok: { username, display_name } | null, instagram: {...} | null, ... }
 *
 * @param {string} customerId
 * @returns {Promise<object|null>}
 */
async function getProfile(customerId) {
  try {
    const res = await axios.get(
      `${UP_BASE}/api/uploadposts/users/${encodeURIComponent(customerId)}`,
      { headers: headers() }
    );
    return res.data.profile || res.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Return connected Upload-Post platforms for a customer in the same shape
 * as listConnectedPlatforms() from token_store.js so the accounts endpoint
 * can merge both sources.
 *
 * @param {string} customerId
 * @returns {Promise<Array<{platform, handle, platformUserId, connectedAt}>>}
 */
async function listUploadPostAccounts(customerId) {
  const profile = await getProfile(customerId);
  if (!profile?.social_accounts) return [];

  const PLATFORMS = ['tiktok', 'instagram'];
  const accounts = [];

  for (const platform of PLATFORMS) {
    const acct = profile.social_accounts[platform];
    if (acct && typeof acct === 'object' && (acct.handle || acct.display_name || acct.username)) {
      accounts.push({
        platform,
        handle:         acct.handle || acct.display_name || acct.username || null,
        platformUserId: acct.id || acct.username || null,
        tokenExpiry:    null,
        connectedAt:    profile.created_at || null,
        via:            'upload-post',
      });
    }
  }

  return accounts;
}

/**
 * Reset an Upload-Post profile by deleting and immediately recreating it.
 * Used when a customer disconnects a managed platform (TikTok / Instagram) so
 * the next connect flow starts with a clean OAuth session instead of hitting
 * a stale linked account inside Upload-Post's hosted UI.
 *
 * @param {string} customerId
 */
async function resetProfile(customerId) {
  try {
    await axios.delete(
      `${UP_BASE}/api/uploadposts/users`,
      { data: { username: customerId }, headers: headers() }
    );
  } catch (err) {
    // 404 = profile didn't exist; that's fine — just recreate
    if (err.response?.status !== 404) throw err;
  }
  // Recreate the empty profile so ensureProfile on the next connect is a no-op
  await ensureProfile(customerId);
}

/**
 * Disconnect a single social platform from a customer's Upload-Post profile.
 * Unlike resetProfile(), this leaves all other connected platforms intact.
 *
 * Uses DELETE /api/uploadposts/users/social — confirmed endpoint Jun 2026.
 *
 * @param {string} customerId — Clerk user ID (Upload-Post profile_username)
 * @param {string} platform   — 'tiktok' | 'instagram'
 */
async function disconnectPlatform(customerId, platform) {
  try {
    await axios.delete(
      `${UP_BASE}/api/uploadposts/users/social`,
      { data: { profile_username: customerId, social_platform: platform }, headers: headers() }
    );
  } catch (err) {
    // 404 = profile or connection didn't exist — that's fine
    if (err.response?.status === 404) return;
    // Log full response body for non-404 failures so we can diagnose Upload-Post rejections
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[uploadpost] disconnectPlatform(${platform}) failed ${err.response?.status || 'ERR'}: ${body}`);
    throw err;
  }
}

module.exports = { ensureProfile, generateConnectUrl, getProfile, listUploadPostAccounts, resetProfile, disconnectPlatform };
