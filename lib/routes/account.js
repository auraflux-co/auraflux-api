'use strict';
/**
 * lib/routes/account.js — Dashboard account management (Clerk JWT auth)
 *
 * Provides API key management for the dashboard at /account/api-keys.
 * Uses Clerk JWT auth (requireAuth) so the dashboard can bootstrap and manage
 * API keys without needing an existing API key (chicken-and-egg fix for CPD-126).
 *
 * The identical endpoints also exist at /v1/account/api-keys but require an
 * API key bearer token for programmatic API consumer use.
 */

const router      = require('express').Router();
const { requireAuth }                    = require('../auth/clerk');
const { resolveBrandContext }            = require('../auth/brand_access');
const { createClerkClient }              = require('@clerk/express');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { listConnectedPlatforms }         = require('../services/token_store');
const { query }   = require('../db/postgres');
const { logError } = require('../error_logger');

function getClerk() {
  return createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
}

const ALLOWED_CHANNEL_KEYS = ['twitchLogin', 'kickUsername', 'youtubeHandle'];

// ─── Plan-tier guard for API key routes ───────────────────────────────────────
// API Keys are an Operate-plan feature — programmatic API access is for
// self-serve customers who run the platform themselves. Guided and Managed
// customers do not use direct API keys; their operator manages everything.
function requireOperatePlan(req, res, next) {
  const tier = req.user?.planTier || 'operate';
  if (tier === 'operate' || tier === 'custom') return next();
  return res.status(403).json({
    ok:      false,
    error:   'operate_plan_required',
    message: 'API Keys are available on the Operate plan. Your current plan does not include direct API access.',
  });
}

// ─── GET /account/api-keys ────────────────────────────────────────────────────
router.get('/account/api-keys', requireAuth, requireOperatePlan, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({ ok: true, apiKeys: keys });
  } catch (err) {
    logError('ACCOUNT_LIST_KEYS_FAIL', err);
    res.status(500).json({ ok: false, error: 'list_keys_failed' });
  }
});

// ─── POST /account/api-keys ───────────────────────────────────────────────────
router.post('/account/api-keys', requireAuth, requireOperatePlan, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name_required', message: 'A name for the API key is required' });
  }
  try {
    const planTier = req.user.planTier || 'operate';
    const { key, record } = await createApiKey(req.user.id, planTier, name.trim());
    res.status(201).json({
      ok:        true,
      key,
      id:        record.id,
      prefix:    record.key_prefix,
      name:      record.name,
      createdAt: record.created_at,
      warning:   'Store this key securely — it will not be shown again.',
    });
  } catch (err) {
    logError('ACCOUNT_CREATE_KEY_FAIL', err);
    res.status(500).json({ ok: false, error: 'create_key_failed' });
  }
});

// ─── DELETE /account/api-keys/:keyId ──────────────────────────────────────────
router.delete('/account/api-keys/:keyId', requireAuth, requireOperatePlan, async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.params.keyId, req.user.id);
    if (!revoked) return res.status(404).json({ ok: false, error: 'key_not_found' });
    res.json({ ok: true, revoked: true, keyId: req.params.keyId });
  } catch (err) {
    logError('ACCOUNT_REVOKE_KEY_FAIL', err);
    res.status(500).json({ ok: false, error: 'revoke_key_failed' });
  }
});

