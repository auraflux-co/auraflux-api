'use strict';
/**
 * Channel connection limits by plan — Growth: 3; Operate+: unlimited.
 */
const { listConnectedPlatforms } = require('./token_store');
const { getClientPlan } = require('../db/postgres');
const { getPlanDefaults } = require('./plan_entitlements');

async function getMaxChannels(clientId) {
  const plan = await getClientPlan(clientId);
  const tier = plan?.tier || 'operate';
  const fromPlan = plan?.max_channels;
  if (fromPlan != null) return Number(fromPlan);
  return getPlanDefaults(tier).max_channels; // null = unlimited
}

/**
 * Throws ChannelLimitError if connecting a *new* platform would exceed the cap.
 * Updating an existing platform connection is always allowed.
 */
async function assertCanConnectPlatform(clientId, platform, brandId = null) {
  const max = await getMaxChannels(clientId);
  if (max == null) return { ok: true, unlimited: true };

  const connected = brandId != null
    ? await listConnectedPlatforms(clientId, brandId)
    : await listConnectedPlatforms(clientId);

  const already = connected.some(
    (c) => String(c.platform).toLowerCase() === String(platform).toLowerCase(),
  );
  if (already) return { ok: true, updating: true, max, used: connected.length };

  if (connected.length >= max) {
    const err = new Error(
      `Channel limit reached (${connected.length}/${max}). Upgrade to Pro Operator for unlimited channels.`,
    );
    err.code = 'CHANNEL_LIMIT';
    err.status = 403;
    err.max = max;
    err.used = connected.length;
    throw err;
  }
  return { ok: true, max, used: connected.length };
}

module.exports = {
  getMaxChannels,
  assertCanConnectPlatform,
};
