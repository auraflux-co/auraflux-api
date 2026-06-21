'use strict';
/**
 * YouTube OAuth connect routes — shared by server.js and broadcast sidecar.
 */

function publicOrigin(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  }
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto')
    || (process.env.RENDER ? 'https' : null)
    || req.protocol
    || 'https';
  return `${proto}://${host}`;
}

function registerYoutubeConnectRoutes(app) {
  function ytRedirectUri(req) {
    return `${publicOrigin(req)}/connect/youtube/callback`;
  }

  function ytBackupRedirectUri(req) {
    return `${publicOrigin(req)}/connect/youtube/backup/callback`;
  }

  app.get('/connect/youtube', (req, res) => {
    if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) {
      return res.status(400).send('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not set');
    }
    const ytDirect = require('../services/youtube_direct');
    res.redirect(ytDirect.buildAuthUrl(ytRedirectUri(req), 'c0'));
  });

  app.get('/connect/youtube/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Google OAuth error: ${error}`);
    if (!code) return res.status(400).send('Missing authorization code');
    try {
      const ytDirect = require('../services/youtube_direct');
      const tokens = await ytDirect.exchangeCode(code, ytRedirectUri(req));
      if (!tokens.refresh_token) {
        return res.status(400).send('No refresh_token returned — revoke app access at myaccount.google.com/permissions and retry');
      }
      const stored = {
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
        scope: tokens.scope,
        connectedAt: new Date().toISOString(),
      };
      try {
        const info = await ytDirect.getChannelInfo(tokens.access_token);
        if (info) Object.assign(stored, info);
      } catch { /* channel info is cosmetic */ }
      ytDirect.saveTokens(stored);
      console.log(`[youtube_direct] Connected channel: ${stored.channelTitle || stored.channelId || 'unknown'}`);
      res.send(`<h2>✅ YouTube connected</h2><p>Channel: <b>${stored.channelTitle || stored.channelId || 'unknown'}</b></p>`);
    } catch (e) {
      console.error('[youtube_direct] OAuth exchange failed:', e.response?.data || e.message);
      res.status(500).send(`Token exchange failed: ${e.response?.data?.error_description || e.message}`);
    }
  });

  app.get('/connect/youtube/status', (req, res) => {
    const ytDirect = require('../services/youtube_direct');
    const t = ytDirect.loadTokens();
    res.json({
      connected: ytDirect.isConnected(),
      channelTitle: t?.channelTitle || null,
      channelId: t?.channelId || null,
      connectedAt: t?.connectedAt || null,
      directPublishEnabled: process.env.YOUTUBE_DIRECT_PUBLISH === 'true',
      backup: ytDirect.getYoutubeApiProfileStatus(),
    });
  });

  app.get('/connect/youtube/backup', (req, res) => {
    const ytDirect = require('../services/youtube_direct');
    const { getProfileConfig } = require('../services/youtube_api_profiles');
    const cfg = getProfileConfig('backup');
    if (!cfg.clientId || !cfg.clientSecret) {
      return res.status(400).send('YOUTUBE_BACKUP_CLIENT_ID / YOUTUBE_BACKUP_CLIENT_SECRET not set');
    }
    res.redirect(ytDirect.buildAuthUrlForProfile('backup', ytBackupRedirectUri(req), 'backup'));
  });

  app.get('/connect/youtube/backup/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Google OAuth error: ${error}`);
    if (!code) return res.status(400).send('Missing authorization code');
    try {
      const ytDirect = require('../services/youtube_direct');
      const { persistBackupRefreshToken } = require('./backup_youtube_connect');
      const tokens = await ytDirect.exchangeCodeForProfile('backup', code, ytBackupRedirectUri(req));
      if (!tokens.refresh_token) {
        return res.status(400).send('No refresh_token — revoke app at myaccount.google.com/permissions and retry');
      }
      const saved = await persistBackupRefreshToken(tokens.refresh_token);
      let channelLabel = 'ClipzWorld';
      try {
        const info = await ytDirect.getChannelInfo(tokens.access_token);
        if (info?.channelTitle) channelLabel = info.channelTitle;
      } catch { /* optional */ }
      console.log(`[youtube_direct] Backup API connected: ${channelLabel} (render=${saved.render} doppler=${saved.doppler})`);
      const notes = [];
      if (saved.render) notes.push('Render env updated');
      if (saved.doppler) notes.push('Doppler prd updated');
      if (!saved.render && !saved.doppler) {
        notes.push('Run: node scripts/pull_backup_youtube_refresh_to_doppler.js');
      }
      res.send(
        `<h2>✅ Backup YouTube API connected</h2>`
        + `<p>Channel: <b>${channelLabel}</b></p>`
        + `<p>${notes.join(' · ') || 'Ready'}</p>`
        + `<p>Primary quota 403 will auto-failover to this GCP project.</p>`,
      );
    } catch (e) {
      console.error('[youtube_direct] Backup OAuth failed:', e.response?.data || e.message);
      res.status(500).send(`Backup token exchange failed: ${e.response?.data?.error_description || e.message}`);
    }
  });
}

module.exports = { registerYoutubeConnectRoutes };