// ─── GET /account/source-channels ────────────────────────────────────────────
router.get('/account/source-channels', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    // Brand-scoped: use brand_id when available, fall back to client_id for legacy rows
    const whereClause = req.brandId
      ? 'brand_id = $1 AND active = TRUE'
      : 'client_id = $1 AND active = TRUE';
    const param = req.brandId || req.user.id;

    const { loadTokens } = require('../services/token_store');
    const kickOAuth = require('../publish/adapters/kick_oauth');
    const [result, kickTokensRaw] = await Promise.all([
      query(
        `SELECT source_channels FROM client_plans WHERE ${whereClause} LIMIT 1`,
        [param]
      ),
      loadTokens(req.user.id, null, 'kick').catch(() => null),
    ]);
    let channels = result.rows[0]?.source_channels || {};
    const oauthConnections = [];
    let kickTokens = kickTokensRaw;
    if (kickTokens?.accessToken) {
      kickTokens = await kickOAuth.syncKickProfile(req.user.id, kickTokens);
    }
    if (kickTokens?.accessToken) {
      if (kickTokens.platformHandle && !channels.kickUsername) {
        channels = {
          ...channels,
          kickUsername: String(kickTokens.platformHandle).replace(/^@/, '').toLowerCase(),
        };
      }
      oauthConnections.push({
        platform:       'kick',
        handle:         kickTokens.platformHandle || null,
        platformUserId: kickTokens.platformUserId || null,
        connectedAt:    kickTokens.updatedAt || null,
      });
    }
    res.json({ ok: true, sourceChannels: channels, oauthConnections });
  } catch (err) {
    logError('ACCOUNT_GET_SOURCE_CHANNELS_FAIL', err);
    res.status(500).json({ ok: false, error: 'get_source_channels_failed' });
  }
});

// ─── PATCH /account/source-channels ──────────────────────────────────────────
router.patch('/account/source-channels', requireAuth, resolveBrandContext, async (req, res) => {
  const body = req.body || {};
  const update = {};
  for (const key of ALLOWED_CHANNEL_KEYS) {
    if (key in body) {
      const val = String(body[key] || '').trim();
      update[key] = val;
    }
  }
  try {
    const whereClause = req.brandId
      ? 'brand_id = $2 AND active = TRUE'
      : 'client_id = $2 AND active = TRUE';
    const param = req.brandId || req.user.id;

    const result = await query(
      `UPDATE client_plans
          SET source_channels = source_channels || $1::jsonb
        WHERE ${whereClause}
        RETURNING source_channels`,
      [JSON.stringify(update), param]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'plan_not_found' });
    }

    // CPD-1006: auto-sync Twitch avatar → brand.image_url when twitchLogin is saved
    if (update.twitchLogin && req.brandId && req.user?.id) {
      const { syncBrandFromTwitch } = require('../services/brand_twitch_sync');
      syncBrandFromTwitch({
        brandId:     req.brandId,
        accountId:   req.user.id,
        twitchLogin: update.twitchLogin,
        force:       true,
      }).catch((err) => logError('ACCOUNT_TWITCH_AVATAR_SYNC_FAIL', err));
    }

    res.json({ ok: true, sourceChannels: result.rows[0].source_channels });
  } catch (err) {
    logError('ACCOUNT_PATCH_SOURCE_CHANNELS_FAIL', err);
    res.status(500).json({ ok: false, error: 'save_source_channels_failed' });
  }
});

// ─── GET /account/schedule-prefs ─────────────────────────────────────────────
// Returns saved per-platform publish schedule preferences (CPD-594).
// Shape: { prefs: { youtube: [{day:0-6|−1, time:'HH:MM'}], tiktok: [...], instagram: [...] } }
// day −1 = daily.
router.get('/account/schedule-prefs', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const whereClause = req.brandId
      ? 'brand_id = $1 AND active = TRUE'
      : 'client_id = $1 AND active = TRUE';
    const param = req.brandId || req.user.id;
    const result = await query(
      `SELECT publish_schedule_prefs FROM client_plans WHERE ${whereClause} LIMIT 1`,
      [param]
    );
    const prefs = result.rows[0]?.publish_schedule_prefs || {};
    res.json({ ok: true, prefs });
  } catch (err) {
    logError('ACCOUNT_GET_SCHEDULE_PREFS_FAIL', err);
    res.status(500).json({ ok: false, error: 'get_schedule_prefs_failed' });
  }
});

