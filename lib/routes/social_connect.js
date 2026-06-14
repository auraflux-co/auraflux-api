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
const { requireAuth, _clerkVerifyOptions } = require('../auth');
const { verifyToken } = require('@clerk/express');
const { resolveBrandContext } = require('../auth/brand_access');
const {
  saveTokens,
  deleteTokens,
  deleteAllTokensForPlatform,
  listConnectedPlatforms,
  loadTokens,
} = require('../services/token_store');
const {
  generateConnectUrl,
  listUploadPostAccounts,
  disconnectPlatform: disconnectUploadPostPlatform,
} = require('../services/uploadpost_users');
const { createNotification } = require('../services/notifications');
const { query: dbQuery, getBrand } = require('../db/postgres');

// YouTube uses direct OAuth. TikTok + Instagram connect via Upload-Post white-label.
const DIRECT_OAUTH_PLATFORMS = new Set(['youtube']);

const ADAPTERS = {
  youtube: require('../publish/adapters/youtube'),
  tiktok: require('../publish/adapters/tiktok'),
  instagram: require('../publish/adapters/instagram'),
};

// PKCE verifiers stored in memory per state token (short-lived, same process)
const _pkceStore = new Map();

// Temporary session store for bulk-connect OAuth results (CPD-866).
// Keyed by a random session token; expires after 30 minutes.
const _bulkSessions = new Map();

