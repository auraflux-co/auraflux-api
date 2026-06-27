'use strict';
/**
 * reddit_apify.js — Live Reddit data via Apify labrat011/reddit-scraper (CPD-1121)
 *
 * Primary live source when Reddit OAuth is unavailable. Uses residential proxies
 * on Apify infrastructure — not subject to PullPush archive lag.
 *
 * Actor: https://apify.com/labrat011/reddit-scraper
 * Modes: subreddit_posts (list), post_comments (lazy thread detail)
 *
 * Env: APIFY_API_TOKEN (shared with Kick Apify adapter)
 * Cost: ~$0.005/result PPE — ~$0.15–0.30/day for 2–3 subs + lazy comments
 */

const ACTOR_ID = 'labrat011~reddit-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_TIMEOUT_S = 90;
const MAX_RESULTS_CAP = 50;

/** Map dashboard window → Apify timeFilter (top sort only). */
function windowToTimeFilter(window) {
  const w = String(window || '24h').toLowerCase().replace(/\s+/g, '');
  if (w === 'all' || w === 'alltime' || w === 'any') return 'all';
  if (w === '7d' || w === 'week') return 'week';
  if (w === '30d' || w === 'month') return 'month';
  if (w === 'year' || w === '365d') return 'year';
  return 'day';
}

/**
 * Run actor synchronously; returns raw dataset items.
 * @private
 */
async function _runActor(input, { timeoutS = DEFAULT_TIMEOUT_S } = {}) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');

  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items`
    + `?token=${encodeURIComponent(token)}&timeout=${timeoutS}&memory=512`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout((timeoutS + 10) * 1000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify reddit-scraper ${res.status}: ${text.slice(0, 240)}`);
  }

  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error(`Apify reddit-scraper unexpected shape: ${JSON.stringify(items).slice(0, 200)}`);
  }
  if (!items.length) {
    throw new Error('Apify reddit-scraper returned 0 results');
  }
  return items;
}

/**
 * Map Apify post item → RedditClient internal post shape.
 * @private
 */
function _normalizePost(item) {
  if (!item || item.type !== 'post') return null;
  const external = item.externalUrl || '';
  const linkUrl = external || item.url || '';
  const isVideo = !!item.isVideo
    || /v\.redd\.it|reddit\.com\/video|streamable|youtube|youtu\.be|tiktok|vimeo/i.test(linkUrl)
    || /^v\.redd\.it/i.test(item.domain || '');
  const createdUtc = item.created
    ? Math.floor(new Date(item.created).getTime() / 1000)
    : null;

  return {
    id: item.id,
    name: `t3_${item.id}`,
    subreddit: item.subreddit,
    title: item.title || '',
    selftext: item.selftext || '',
    url: linkUrl,
    permalink: item.url && item.url.includes('reddit.com') ? item.url : null,
    score: item.score ?? 0,
    num_comments: item.numComments ?? 0,
    created_utc: createdUtc,
    is_video: isVideo,
    media: isVideo && /v\.redd\.it/i.test(linkUrl)
      ? { reddit_video: { fallback_url: linkUrl.split('?')[0] } }
      : undefined,
    thumbnail: item.thumbnail && String(item.thumbnail).startsWith('http') ? item.thumbnail : null,
    _source: 'apify',
  };
}

function _normalizeComment(item) {
  if (!item || item.type !== 'comment') return null;
  return {
    id: item.id,
    author: item.author,
    body: item.body,
    score: item.score ?? 0,
    depth: item.depth ?? 0,
    createdUtc: item.created
      ? Math.floor(new Date(item.created).getTime() / 1000)
      : null,
  };
}

/**
 * Top posts from one subreddit (live Reddit via Apify).
 *
 * @param {string} subreddit
 * @param {{ sort?: string, window?: string, limit?: number }} opts
 * @returns {Promise<object[]>}
 */
async function fetchSubredditPosts(subreddit, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit || 25), MAX_RESULTS_CAP);
  const sort = opts.sort === 'new' ? 'new' : 'top';
  const timeFilter = windowToTimeFilter(opts.window || opts.t || '24h');

  const items = await _runActor({
    mode: 'subreddit_posts',
    subreddits: [String(subreddit).replace(/^r\//i, '')],
    sort,
    timeFilter: sort === 'top' ? timeFilter : undefined,
    maxResults: Math.min(limit * 4, MAX_RESULTS_CAP),
    includeComments: false,
  });

  return items
    .filter((i) => i.type === 'post')
    .map(_normalizePost)
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * Post + comments for one thread (lazy load on operator click).
 *
 * @param {string} postId — Reddit post id (no t3_ prefix)
 * @param {{ postUrl?: string, limit?: number }} opts
 */
async function fetchPostWithComments(postId, opts = {}) {
  const id = String(postId).replace(/^t3_/, '');
  const postUrl = opts.postUrl
    || `https://www.reddit.com/comments/${id}/`;
  const maxComments = Math.min(Math.max(1, opts.limit || 200), 500);

  const items = await _runActor({
    mode: 'post_comments',
    postUrls: [postUrl],
    maxCommentsPerPost: maxComments,
  }, { timeoutS: 120 });

  let post = null;
  const comments = [];
  for (const item of items) {
    if (item.type === 'post' && !post) {
      post = _normalizePost(item);
    } else if (item.type === 'comment') {
      const c = _normalizeComment(item);
      if (c && c.body && c.body !== '[removed]' && c.body !== '[deleted]') {
        comments.push(c);
      }
    }
  }

  if (!post) {
    const postItems = items.filter((i) => i.type === 'post');
    post = postItems.length ? _normalizePost(postItems[0]) : null;
  }
  if (!post) throw new Error(`Post not found via Apify: ${id}`);

  comments.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { post, comments };
}

module.exports = {
  fetchSubredditPosts,
  fetchPostWithComments,
  windowToTimeFilter,
};
