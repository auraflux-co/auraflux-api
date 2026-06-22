'use strict';
/**
 * lib/routes/channel_connect.js — OAuth connect for SOURCE channel platforms (CPD-353)
 *
 * GET    /channels/connect/:platform      → redirect to platform OAuth screen
 * GET    /channels/callback/:platform     → OAuth callback, save tokens, redirect to /settings/channels
 * GET    /channels/connections            → list connected source platforms for current customer
 * DELETE /channels/connections/:platform  → disconnect a source platform
 *
 * Supported platforms: 'kick'
 * Future: 'twitch' (needs TWITCH_CLIENT_SECRET), 'youtube_source' (reuse publish token)
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const router = require('express').Router();
const { requireAuth, _clerkVerifyOptions } = require('../auth');
const { verifyToken }    = require('@clerk/express');
const { saveTokens, deleteTokens, loadTokens } = require('../services/token_store');
const { query: dbQuery } = require('../db/postgres');
const kickOAuth          = require('../publish/adapters/kick_oauth');

const SOURCE_ADAPTERS = {
  kick: kickOAuth,
  // twitch: require('../publish/adapters/twitch_oauth'), // CPD-353b
};

// PKCE verifiers — memory + disk (/app/data) so callback survives brief restarts.
const _pkceStore = new Map();
const PKCE_DIR   = process.env.OAUTH_PKCE_DIR
  || path.join(process.env.DATA_DIR || '/app/data', 'oauth_pkce');
const PKCE_TTL_MS = 10 * 60 * 1000;

function savePkceState(state, data) {
  _pkceStore.set(state, data);
  try {
    fs.mkdirSync(PKCE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PKCE_DIR, `${state}.json`),
      JSON.stringify({ ...data, savedAt: Date.now() }),
    );
  } catch (err) {
    console.warn('[channel-connect] PKCE disk write failed (non-fatal):', err.message);
  }
  setTimeout(() => deletePkceState(state), PKCE_TTL_MS);
}

function loadPkceState(state) {
  const mem = _pkceStore.get(state);
  if (mem) return mem;
  try {
    const file = path.join(PKCE_DIR, `${state}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (data.savedAt || 0) > PKCE_TTL_MS) {
      fs.unlinkSync(file);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function deletePkceState(state) {
  _pkceStore.delete(state);
  try {
    fs.unlinkSync(path.join(PKCE_DIR, `${state}.json`));
  } catch { /* ignore */ }
}

function oauthPublicOrigin(req) {
  if (process.env.KICK_OAUTH_REDIRECT_URI) {
    try {
      const u = new URL(process.env.KICK_OAUTH_REDIRECT_URI);
      return `${u.protocol}//${u.host}`;
    } catch { /* fall through */ }
  }
  if (process.env.API_BASE_URL) {
    return String(process.env.API_BASE_URL).replace(/\/$/, '');
  }
  const proto = req.get('x-forwarded-proto')
    || (process.env.RENDER ? 'https' : null)
    || req.protocol
    || 'https';
  return `${proto}://${req.get('host')}`;
}

function getRedirectUri(platform, req) {
  if (platform === 'kick' && process.env.KICK_OAUTH_REDIRECT_URI) {
    return String(process.env.KICK_OAUTH_REDIRECT_URI).replace(/\/$/, '');
  }
  const base = oauthPublicOrigin(req);
  return `${base}/channels/callback/${platform}`;
}

/**
 * Supports both session auth and ?token=<jwt> for browser-initiated OAuth redirects.
 * The browser navigates here directly (window.location.href) so no Authorization
 * header can be sent cross-origin.
 */
async function requireAuthOrQueryToken(req, res, next) {
  const queryToken = req.query.token;
  if (queryToken) {
    try {
      const opts = { ..._clerkVerifyOptions(), clockSkewInMs: 60000 };
      const payload = await verifyToken(queryToken, opts);
      if (!payload?.sub) throw new Error('no sub');
      req.user = { id: payload.sub };
      return next();
    } catch (err) {
      console.error('[channel-connect] token verify failed:', err?.message || err);
      return res.status(401).json({ ok: false, error: 'Unauthorized — session expired, please try connecting again' });
    }
  }
  return requireAuth(req, res, next);
}

// ── GET /channels/connect/:platform ─────────────────────────────────────────