function getRedirectUri(platform, req) {
  const base = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/social/callback/${platform}`;
}

// GET /social/connect/:platform
// Redirects the customer to the platform OAuth screen.
//
// Auth note: the browser navigates here directly (window.location.href) so no
// Authorization header can be sent cross-origin. The frontend appends the
// Clerk JWT as ?token=<jwt>. We verify it here and attach req.user before
// handing off to the normal OAuth redirect logic.
async function requireAuthOrQueryToken(req, res, next) {
  const queryToken = req.query.token;
  if (queryToken) {
    try {
      // clockSkewInMs allows a 60-second grace period for tokens that are
      // very freshly expired (e.g. popup loads slowly or clock drift).
      const opts = { ..._clerkVerifyOptions(), clockSkewInMs: 60000 };
      const payload = await verifyToken(queryToken, opts);
      if (!payload?.sub) throw new Error('no sub');
      req.user = {
        id:       payload.sub,
        role:     payload.metadata?.role || 'customer',
        planTier: payload.metadata?.planTier || 'operate',
        email:    payload.email || null,
      };
      return next();
    } catch (err) {
      console.error('[social-connect] token verify failed:', err?.message || err);
      return res.status(401).json({ ok: false, error: 'Unauthorized — session expired, please try connecting again' });
    }
  }
  // Fall back to normal session-based auth
  return requireAuth(req, res, next);
}

// GET /social/connect/youtube/bulk (CPD-866)
// Starts a YouTube OAuth that, after completion, lists ALL channels on the
// authenticated Google account and redirects to the bulk mapping UI instead
// of saving tokens for a single brand.
// Must be defined BEFORE the /:platform wildcard route.
router.get('/social/connect/youtube/bulk', requireAuthOrQueryToken, async (req, res) => {
  const customerId = req.auth?.userId || req.user?.id;
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = `${nonce}:bulk`;
  const redirectUri = getRedirectUri('youtube', req);

  _pkceStore.set(state, { customerId, platform: 'youtube', bulk: true });
  setTimeout(() => _pkceStore.delete(state), 10 * 60 * 1000);

  const authUrl = ADAPTERS['youtube'].buildAuthUrl(redirectUri, state);
  res.redirect(authUrl);
});

router.get('/social/connect/:platform', requireAuthOrQueryToken, resolveBrandContext, async (req, res) => {
  const { platform } = req.params;
  if (!ADAPTERS[platform]) return res.status(400).json({ error: `Unknown platform: ${platform}` });

  const customerId = req.auth?.userId || req.user?.id;
  // Accept brandId from query param (for browser automation) or header (from brand context middleware)
  const brandId = req.query.brandId || req.brandId;

  // ── TikTok / Instagram: use Upload-Post white-label connect ───────────────
  if (!DIRECT_OAUTH_PLATFORMS.has(platform)) {
    if (!brandId) {
      return res.status(400).json({ error: 'Brand context required to connect social accounts' });
    }
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.auraflux.co';
      const redirectUrl = `${appUrl}/settings/social?social_connected=${platform}`;
      // Each brand has its own Upload-Post profile (keyed by brandId).
      // Pass platforms: [platform] so the connect page shows only the requested
      // platform — lets users switch TikTok without touching Instagram and vice versa.
      const accessUrl = await generateConnectUrl(brandId, { redirectUrl, platforms: [platform] });
      return res.redirect(accessUrl);
    } catch (err) {
      console.error(`[social-connect] Upload-Post connect error for ${platform}:`, err.message);
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.auraflux.co';
      return res.redirect(
        `${appUrl}/settings/social?social_error=${encodeURIComponent(err.message)}&platform=${platform}`
      );
    }
  }

  // ── YouTube: direct OAuth ──────────────────────────────────────────────────
  const nonce = crypto.randomBytes(16).toString('hex');
  // State carries only the nonce — callback always returns to /settings/social
  // regardless of where the connect was initiated from.
  const source = 'settings';
  const state = `${nonce}:${source}`;
  const redirectUri = getRedirectUri(platform, req);

  _pkceStore.set(state, { customerId, brandId, platform });
  setTimeout(() => _pkceStore.delete(state), 10 * 60 * 1000);
  const authUrl = ADAPTERS[platform].buildAuthUrl(redirectUri, state);
  res.redirect(authUrl);
});

// GET /social/callback/:platform
// OAuth callback. Exchanges code for tokens and saves them.
router.get('/social/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, state, error: oauthError } = req.query;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.auraflux.co';
  const errorRedirectPath = '/settings/social';

  if (oauthError) {
    return res.redirect(
      `${appUrl}${errorRedirectPath}?social_error=${oauthError}&platform=${platform}`
    );
  }

  const stateData = _pkceStore.get(state);
  _pkceStore.delete(state);

  if (!stateData) {
    // State was lost (server restart / multi-instance). Redirect with error so
    // the popup surfaces a message instead of showing a blank JSON 400 page.
    return res.redirect(
      `${appUrl}${errorRedirectPath}?social_error=${encodeURIComponent('OAuth session expired — please close this window and try connecting again')}&platform=${platform}`
    );
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

    // ── Bulk connect (CPD-866): list all channels, store session, redirect to mapping UI ──
    if (stateData.bulk && platform === 'youtube') {
      let channels = [];
      try {
        channels = await adapter.listAllChannels(accessToken);
      } catch (_e) {
        console.warn('[social-connect] bulk: listAllChannels failed:', _e?.message);
      }
      const sessionToken = crypto.randomBytes(24).toString('hex');
      _bulkSessions.set(sessionToken, {
        customerId: stateData.customerId,
        platform,
        accessToken,
        refreshToken,
        tokenExpiry,
        scope:      tokenData.scope || null,
        channels,
        expiresAt:  Date.now() + 30 * 60 * 1000,
      });
      setTimeout(() => _bulkSessions.delete(sessionToken), 30 * 60 * 1000);
      return res.redirect(`${appUrl}/settings/social/bulk?session=${sessionToken}`);
    }

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
      console.warn(`[social-connect] ${platform} getChannelInfo failed:`, _e?.message || _e);
    }

    await saveTokens({
      customerId: stateData.customerId,
      brandId: stateData.brandId,
      platform,
      accessToken,
      refreshToken,
      tokenExpiry,
      scope: tokenData.scope || null,
      platformUserId,
      platformHandle,
    });

    // Auto-populate source_channels with the connected platform's handle so
    // users don't have to manually type their username in Settings → My Channels.
    if (platformHandle && (platform === 'youtube' || platform === 'tiktok')) {
      const channelKey = platform === 'youtube' ? 'youtubeHandle' : 'tiktokUsername';
      // Strip leading @ if present
      const cleanHandle = platformHandle.replace(/^@/, '');
      try {
        await dbQuery(
          `UPDATE client_plans
              SET source_channels = source_channels || $1::jsonb
            WHERE client_id = $2 AND active = TRUE`,
          [JSON.stringify({ [channelKey]: cleanHandle }), stateData.customerId]
        );
      } catch (_e) {
        // Non-fatal — token is saved; source_channels auto-fill is best-effort
      }
    }

    const PLATFORM_LABELS = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
    const platformLabel = PLATFORM_LABELS[platform] || (platform.charAt(0).toUpperCase() + platform.slice(1));
    createNotification(stateData.customerId, {
      type:      'platform_connected',
      title:     `${platformLabel} connected successfully`,
      body:      platformHandle ? `Account: ${platformHandle}` : null,
      actionUrl: '/settings/social',
    });

    // Always redirect to /settings/social — the brand that initiated the auth
    // lands back on their own social settings page.
    res.redirect(`${appUrl}/settings/social?social_connected=${platform}`);
  } catch (err) {
    console.error(`[social-connect] ${platform} callback error:`, err.message);
    res.redirect(
      `${appUrl}/settings/social?social_error=${encodeURIComponent(err.message)}&platform=${platform}`
    );
  }
});

// GET /social/accounts
// Returns list of connected platforms for the authenticated customer+brand.
// Merges direct OAuth tokens (YouTube) with Upload-Post profile accounts (TikTok, Instagram).
router.get('/social/accounts', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    
    const [directAccounts, uploadPostAccounts] = await Promise.all([
      listConnectedPlatforms(customerId, brandId),
      brandId
        ? listUploadPostAccounts(brandId).catch(() => [])
        : Promise.resolve([]),
    ]);

    // Merge: direct OAuth takes precedence if both sources have the same platform
    const seen = new Set(directAccounts.map((a) => a.platform));
    const merged = [
      ...directAccounts,
      ...uploadPostAccounts.filter((a) => !seen.has(a.platform)),
    ];

    res.json({ ok: true, accounts: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /social/accounts/:platform
// Disconnect (remove stored tokens) for a platform+brand.
// For Upload-Post managed platforms (tiktok, instagram), also calls the
// per-platform disconnect endpoint so the account is removed from the
// Upload-Post profile without affecting other connected platforms.
router.delete('/social/accounts/:platform', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    const { platform } = req.params;
    if (!ADAPTERS[platform])
      return res.status(400).json({ error: `Unknown platform: ${platform}` });

    // Always remove from our token_store
    await deleteTokens(customerId, brandId, platform);

    // For Upload-Post managed platforms, also remove from the brand's Upload-Post
    // profile using the per-platform endpoint so Instagram is not affected when
    // disconnecting TikTok (and vice versa).
    if (!DIRECT_OAUTH_PLATFORMS.has(platform) && brandId) {
      await disconnectUploadPostPlatform(brandId, platform).catch((err) => {
        console.warn(`[social-connect] Upload-Post platform disconnect failed (non-fatal):`, err?.message);
      });
    }

    res.json({ ok: true, disconnected: platform });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /social/webhooks/uploadpost
// Upload-Post sends social_account_disconnected events here when a user
// manually disconnects inside Upload-Post's hosted UI or TikTok/Instagram
// revokes access. We sync our token_store so the dashboard reflects reality.
//
// Verification: Upload-Post signs payloads with HMAC-SHA256 using
// UPLOADPOST_WEBHOOK_SECRET. We verify before acting.
router.post('/social/webhooks/uploadpost', async (req, res) => {
  try {
    const secret = process.env.UPLOADPOST_WEBHOOK_SECRET;
    if (secret) {
      const sig = req.headers['x-uploadpost-signature'] || '';
      const body = JSON.stringify(req.body);
      const expected = crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
      if (sig !== expected) {
        console.warn('[uploadpost-webhook] signature mismatch — ignoring');
        return res.status(401).json({ ok: false });
      }
    }

    const { event, username: customerId, platform, status } = req.body || {};

    if (event === 'social_account_disconnected' && customerId && platform) {
      console.log(`[uploadpost-webhook] ${platform} disconnected for ${customerId} (reason: ${req.body.reason || 'unknown'})`);
      try {
        // Delete tokens for all brands since webhook doesn't have brand context
        await deleteAllTokensForPlatform(customerId, platform);
      } catch (dbErr) {
        console.warn('[uploadpost-webhook] deleteAllTokensForPlatform failed (non-fatal):', dbErr?.message);
      }
    }

    res.json({ ok: true, received: event });
  } catch (err) {
    console.error('[uploadpost-webhook] error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// GET /social/bulk/session/:token (CPD-866)
// Returns the channel list + all brands for the authenticated owner account,
// so the frontend can render the channel→brand mapping table.
router.get('/social/bulk/session/:token', requireAuth, async (req, res) => {
  const session = _bulkSessions.get(req.params.token);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Bulk session not found or expired — please reconnect' });
  }
  const customerId = req.user?.id || req.auth?.userId;
  if (session.customerId !== customerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { getBrandsForAccount } = require('../db/postgres');
  const brands = await getBrandsForAccount(customerId);
  res.json({
    ok:       true,
    platform: session.platform,
    channels: session.channels,
    brands:   brands.map((b) => ({ id: b.id, name: b.name, is_primary: b.is_primary })),
  });
});

// POST /social/bulk/save (CPD-866)
// Receives [{channelId, channelHandle, brandId}] mappings and saves the OAuth
// token for each brand, scoped to the corresponding YouTube channel.
router.post('/social/bulk/save', requireAuth, async (req, res) => {
  const { sessionToken, mappings } = req.body || {};
  if (!sessionToken || !Array.isArray(mappings)) {
    return res.status(400).json({ error: 'sessionToken and mappings array are required' });
  }
  const session = _bulkSessions.get(sessionToken);
  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Bulk session not found or expired' });
  }
  const customerId = req.user?.id || req.auth?.userId;
  if (session.customerId !== customerId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const saved = [];
  for (const { channelId, channelHandle, brandId } of mappings) {
    if (!channelId || !brandId) continue;
    await saveTokens({
      customerId,
      brandId,
      platform:        session.platform,
      accessToken:     session.accessToken,
      refreshToken:    session.refreshToken,
      tokenExpiry:     session.tokenExpiry,
      scope:           session.scope,
      platformUserId:  channelId,
      platformHandle:  channelHandle || null,
    });
    saved.push({ channelId, brandId });
    console.log(`[social-bulk] saved youtube token for brand ${brandId} → channel ${channelHandle || channelId}`);
  }

  _bulkSessions.delete(sessionToken);
  createNotification(customerId, {
    type:      'platform_connected',
    title:     `YouTube connected to ${saved.length} brand${saved.length === 1 ? '' : 's'}`,
    body:      'Bulk channel mapping saved',
    actionUrl: '/settings/social',
  });
  res.json({ ok: true, saved });
});

// POST /social/youtube/backfill-channel (CPD-1027)
// Fills missing platform_user_id / platform_handle on stored YouTube tokens.
router.post('/social/youtube/backfill-channel', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.body?.brandId || req.brandId;
    if (!brandId) {
      return res.status(400).json({ ok: false, error: 'brandId required' });
    }

    const brand = await getBrand(brandId, customerId);
    if (!brand) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const { backfillYouTubeChannelMeta } = require('../services/youtube_channel_backfill');
    const result = await backfillYouTubeChannelMeta({
      customerId,
      brandId,
      brandName: brand.name,
      expectedHandle: req.body?.expectedHandle || null,
      channelId: req.body?.channelId || null,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[social-connect] youtube backfill error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /social/youtube/purge-by-title (CPD-1027)
// Deletes channel uploads whose title contains a substring (orphan cleanup).
router.post('/social/youtube/purge-by-title', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.body?.brandId || req.brandId;
    const titleContains = req.body?.titleContains;
    if (!brandId || !titleContains) {
      return res.status(400).json({ ok: false, error: 'brandId and titleContains required' });
    }

    const brand = await getBrand(brandId, customerId);
    if (!brand) return res.status(403).json({ ok: false, error: 'Forbidden' });

    const tokens = await loadTokens(customerId, brandId, 'youtube');
    if (!tokens?.platformUserId) {
      return res.status(400).json({ ok: false, error: 'YouTube channel not linked for this brand' });
    }

    const yt = require('../publish/adapters/youtube');
    const accessToken = await yt.ensureAccessToken(tokens, customerId, brandId);
    const uploads = await yt.listChannelUploads(accessToken, tokens.platformUserId);
    const targets = uploads.filter((u) => u.videoId && u.title.includes(titleContains));

    const deleted = [];
    const errors = [];
    for (const u of targets) {
      try {
        await yt.deleteVideo(accessToken, u.videoId);
        deleted.push({ videoId: u.videoId, title: u.title });
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        errors.push({ videoId: u.videoId, title: u.title, error: err.response?.data?.error?.message || err.message });
      }
    }

    res.json({ ok: true, deleted, errors, matched: targets.length });
  } catch (err) {
    console.error('[social-connect] youtube purge error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
