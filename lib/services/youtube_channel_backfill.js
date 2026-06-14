'use strict';
/**
 * Backfill missing YouTube channel metadata (platform_user_id / platform_handle)
 * on platform_oauth_tokens rows where OAuth succeeded but getChannelInfo failed.
 */

const { loadTokens, saveTokens } = require('./token_store');
const {
  listAllChannels,
  refreshAccessToken,
  matchChannelForBrand,
} = require('../publish/adapters/youtube');

/**
 * Resolve and persist YouTube channel id + handle for a brand.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {string} p.brandId
 * @param {string} [p.brandName] — used for auraflux-{name} matching
 * @param {string} [p.expectedHandle] — e.g. auraflux-wanderbot or @auraflux-wanderbot
 * @param {string} [p.channelId] — skip lookup when known
 */
async function backfillYouTubeChannelMeta({
  customerId,
  brandId,
  brandName = null,
  expectedHandle = null,
  channelId = null,
}) {
  const tokens = await loadTokens(customerId, brandId, 'youtube');
  if (!tokens?.refreshToken && !tokens?.accessToken) {
    throw new Error(`No YouTube tokens stored for brand ${brandId}`);
  }

  let accessToken = tokens.accessToken;
  let tokenExpiry = tokens.tokenExpiry;
  let refreshToken = tokens.refreshToken;

  const expired =
    !accessToken ||
    (tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date(Date.now() + 60_000));

  if (expired && refreshToken) {
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.access_token;
    refreshToken = refreshed.refresh_token || refreshToken;
    tokenExpiry = refreshed.expires_in
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : tokenExpiry;
  }

  if (!accessToken) {
    throw new Error(`YouTube access token unavailable for brand ${brandId}`);
  }

  let platformUserId = channelId || tokens.platformUserId;
  let platformHandle = tokens.platformHandle;

  if (!platformUserId || !platformHandle) {
    const channels = await listAllChannels(accessToken);
    if (!channels.length) {
      throw new Error('YouTube channels.list returned no channels for this account');
    }

    const match = matchChannelForBrand(channels, {
      brandName,
      expectedHandle,
      channelId,
    });

    if (!match) {
      const hints = channels
        .slice(0, 5)
        .map((c) => c.platformHandle || c.platformUserId)
        .join(', ');
      throw new Error(
        `No YouTube channel matched brand ${brandName || brandId}` +
          (expectedHandle ? ` (expected ${expectedHandle})` : '') +
          `. Available: ${hints}`
      );
    }

    platformUserId = match.platformUserId;
    platformHandle = match.platformHandle;
  }

  await saveTokens({
    customerId,
    brandId,
    platform: 'youtube',
    accessToken,
    refreshToken,
    tokenExpiry,
    scope: tokens.scope,
    platformUserId,
    platformHandle,
    rawMeta: tokens.rawMeta,
  });

  return { platformUserId, platformHandle };
}

module.exports = { backfillYouTubeChannelMeta };
