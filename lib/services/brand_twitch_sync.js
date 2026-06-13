'use strict';
/**
 * lib/services/brand_twitch_sync.js — CPD-1006
 *
 * Sync sub-brand identity from Twitch profile_image_url → R2 → brands.image_url.
 * Used at channel-save time, job-creation branding gate, and bulk onboarding scripts.
 */

const axios = require('axios');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const TwitchClient = require('../clients/twitch_client');
const { getBrand, updateBrand, getClientPlanByBrand } = require('../db/postgres');
const { logError } = require('../error_logger');

function _r2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId || !process.env.R2_ACCESS_KEY_ID) return null;
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

/**
 * Upload a logo buffer to R2 and return the public HTTPS URL.
 * @param {Buffer} buffer
 * @param {string} accountId
 * @param {string} brandId
 * @param {string} [suffix]
 * @returns {Promise<string|null>}
 */
async function uploadBrandLogoToR2(buffer, accountId, brandId, suffix = 'twitch') {
  const r2 = _r2Client();
  if (!r2) return null;

  const bucket = process.env.R2_VIDEO_BUCKET || 'auraflux-video-output';
  const key    = `brands/${accountId}/${brandId}/logo/${suffix}_${Date.now()}.png`;

  await r2.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        buffer,
    ContentType: 'image/png',
  }));

  const assetsDomain = process.env.R2_ASSETS_DOMAIN;
  if (assetsDomain) return `https://${assetsDomain}/${key}`;
  return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
}

/**
 * Resolve Twitch login for a brand: source_channels.twitchLogin, else brand slug/name.
 * @param {string} brandId
 * @returns {Promise<string|null>}
 */
async function resolveTwitchLoginForBrand(brandId) {
  try {
    const plan = await getClientPlanByBrand(brandId);
    const login = plan?.source_channels?.twitchLogin;
    if (login && String(login).trim()) return String(login).trim().toLowerCase();
  } catch (_) { /* non-fatal */ }

  try {
    const pool = require('../db/postgres').getPool();
    if (pool) {
      const { rows } = await pool.query(
        `SELECT slug, name FROM brands WHERE id = $1 LIMIT 1`,
        [brandId],
      );
      const slug = rows[0]?.slug;
      if (slug && /^[a-z0-9_]+$/.test(slug)) return slug.toLowerCase();
    }
  } catch (_) { /* non-fatal */ }

  return null;
}

/**
 * Fetch Twitch avatar and persist on the brand row.
 *
 * @param {{ brandId: string, accountId: string, twitchLogin?: string, force?: boolean }}
 * @returns {Promise<{ ok: boolean, imageUrl?: string, skipped?: boolean, error?: string }>}
 */
async function syncBrandFromTwitch({ brandId, accountId, twitchLogin, force = false }) {
  if (!brandId || !accountId) {
    return { ok: false, error: 'brandId and accountId required' };
  }

  try {
    const brand = await getBrand(brandId, accountId);
    if (!brand) return { ok: false, error: 'brand_not_found' };
    if (brand.image_url && !force) return { ok: true, imageUrl: brand.image_url, skipped: true };

    const login = (twitchLogin || await resolveTwitchLoginForBrand(brandId) || '').trim().toLowerCase();
    if (!login) return { ok: false, error: 'no_twitch_login' };

    const client = new TwitchClient();
    const user   = await client.getUserByLogin(login);
    if (!user?.profile_image_url) return { ok: false, error: 'twitch_user_not_found' };

    // Request higher-res avatar when Twitch serves a templated URL
    const avatarUrl = String(user.profile_image_url)
      .replace(/-\d+x\d+\./, '-600x600.')
      .replace('{width}', '600')
      .replace('{height}', '600');

    const resp = await axios.get(avatarUrl, {
      responseType: 'arraybuffer',
      timeout:      20000,
      headers:      { Accept: 'image/*' },
    });

    const imageUrl = await uploadBrandLogoToR2(Buffer.from(resp.data), accountId, brandId, login);
    if (!imageUrl) return { ok: false, error: 'r2_upload_failed' };

    await updateBrand(brandId, accountId, { image_url: imageUrl });

    console.log(`[brand_twitch_sync] ${brandId} (${login}) → ${imageUrl}`);
    return { ok: true, imageUrl, twitchLogin: login, displayName: user.display_name };
  } catch (err) {
    logError('[brand_twitch_sync] sync failed', err, { brandId, accountId, twitchLogin });
    return { ok: false, error: err.message };
  }
}

/**
 * Ensure brand has image_url — sync from Twitch when missing.
 * @returns {Promise<boolean>} true when logo is present after call
 */
async function ensureBrandLogo({ brandId, accountId, twitchLogin }) {
  if (!brandId || !accountId) return false;
  try {
    const brand = await getBrand(brandId, accountId);
    if (brand?.image_url) return true;
    const result = await syncBrandFromTwitch({ brandId, accountId, twitchLogin });
    return !!(result.ok && result.imageUrl);
  } catch (_) {
    return false;
  }
}

module.exports = {
  syncBrandFromTwitch,
  ensureBrandLogo,
  resolveTwitchLoginForBrand,
  uploadBrandLogoToR2,
};
