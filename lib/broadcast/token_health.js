/**
 * OAuth / API credential health for Broadcast ops bar.
 */

const fs = require('fs');
const path = require('path');

const TWITCH_TOKEN_PATH = path.join(__dirname, '..', '..', 'data', 'twitch_user_token.json');
const YOUTUBE_TOKEN_PATH = path.join(__dirname, '..', '..', 'data', 'youtube_tokens.json');

function syncTokenHealth() {
  const out = {
    youtube: { ok: false, label: 'YouTube', detail: 'not connected' },
    twitchFollows: { ok: false, label: 'Twitch follows', detail: 'not connected' },
    uploadPost: { ok: false, label: 'Upload-Post', detail: 'missing key' },
    openai: { ok: false, label: 'OpenAI', detail: 'missing key' },
  };

  try {
    const yt = require('../services/youtube_direct');
    if (yt.isConnected()) {
      const t = yt.loadTokens();
      const profiles = yt.getYoutubeApiProfileStatus?.() || {};
      const backupNote = profiles.backup?.configured ? ' · backup API ready' : '';
      out.youtube = { ok: true, label: 'YouTube', detail: `${t?.channelTitle || t?.channelId || 'connected'}${backupNote}` };
    }
  } catch (_) {}

  try {
    const raw = JSON.parse(fs.readFileSync(TWITCH_TOKEN_PATH, 'utf8'));
    if (raw?.access_token) {
      const hasRefresh = !!raw.refresh_token;
      out.twitchFollows = {
        ok: true,
        label: 'Twitch follows',
        detail: hasRefresh ? (raw.login || 'token ok') : `${raw.login || 'token'} (no refresh — re-auth soon)`,
      };
      if (!hasRefresh) out.twitchFollows.ok = false;
    }
  } catch (_) {}

  if (process.env.UPLOADPOST_API_KEY && process.env.UPLOADPOST_PROFILE) {
    out.uploadPost = { ok: true, label: 'Upload-Post', detail: process.env.UPLOADPOST_PROFILE };
  }

  if (process.env.OPENAI_API_KEY) {
    out.openai = { ok: true, label: 'OpenAI', detail: 'key set' };
  }

  out.allOk = Object.values(out).filter((v) => v && typeof v.ok === 'boolean').every((v) => v.ok);
  return out;
}

/** Live API probe — use sparingly (Broadcast ops refresh). */
async function probeTokenHealth() {
  const sync = syncTokenHealth();
  const out = { ...sync, probedAt: new Date().toISOString() };

  if (sync.youtube.ok) {
    try {
      const yt = require('../services/youtube_direct');
      await yt.getAccessToken();
      out.youtube.detail = `${out.youtube.detail} · token refresh ok`;
    } catch (e) {
      out.youtube = { ok: false, label: 'YouTube', detail: `refresh failed: ${e.message}` };
    }
  }

  if (fs.existsSync(TWITCH_TOKEN_PATH)) {
    try {
      const { getFollowedLogins } = require('../live_grid/follows');
      const logins = await getFollowedLogins();
      out.twitchFollows = {
        ok: true,
        label: 'Twitch follows',
        detail: `${logins.length} follows`,
      };
    } catch (e) {
      out.twitchFollows = { ok: false, label: 'Twitch follows', detail: e.message };
    }
  }

  out.allOk = [out.youtube, out.twitchFollows, out.uploadPost, out.openai].every((v) => v.ok);
  return out;
}

module.exports = { syncTokenHealth, probeTokenHealth, TWITCH_TOKEN_PATH, YOUTUBE_TOKEN_PATH };
