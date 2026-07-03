'use strict';
/**
 * twitch_gql.js — keyless Twitch clips fetcher over the public GraphQL endpoint.
 *
 * Uses the Twitch web client's public Client-Id, so no API key, OAuth app, or
 * login is required. Anonymous access serves up to ~100 clips per channel per
 * window; deeper cursor pagination is integrity-gated, so we cap at one page.
 */

const GQL_URL = 'https://gql.twitch.tv/gql';
// Public Client-Id shipped in Twitch's own web player — not a secret.
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const MAX_PAGE = 100;

const PERIODS = {
  '24h': 'LAST_DAY',
  '7d': 'LAST_WEEK',
  '30d': 'LAST_MONTH',
  all: 'ALL_TIME',
};

const SORTS = {
  views: 'VIEWS_DESC',
  recent: 'CREATED_AT_DESC',
  trending: 'TRENDING',
};

/** `https://www.twitch.tv/caseoh_/...` or `@caseoh_` or `caseoh_` → `caseoh_` */
function normalizeLogin(entry) {
  let s = String(entry || '').trim();
  if (!s) return null;
  const urlMatch = s.match(/twitch\.tv\/([A-Za-z0-9_]+)/i);
  if (urlMatch) s = urlMatch[1];
  s = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
}

async function gqlQuery(query, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const res = await fetchImpl(GQL_URL, {
    method: 'POST',
    headers: {
      'Client-Id': PUBLIC_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twitch GQL HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error(`Twitch GQL error: ${body.errors[0].message || 'unknown'}`);
  }
  return body.data;
}

function clipsQuery(login, { period, sort, first }) {
  // login is validated by normalizeLogin (alphanumeric + underscore only),
  // so string interpolation into the query is safe.
  return `query {
  user(login: "${login}") {
    id
    displayName
    followers { totalCount }
    clips(first: ${first}, criteria: {period: ${period}, sort: ${sort}}) {
      pageInfo { hasNextPage }
      edges {
        node {
          id slug title viewCount durationSeconds createdAt url thumbnailURL
          language isFeatured videoOffsetSeconds
          curator { login displayName }
          game { name displayName }
          broadcaster { id login displayName }
          video { id }
        }
      }
    }
  }
}`;
}

function normalizeClip(node, broadcasterMeta) {
  return {
    id: node.id,
    slug: node.slug,
    url: node.url || `https://www.twitch.tv/${broadcasterMeta.login}/clip/${node.slug}`,
    title: node.title || '',
    viewCount: node.viewCount ?? 0,
    durationSeconds: node.durationSeconds ?? 0,
    createdAt: node.createdAt || null,
    language: node.language || null,
    isFeatured: !!node.isFeatured,
    thumbnailUrl: node.thumbnailURL || null,
    game: node.game ? (node.game.displayName || node.game.name) : null,
    curator: node.curator ? (node.curator.displayName || node.curator.login) : null,
    broadcaster: {
      id: broadcasterMeta.id,
      login: broadcasterMeta.login,
      displayName: broadcasterMeta.displayName,
      followers: broadcasterMeta.followers,
    },
    sourceVodId: node.video ? node.video.id : null,
    vodOffsetSeconds: node.videoOffsetSeconds ?? null,
  };
}

/**
 * Fetch clips for one streamer.
 *
 * @param {string} streamer — login or channel URL
 * @param {object} opts
 * @param {'24h'|'7d'|'30d'|'all'} [opts.period='7d']
 * @param {'views'|'recent'|'trending'} [opts.sort='views']
 * @param {number} [opts.limit=25] — 1..100
 * @param {number} [opts.minDurationSeconds=0]
 * @param {number} [opts.maxDurationSeconds=0] — 0 = unlimited
 * @param {number} [opts.minViews=0]
 * @param {Function} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<{streamer: string, found: boolean, clips: object[]}>}
 */
async function fetchStreamerClips(streamer, opts = {}) {
  const login = normalizeLogin(streamer);
  if (!login) {
    return { streamer: String(streamer), found: false, error: 'invalid login', clips: [] };
  }

  const period = PERIODS[opts.period] || PERIODS['7d'];
  const sort = SORTS[opts.sort] || SORTS.views;
  const limit = Math.min(Math.max(1, opts.limit || 25), MAX_PAGE);
  // Over-fetch when duration/view filters are on so post-filter count still hits the limit.
  const hasFilters = !!(opts.minDurationSeconds || opts.maxDurationSeconds || opts.minViews);
  const first = hasFilters ? MAX_PAGE : limit;

  const data = await gqlQuery(clipsQuery(login, { period, sort, first }), opts);
  const user = data && data.user;
  if (!user) {
    return { streamer: login, found: false, error: 'channel not found', clips: [] };
  }

  const meta = {
    id: user.id,
    login,
    displayName: user.displayName || login,
    followers: user.followers ? user.followers.totalCount : null,
  };

  const minDur = opts.minDurationSeconds || 0;
  const maxDur = opts.maxDurationSeconds || 0;
  const minViews = opts.minViews || 0;

  const clips = ((user.clips && user.clips.edges) || [])
    .map((e) => e && e.node)
    .filter(Boolean)
    .map((n) => normalizeClip(n, meta))
    .filter((c) => c.durationSeconds >= minDur
      && (!maxDur || c.durationSeconds <= maxDur)
      && c.viewCount >= minViews)
    .slice(0, limit);

  return { streamer: login, found: true, clips };
}

module.exports = {
  fetchStreamerClips,
  normalizeLogin,
  normalizeClip,
  clipsQuery,
  PERIODS,
  SORTS,
  PUBLIC_CLIENT_ID,
  GQL_URL,
};
