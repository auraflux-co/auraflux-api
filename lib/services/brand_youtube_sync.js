'use strict';
/**
 * lib/services/brand_youtube_sync.js — CPD-1231
 *
 * Sync sub-brand logo from YouTube channel avatar (public API handle lookup).
 * Skips when brand already has image_url — production uploads take precedence.
 */

const axios = require('axios');
const YouTubeClient = require('../clients/youtube_client');
const { getBrand, updateBrand, getClientPlanByBrand } = require('../db/postgres');
const { uploadBrandLogoToR2 } = require('./brand_twitch_sync');
const { logError } = require('../error_logger');

/**
 * Resolve YouTube @handle for a brand from source_channels.
 */
async function resolveYouTubeHandleForBrand(brandId) {
  try {
    const plan = await getClientPlanByBrand(brandId);
    const handle = plan?.source_channels?.youtubeHandle;
    if (handle && String(handle).trim()) {
      return String(handle).trim().replace(/^@/, '');
    }
  } catch (_) { /* non-fatal */ }
  return null;
}

/**
 * Fetch YouTube channel avatar and persist on brand row.
 * @param {{ brandId: string, accountId: string, youtubeHandle?: string, force?: boolean }}
 */
async function syncBrandFromYouTube({ brandId, accountId, youtubeHandle, force = false }) {
  if (!brandId || !accountId) {
    return { ok: false, error: 'brandId and accountId required' };
  }
  if (!process.env.YOUTUBE_API_KEY) {
    return { ok: false, error: 'youtube_api_not_configured' };
  }

  try {
    const brand = await getBrand(brandId, accountId);
    if (!brand) return { ok: false, error: 'brand_not_found' };
    if (brand.image_url && !force) {
      return { ok: true, imageUrl: brand.image_url, skipped: true };
    }

    const handle = (youtubeHandle || await resolveYouTubeHandleForBrand(brandId) || '').trim();
    if (!handle) return { ok: false, error: 'no_youtube_handle' };

    const client = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle.startsWith('@') ? handle : `@${handle}`);
    if (!channel?.thumbnailUrl) return { ok: false, error: 'youtube_channel_not_found' };

    const thumbUrl = String(channel.thumbnailUrl)
      .replace(/=s\d+/, '=s600')
      .replace(/\/default\.jpg/, '/hqdefault.jpg');

    const resp = await axios.get(thumbUrl, {
      responseType: 'arraybuffer',
      timeout:      20000,
      headers:      { Accept: 'image/*' },
    });

    const imageUrl = await uploadBrandLogoToR2(Buffer.from(resp.data), accountId, brandId, 'youtube');
    if (!imageUrl) return { ok: false, error: 'r2_upload_failed' };

    await updateBrand(brandId, accountId, { image_url: imageUrl });
    console.log(`[brand_youtube_sync] ${brandId} (@${handle}) → ${imageUrl}`);
    return { ok: true, imageUrl, youtubeHandle: handle, channelTitle: channel.title };
  } catch (err) {
    logError('[brand_youtube_sync] sync failed', err, { brandId, accountId, youtubeHandle });
    return { ok: false, error: err.message };
  }
}

/**
 * Ensure brand has image_url — try YouTube when missing (testing / sub-brand onboarding).
 */
async function ensureBrandLogoFromYouTube({ brandId, accountId, youtubeHandle }) {
  if (!brandId || !accountId) return false;
  try {
    const brand = await getBrand(brandId, accountId);
    if (brand?.image_url) return true;
    const result = await syncBrandFromYouTube({ brandId, accountId, youtubeHandle });
    return !!(result.ok && result.imageUrl);
  } catch (_) {
    return false;
  }
}

module.exports = {
  syncBrandFromYouTube,
  ensureBrandLogoFromYouTube,
  resolveYouTubeHandleForBrand,
};
