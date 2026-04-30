'use strict';
/**
 * lib/routes/social_connect.js — OAuth connect/disconnect for direct platform publishing (CPD-86)
 *
 * GET  /social/connect/:platform        → redirect to platform OAuth
 * GET  /social/callback/:platform       → OAuth callback, save tokens
 * GET  /social/accounts                 → list connected platforms for current customer
 * DELETE /social/accounts/:platform     → disconnect a platform
 *
 * All routes require Clerk auth. Platform: 'youtube' | 'tiktok' | 'instagram'
 */

const crypto = require('crypto');
const router = require('express').Router();
const { requireAuth } = require('../auth');
const {
  saveTokens,
  loadTokens,
  deleteTokens,
  listConnectedPlatforms,
} = require('../services/token_store');

const ADAPTERS = {
  youtube: require('../publish/adapters/youtube'),
  tiktok: require('../publish/adapters/tiktok'),
  instagram: require('../publish/adapters/instagram'),
};

// PKCE verifiers stored in memory per state token (short-lived, same process)
const _pkceStore = new Map();

function getRedirectUri(platform, req) {
  const base = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/social/callback/${platform}`;
}

// GET /social/connect/:platform
// Redirects the customer to the platform OAuth screen.
router.get('/social/connect/:platform', requireAuth, (req, res) => {
  const { platform } = req.params;
  const adapter = ADAPTERS[platform];
  if (!adapter) return res.status(400).json({ error: `Unknown platform: ${platform}` });

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(platform, req);

  let authUrl;
  if (platform === 'tiktok') {
    // PKCE for TikTok
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    _pkceStore.set(state, { verifier, customerId: req.auth?.userId, platform });
    setTimeout(() => _pkceStore.delete(state), 10 * 60 * 1000); // expire in 10 min
    authUrl = adapter.buildAuthUrl(redirectUri, state, challenge);
  } else {
    _pkceStore.set(state, { customerId: req.auth?.userId, platform });
    setTimeout(() => _pkceStore.delete(state), 10 * 60 * 1000);
    authUrl = adapter.buildAuthUrl(redirectUri, state);
  }

  res.redirect(authUrl);
});

// GET /social/callback/:platform
// OAuth callback. Exchanges code for tokens and saves them.
router.get('/social/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL || ''}/dashboard/settings?social_error=${oauthError}&platform=${platform}`
    );
  }

  const stateData = _pkceStore.get(state);
  _pkceStore.delete(state);

  if (!stateData) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state. Please try again.' });
  }

  const adapter = ADAPTERS[platform];
  if (!adapter) return res.status(400).json({ error: `Unknown platform: ${platform}` });

  const redirectUri = getRedirectUri(platform, req);

  try {
    let tokenData;
    if (platform === 'tiktok') {
      tokenData = await adapter.exchangeCode(code, redirectUri, stateData.verifier);
    } else {
      tokenData = await adapter.exchangeCode(code, redirectUri);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn = tokenData.expires_in || null;
    const tokenExpiry = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    // Get platform account info
    let platformUserId = null;
    let platformHandle = null;
    try {
      let info;
      if (platform === 'youtube') info = await adapter.getChannelInfo(accessToken);
      if (platform === 'tiktok') info = await adapter.getCreatorInfo(accessToken);
      if (platform === 'instagram') info = await adapter.getAccountInfo(accessToken);
      if (info) {
        platformUserId = info.platformUserId;
        platformHandle = info.platformHandle;
      }
    } catch (_e) {
      /* non-fatal — save tokens anyway */
    }

    await saveTokens({
      customerId: stateData.customerId,
      platform,
      accessToken,
      refreshToken,
      tokenExpiry,
      scope: tokenData.scope || null,
      platformUserId,
      platformHandle,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    res.redirect(`${appUrl}/dashboard/settings?social_connected=${platform}`);
  } catch (err) {
    console.error(`[social-connect] ${platform} callback error:`, err.message);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    res.redirect(
      `${appUrl}/dashboard/settings?social_error=${encodeURIComponent(err.message)}&platform=${platform}`
    );
  }
});

// GET /social/accounts
// Returns list of connected platforms for the authenticated customer.
router.get('/social/accounts', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId;
    const accounts = await listConnectedPlatforms(customerId);
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /social/accounts/:platform
// Disconnect (remove stored tokens) for a platform.
router.delete('/social/accounts/:platform', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId;
    const { platform } = req.params;
    if (!ADAPTERS[platform])
      return res.status(400).json({ error: `Unknown platform: ${platform}` });
    await deleteTokens(customerId, platform);
    res.json({ ok: true, disconnected: platform });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
