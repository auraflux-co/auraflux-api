/**
 * Live Grid — bench from Twitch followed channels (CPD-953)
 *
 * Rob's follows (user: playguitarsonline) ARE the bench list: follow a channel
 * on Twitch → it's bench-eligible on the next stream start.
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
const FOLLOWS_USER = process.env.TWITCH_FOLLOWS_USER || 'playguitarsonline';
// Helix /streams takes max 100 logins per query; roster eats 12 of them.
const BENCH_CAP = 88;

function loadUserToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (_) { return null; }
}

function saveUserToken({ accessToken, login, clientId }) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    access_token: accessToken,
    // Helix requires the Client-ID header to match the issuing client —
    // the localhost OAuth app differs from the production TWITCH_CLIENT_ID.
    client_id: clientId || null,
    login: login || null,
    obtained_at: new Date().toISOString(),
  }, null, 2));
}

/** All followed broadcaster logins for FOLLOWS_USER (paginated). Throws on auth failure. */
async function getFollowedLogins() {
  const stored = loadUserToken();
  if (!stored?.access_token) throw new Error('no Twitch user token — connect at /connect/twitch');
  const headers = {
    'Client-ID': stored.client_id || process.env.TWITCH_OAUTH_CLIENT_ID || process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${stored.access_token}`,
  };

  // Prefer the stored user id — survives a Twitch username rename. Resolve by
  // login only once, then persist the id back into the token file.
  let userId = stored.user_id;
  if (!userId) {
    const u = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(FOLLOWS_USER)}`, { headers });
    userId = u.data.data?.[0]?.id;
    if (!userId) throw new Error(`Twitch user ${FOLLOWS_USER} not found`);
    try { fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...stored, user_id: userId }, null, 2)); } catch (_) {}
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
}

/**
 * Followed channels as a bench list: minus roster/excluded, capped for Helix.
 * Returns null on any failure (fail-open).
 */
async function getFollowedBench({ roster = [], exclude = [] } = {}) {
  try {
    const skip = new Set([...roster, ...exclude].map(l => String(l).toLowerCase()));
    const bench = (await getFollowedLogins()).filter(l => !skip.has(l));
    if (bench.length > BENCH_CAP) bench.length = BENCH_CAP;
    return bench;
  } catch (e) {
    console.log(`[live-grid:follows] bench from follows unavailable: ${e.response?.data?.message || e.message}`);
    return null;
  }
}

module.exports = { getFollowedBench, getFollowedLogins, loadUserToken, saveUserToken, FOLLOWS_USER };