router.get('/channels/connect/:platform', requireAuthOrQueryToken, async (req, res) => {
  const { platform } = req.params;
  const adapter = SOURCE_ADAPTERS[platform];
  if (!adapter) {
    return res.status(400).json({ error: `Unknown source platform: ${platform}. Supported: ${Object.keys(SOURCE_ADAPTERS).join(', ')}` });
  }

  const customerId  = req.auth?.userId || req.user?.id;
  const state       = crypto.randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(platform, req);

  const { url, verifier } = adapter.buildAuthUrl(redirectUri, state);

  savePkceState(state, { customerId, platform, verifier, redirectUri });

  console.log(`[channel-connect] ${platform} OAuth initiated for customer ${customerId} redirect_uri=${redirectUri}`);
  res.redirect(url);
});

// ── GET /channels/callback/:platform ────────────────────────────────────────

router.get('/channels/callback/:platform', async (req, res) => {
  const { platform }           = req.params;
  const { code, state, error: oauthError } = req.query;

  const appUrl      = process.env.NEXT_PUBLIC_APP_URL || '';
  const settingsUrl = `${appUrl}/settings/channels`;

  if (oauthError) {
    return res.redirect(
      `${settingsUrl}?channel_error=${encodeURIComponent(oauthError)}&platform=${platform}`
    );
  }

  const stateData = loadPkceState(state);
  deletePkceState(state);

  if (!stateData) {
    return res.redirect(
      `${settingsUrl}?channel_error=${encodeURIComponent('OAuth session expired — please try connecting again.')}&platform=${platform}`
    );
  }

  const adapter = SOURCE_ADAPTERS[platform];
  if (!adapter) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }

  const redirectUri = stateData.redirectUri || getRedirectUri(platform, req);
  const authCode = Array.isArray(code) ? code[0] : code;

  try {
    console.log(
      `[channel-connect] ${platform} callback exchange redirect_uri=${redirectUri} customer=${stateData.customerId}`,
    );
    const tokenData = await adapter.exchangeCode(authCode, redirectUri, stateData.verifier);

    const accessToken  = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const expiresIn    = tokenData.expires_in || null;
    const tokenExpiry  = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    let platformUserId = null;
    let platformHandle = null;
    try {
      const info = await adapter.getUserInfo(accessToken);
      platformUserId = info.platformUserId;
      platformHandle = info.platformHandle;
    } catch (_e) {
      console.warn(`[channel-connect] ${platform} getUserInfo failed (non-fatal):`, _e.message);
    }

    await saveTokens({
      customerId: stateData.customerId,
      platform,
      accessToken,
      refreshToken,
      tokenExpiry,
      scope:          tokenData.scope || null,
      platformUserId,
      platformHandle,
    });

    // Auto-populate source_channels with the connected handle so the source library
    // pre-fills without requiring the user to type their username separately.
    if (platformHandle) {
      const channelKeyMap = { kick: 'kickUsername', twitch: 'twitchLogin' };
      const channelKey    = channelKeyMap[platform] || `${platform}Username`;
      const cleanHandle   = platformHandle.replace(/^@/, '');
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

    console.log(
      `[channel-connect] ${platform} connected for ${stateData.customerId}` +
      (platformHandle ? ` — handle: ${platformHandle}` : '')
    );

    const successUrl = `${settingsUrl}?channel_connected=${platform}` +
      (platformHandle ? `&handle=${encodeURIComponent(platformHandle)}` : '');
    res.redirect(successUrl);
  } catch (err) {
    console.error(`[channel-connect] ${platform} callback error:`, err.message);
    res.redirect(
      `${settingsUrl}?channel_error=${encodeURIComponent(err.message)}&platform=${platform}`
    );
  }
});

// ── GET /channels/connections ────────────────────────────────────────────────

router.get('/channels/connections', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    if (!customerId) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const platforms  = Object.keys(SOURCE_ADAPTERS);
    const results = await Promise.all(
      platforms.map(async (p) => {
        const tokens = await loadTokens(customerId, null, p).catch(() => null);
        if (!tokens) return null;
        return {
          platform:       p,
          handle:         tokens.platformHandle,
          platformUserId: tokens.platformUserId,
          connectedAt:    tokens.updatedAt || tokens.connectedAt || null,
        };
      })
    );
    res.json({ ok: true, connections: results.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /channels/connections/:platform ───────────────────────────────────

router.delete('/channels/connections/:platform', requireAuth, async (req, res) => {
  try {
    const customerId = req.auth?.userId || req.user?.id;
    const { platform } = req.params;
    if (!SOURCE_ADAPTERS[platform]) {
      return res.status(400).json({ error: `Unknown platform: ${platform}` });
    }
    await deleteTokens(customerId, null, platform);
    console.log(`[channel-connect] ${platform} disconnected for ${customerId}`);
    res.json({ ok: true, disconnected: platform });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
