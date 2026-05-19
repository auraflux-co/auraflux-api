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
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { query }   = require('../db/postgres');
const { logError } = require('../error_logger');

const ALLOWED_CHANNEL_KEYS = ['twitchLogin', 'kickUsername', 'youtubeHandle'];

// ─── GET /account/api-keys ────────────────────────────────────────────────────
router.get('/account/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({ ok: true, apiKeys: keys });
  } catch (err) {
    logError('ACCOUNT_LIST_KEYS_FAIL', err);
    res.status(500).json({ ok: false, error: 'list_keys_failed' });
  }
});

// ─── POST /account/api-keys ───────────────────────────────────────────────────
router.post('/account/api-keys', requireAuth, async (req, res) => {
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
router.delete('/account/api-keys/:keyId', requireAuth, async (req, res) => {
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
router.get('/account/source-channels', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT source_channels FROM client_plans WHERE client_id = $1 AND active = TRUE LIMIT 1',
      [req.user.id]
    );
    const channels = result.rows[0]?.source_channels || {};
    res.json({ ok: true, sourceChannels: channels });
  } catch (err) {
    logError('ACCOUNT_GET_SOURCE_CHANNELS_FAIL', err);
    res.status(500).json({ ok: false, error: 'get_source_channels_failed' });
  }
});

// ─── PATCH /account/source-channels ──────────────────────────────────────────
router.patch('/account/source-channels', requireAuth, async (req, res) => {
  const body = req.body || {};
  const update = {};
  for (const key of ALLOWED_CHANNEL_KEYS) {
    if (key in body) {
      const val = String(body[key] || '').trim();
      update[key] = val;
    }
  }
  try {
    const result = await query(
      `UPDATE client_plans
          SET source_channels = source_channels || $1::jsonb
        WHERE client_id = $2 AND active = TRUE
        RETURNING source_channels`,
      [JSON.stringify(update), req.user.id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'plan_not_found' });
    }
    res.json({ ok: true, sourceChannels: result.rows[0].source_channels });
  } catch (err) {
    logError('ACCOUNT_PATCH_SOURCE_CHANNELS_FAIL', err);
    res.status(500).json({ ok: false, error: 'save_source_channels_failed' });
  }
});

module.exports = router;