// ─── PUT /account/schedule-prefs ─────────────────────────────────────────────
// Replaces the full per-platform publish schedule preferences (CPD-594).
// Body: { prefs: { youtube: [{day, time}], ... } }
// Validates shape: each platform entry must be an array of {day, time} objects.
router.put('/account/schedule-prefs', requireAuth, resolveBrandContext, async (req, res) => {
  const { prefs } = req.body || {};
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return res.status(400).json({ ok: false, error: 'invalid_prefs_shape' });
  }
  const ALLOWED_PLATFORMS = ['youtube', 'tiktok', 'instagram'];
  const sanitised = {};
  for (const platform of ALLOWED_PLATFORMS) {
    if (!prefs[platform]) continue;
    if (!Array.isArray(prefs[platform])) continue;
    sanitised[platform] = prefs[platform]
      .filter((s) => {
        const dayOk  = Number.isInteger(s.day) && s.day >= -1 && s.day <= 6;
        const timeOk = typeof s.time === 'string' && /^\d{2}:\d{2}$/.test(s.time);
        return dayOk && timeOk;
      })
      .slice(0, 14); // cap at 14 slots per platform
  }
  try {
    const whereClause = req.brandId
      ? 'brand_id = $2 AND active = TRUE'
      : 'client_id = $2 AND active = TRUE';
    const param = req.brandId || req.user.id;
    const result = await query(
      `UPDATE client_plans
          SET publish_schedule_prefs = $1::jsonb
        WHERE ${whereClause}
        RETURNING publish_schedule_prefs`,
      [JSON.stringify(sanitised), param]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'plan_not_found' });
    }
    res.json({ ok: true, prefs: result.rows[0].publish_schedule_prefs });
  } catch (err) {
    logError('ACCOUNT_PUT_SCHEDULE_PREFS_FAIL', err);
    res.status(500).json({ ok: false, error: 'save_schedule_prefs_failed' });
  }
});

// ─── GET /account/setup-status ───────────────────────────────────────────────
// Returns which onboarding steps are complete for the current customer.
// Steps (3 — setup only, not first job):
//   accountCreated     — always true (they're authenticated)
//   sourceChannelSaved — at least one channel in source_channels JSONB
//   platformConnected  — at least one OAuth token in platform_oauth_tokens
// "Submit your first job" is the next action after setup, not a setup gate.
router.get('/account/setup-status', requireAuth, async (req, res) => {
  const customerId = req.user.id;
  try {
    const [channelsResult, connectedPlatforms] = await Promise.all([
      query(
        'SELECT source_channels FROM client_plans WHERE client_id = $1 AND active = TRUE LIMIT 1',
        [customerId]
      ),
      listConnectedPlatforms(customerId),
    ]);

    const sourceChannels = channelsResult.rows[0]?.source_channels || {};
    const hasSourceChannel = Object.values(sourceChannels).some((v) => v && String(v).trim());
    const hasPlatformConnected = connectedPlatforms.length > 0;

    const steps = {
      accountCreated:     true,
      sourceChannelSaved: hasSourceChannel,
      platformConnected:  hasPlatformConnected,
    };

    const doneCount  = Object.values(steps).filter(Boolean).length;
    const totalSteps = Object.keys(steps).length;

    res.json({
      steps,
      doneCount,
      totalSteps,
      allComplete:      doneCount === totalSteps,
      connectedHandles: connectedPlatforms.map((p) => ({ platform: p.platform, handle: p.handle })),
      sourceChannels,
    });
  } catch (err) {
    logError('ACCOUNT_SETUP_STATUS_FAIL', err);
    res.status(500).json({ ok: false, error: 'setup_status_failed' });
  }
});

// ─── POST /account/setup-status/dismiss ──────────────────────────────────────
// Permanently dismisses the setup checklist for this user. Writes
// setupDismissed: true into Clerk publicMetadata so the server component
// can suppress the card entirely without a DB round-trip.
router.post('/account/setup-status/dismiss', requireAuth, async (req, res) => {
  try {
    const clerk = getClerk();
    await clerk.users.updateUserMetadata(req.user.id, {
      publicMetadata: { setupDismissed: true },
    });
    res.json({ ok: true });
  } catch (err) {
    logError('ACCOUNT_SETUP_DISMISS_FAIL', err);
    res.status(500).json({ ok: false, error: 'dismiss_failed' });
  }
});

module.exports = router;
