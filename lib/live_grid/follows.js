/**
 * Live Grid — bench from Twitch followed channels (CPD-953)
 *
 * Rob's Twitch follows ARE the bench list: follow a channel on Twitch →
 * bench-eligible on the next stream start. Lookup uses stored user_id so
 * a username rename (e.g. playguitarsonline → clipzworldnews) stays correct.
 *
 * /helix/channels/followed requires a USER OAuth token with user:read:follows
 * (the app token in TWITCH_TOKEN can't read follows). One-time connect at
 * GET /connect/twitch (implicit grant) stores the token in
 * data/twitch_user_token.json. Everything here fails open — no token / expired
 * token returns null and the caller falls back to LIVE_GRID_BENCH env.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKEN_PATH = path.join(__dirname, '..', '..', 'data', 'twitch_user_token.json');
const FOLLOWS_USER = process.env.TWITCH_FOLLOWS_USER || 'clipzworldnews';
// Helix /streams takes max 100 logins per query; roster eats 12 of them.
const BENCH_CAP = 88;

function loadUserToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (_) { return null; }
}

function saveUserToken({ accessToken, refreshToken, login, clientId, userId }) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  // Preserve the stored user_id across re-auths — it's the rename-proof key
  // for follows lookups; dropping it falls back to login resolution, which
  // breaks after a Twitch username rename.
  const prev = loadUserToken() || {};
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    access_token: accessToken,
    // Auth-code grant only (implicit grant has no refresh token). Twitch
    // rotates refresh tokens on use — always persist the newest one.
    refresh_token: refreshToken || prev.refresh_token || null,
    // Helix requires the Client-ID header to match the issuing client —
    // the localhost OAuth app differs from the production TWITCH_CLIENT_ID.
    client_id: clientId || null,
    login: login || null,
    user_id: userId || prev.user_id || null,
    obtained_at: new Date().toISOString(),
  }, null, 2));
}

/**
 * Mint a fresh access token from the stored refresh token (auth-code flow,
 * CPD-966). Persists the rotated refresh token. Returns the new token object,
 * or null if there is no refresh token / no client secret to refresh with.
 */
async function refreshUserToken() {
  const stored = loadUserToken();
  const clientSecret = process.env.TWITCH_OAUTH_CLIENT_SECRET;
  if (!stored?.refresh_token || !clientSecret) return null;
  const r = await axios.post('https://id.twitch.tv/oauth2/token', new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: stored.client_id || process.env.TWITCH_OAUTH_CLIENT_ID,
    client_secret: clientSecret,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  saveUserToken({
    accessToken: r.data.access_token,
    refreshToken: r.data.refresh_token,
    login: stored.login,
    clientId: stored.client_id,
    userId: stored.user_id,
  });
  console.log('[live-grid:follows] Twitch user token refreshed');
  return loadUserToken();
}

/** All followed broadcaster logins for FOLLOWS_USER (paginated). Throws on auth failure. */
async function getFollowedLogins(_retried = false) {
  const stored = loadUserToken();
  if (!stored?.access_token) throw new Error('no Twitch user token — connect at /connect/twitch');
  const headers = {
    'Client-ID': stored.client_id || process.env.TWITCH_OAUTH_CLIENT_ID || process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${stored.access_token}`,
  };

  // Expired access token → refresh once and retry (auth-code flow only).
  const withAuthRetry = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e.response?.status === 429) {
        console.log('[live-grid:follows] Twitch rate limited (429) — bench will use env/platform fallback');
        return null;
      }
      if (e.response?.status === 401 && !_retried && await refreshUserToken().catch(() => null)) {
        return getFollowedLogins(true);
      }
      throw e;
    }
  };
  const result = await withAuthRetry(async () => {
    // Prefer the stored user id — survives a Twitch username rename. Resolve by
    // login only once, then persist the id back into the token file.
    let userId = stored.user_id;
    if (!userId) {
      const u = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(FOLLOWS_USER)}`, { headers });
      userId = u.data.data?.[0]?.id;
      if (!userId) throw new Error(`Twitch user ${FOLLOWS_USER} not found`);
      try { fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...stored, user_id: userId, login: u.data.data[0].login }, null, 2)); } catch (_) {}
    } else if (stored.login !== FOLLOWS_USER) {
      // Keep token login in sync after a Twitch rename (user_id is the source of truth).
      try {
        const u = await axios.get(`https://api.twitch.tv/helix/users?id=${userId}`, { headers });
        const login = u.data.data?.[0]?.login;
        if (login && login !== stored.login) {
          fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...stored, login }, null, 2));
        }
      } catch (_) {}
    }

    const logins = [];
    let cursor = null;
    do {
      const r = await axios.get('https://api.twitch.tv/helix/channels/followed', {
        headers, params: { user_id: userId, first: 100, ...(cursor ? { after: cursor } : {}) },
      });
      logins.push(...(r.data.data || []).map(f => f.broadcaster_login.toLowerCase()));
      cursor = r.data.pagination?.cursor;
    } while (cursor);
    return logins;
  });
  if (result == null) return null;
  return result;
}

/**
 * All followed broadcaster logins (paginated, uncapped). Returns null on failure.
 */
async function getAllFollows() {
  try {
    return await getFollowedLogins();
  } catch (e) {
    console.log(`[live-grid:follows] all follows unavailable: ${e.response?.data?.message || e.message}`);
    return null;
  }
}

/**
 * Followed channels as a bench list: minus roster/excluded, capped for Helix.
 * Returns null on any failure (fail-open).
 */
async function getFollowedBench({ roster = [], exclude = [] } = {}) {
  try {
    const all = await getFollowedLogins();
    if (!all?.length) return null;
    const skip = new Set([...roster, ...exclude].map(l => String(l).toLowerCase()));
    const bench = all.filter(l => !skip.has(l));
    if (bench.length > BENCH_CAP) bench.length = BENCH_CAP;
    return bench;
  } catch (e) {
    console.log(`[live-grid:follows] bench from follows unavailable: ${e.response?.data?.message || e.message}`);
    return null;
  }
}

module.exports = {
  getFollowedBench, getAllFollows, getFollowedLogins,
  loadUserToken, saveUserToken, refreshUserToken, FOLLOWS_USER,
};
