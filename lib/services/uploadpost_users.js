'use strict';
/**
 * lib/services/uploadpost_users.js — Upload-Post white-label profile management
 *
 * Each AuraFlux BRAND gets its own Upload-Post profile (username = brandId).
 * This means switching brands in the brand picker shows the correct TikTok/Instagram
 * for that brand, and connecting/disconnecting one brand never affects another.
 *
 * Profile username = brandId (UUID, hyphens are valid in Upload-Post usernames).
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
 * Ensure an Upload-Post profile exists for this brand.
 * Creates it on first call; swallows 409 (already exists).
 * @param {string} brandId — AuraFlux brand UUID (used as the Upload-Post username)
 */
async function ensureProfile(brandId) {
  try {
    await axios.post(
      `${UP_BASE}/api/uploadposts/users`,
      { username: brandId },
      { headers: headers() }
    );
  } catch (err) {
    if (err.response?.status === 409) return; // already exists — fine
    throw err;
  }
}

/**
 * Generate a secure Upload-Post connect URL for a brand.
 * Redirect the browser to the returned access_url.
 *
 * @param {string} brandId — AuraFlux brand UUID
 * @param {object} opts
 * @param {string}   opts.redirectUrl   — where Upload-Post sends the user after connecting
 * @param {string[]} [opts.platforms]   — limit which platforms are shown (e.g. ['tiktok'])
 * @returns {Promise<string>} access_url
 */
async function generateConnectUrl(brandId, { redirectUrl, platforms } = {}) {
  await ensureProfile(brandId);

  // Pre-disconnect any platform being (re)connected so Upload-Post starts with a
  // clean PKCE session. Without this, a stale linked account causes Upload-Post to
  // serve an expired PKCE verifier → "missing code or verifier" on the next connect.
  if (platforms?.length) {
    let didDisconnect = false;
    for (const platform of platforms) {
      try {
        await disconnectPlatform(brandId, platform);
        didDisconnect = true;
        console.log(`[uploadpost] pre-disconnect ${platform} succeeded for brand ${brandId}`);
      } catch (err) {
        console.warn(`[uploadpost] pre-disconnect ${platform} failed (non-fatal): ${err?.message}`);
      }
    }
    if (didDisconnect) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const body = {
    username:              brandId,
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
 * Fetch a brand's Upload-Post profile including connected social accounts.
 * Returns null if the profile doesn't exist yet.
 *
 * social_accounts shape: { tiktok: { username, display_name } | null, instagram: {...} | null, ... }
 *
 * @param {string} brandId — AuraFlux brand UUID
 * @returns {Promise<object|null>}
 */
async function getProfile(brandId) {
  try {
    const res = await axios.get(
      `${UP_BASE}/api/uploadposts/users/${encodeURIComponent(brandId)}`,
      { headers: headers() }
    );
    return res.data.profile || res.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Return connected Upload-Post platforms for a brand in the same shape
 * as listConnectedPlatforms() from token_store.js so the accounts endpoint
 * can merge both sources.
 *
 * @param {string} brandId — AuraFlux brand UUID
 * @returns {Promise<Array<{platform, handle, platformUserId, connectedAt}>>}
 */
async function listUploadPostAccounts(brandId) {
  const profile = await getProfile(brandId);
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
 *
 * @param {string} brandId — AuraFlux brand UUID
 */
async function resetProfile(brandId) {
  try {
    await axios.delete(
      `${UP_BASE}/api/uploadposts/users`,
      { data: { username: brandId }, headers: headers() }
    );
  } catch (err) {
    if (err.response?.status !== 404) throw err;
  }
  await ensureProfile(brandId);
}

/**
 * Disconnect a single social platform from a brand's Upload-Post profile.
 * Leaves all other connected platforms intact.
 *
 * @param {string} brandId  — AuraFlux brand UUID
 * @param {string} platform — 'tiktok' | 'instagram'
 */
async function disconnectPlatform(brandId, platform) {
  try {
    await axios.delete(
      `${UP_BASE}/api/uploadposts/users/social`,
      { data: { profile_username: brandId, social_platform: platform }, headers: headers() }
    );
  } catch (err) {
    if (err.response?.status === 404) return;
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[uploadpost] disconnectPlatform(${platform}) failed ${err.response?.status || 'ERR'}: ${body}`);
    throw err;
  }
}

module.exports = { ensureProfile, generateConnectUrl, getProfile, listUploadPostAccounts, resetProfile, disconnectPlatform };
