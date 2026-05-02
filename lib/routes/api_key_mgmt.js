'use strict';
/**
 * lib/routes/api_key_mgmt.js — CPD-131 fix
 *
 * Clerk-authenticated management endpoints for API keys.
 * Used by the /dashboard/settings/api-keys page.
 * Separate from /v1/account/api-keys (which requires an existing API key — chicken-and-egg).
 *
 * Routes:
 *   GET    /account/api-keys           — list keys for logged-in customer
 *   POST   /account/api-keys           — create a new key
 *   DELETE /account/api-keys/:keyId    — revoke a key
 */

const express = require('express');
const { requireAuth } = require('../auth');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { logError } = require('../error_logger');

const router = express.Router();

// GET /account/api-keys
router.get('/account/api-keys', requireAuth, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({ ok: true, apiKeys: keys });
  } catch (err) {
    logError('CPD131_LIST_KEYS_FAIL', err, { userId: req.user.id });
    res.status(500).json({ ok: false, error: 'list_keys_failed' });
  }
});

// POST /account/api-keys
router.post('/account/api-keys', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  const planTier = req.user.planTier || 'diy';
  try {
    const { key, record } = await createApiKey(req.user.id, planTier, name || '');
    res.status(201).json({
      ok: true,
      key,
      id:        record.id,
      prefix:    record.key_prefix,
      name:      record.name,
      createdAt: record.created_at,
      warning:   'Store this key securely — it will not be shown again.',
    });
  } catch (err) {
    logError('CPD131_CREATE_KEY_FAIL', err, { userId: req.user.id });
    res.status(500).json({ ok: false, error: 'create_key_failed' });
  }
});

// DELETE /account/api-keys/:keyId
router.delete('/account/api-keys/:keyId', requireAuth, async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.params.keyId, req.user.id);
    if (!revoked) return res.status(404).json({ ok: false, error: 'key_not_found' });
    res.json({ ok: true, revoked: true, keyId: req.params.keyId });
  } catch (err) {
    logError('CPD131_REVOKE_KEY_FAIL', err, { userId: req.user.id });
    res.status(500).json({ ok: false, error: 'revoke_key_failed' });
  }
});

module.exports = router;
