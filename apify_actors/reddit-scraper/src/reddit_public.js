'use strict';
/**
 * reddit_public.js — Reddit public JSON fetcher.
 *
 * Reddit blocks unauthenticated JSON from datacenter IPs, so on the Apify
 * platform this runs through residential proxy (see main.js). The fetch layer
 * is injectable, so unit tests and proxy wiring stay independent.
 *
 * Output item shapes intentionally match the incumbent reddit actors
 * (type: 'post' | 'comment') so downstream consumers can switch actors
 * without changing their normalizers.
 */

const BASE = 'https://www.reddit.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIME_FILTERS = new Set(['hour', 'day', 'week', 'month', 'year', 'all']);
const SORTS = new Set(['top', 'new', 'hot', 'rising']);

function normalizeSubreddit(entry) {
  let s = String(entry || '').trim();
  if (!s) return null;
  const urlMatch = s.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i);
  if (urlMatch) s = urlMatch[1];
  s = s.replace(/^\/?r\//i, '');
  return /^[A-Za-z0-9_]{2,21}$/.test(s) ? s : null;
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Reddit HTTP ${res.status} for ${url.split('?')[0]}`);
  }
  return res.json();
}

/** Reddit listing post → store item (type: 'post'). */
function normalizePost(d) {
  if (!d || !d.id) return null;
  const permalink = d.permalink ? `${BASE}${d.permalink}` : null;
  const external = d.url && !/^https?:\/\/(www\.)?reddit\.com/i.test(d.url) ? d.url : '';
  return {
    type: 'post',
    id: d.id,
    subreddit: d.subreddit,
    title: d.title || '',
    selftext: d.selftext || '',
    url: permalink || d.url || '',
    externalUrl: external || undefined,
    domain: d.domain || undefined,
    score: d.score ?? 0,
    upvoteRatio: d.upvote_ratio ?? null,
    numComments: d.num_comments ?? 0,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
    isVideo: !!d.is_video,
    videoUrl: d.is_video && d.media && d.media.reddit_video
      ? String(d.media.reddit_video.fallback_url || '').split('?')[0] || undefined
      : undefined,
    thumbnail: d.thumbnail && String(d.thumbnail).startsWith('http') ? d.thumbnail : undefined,
    author: d.author || undefined,
    over18: !!d.over_18,
    stickied: !!d.stickied,
  };
}

function normalizeComment(d, depth = 0) {
  if (!d || !d.id || d.body == null) return null;
  if (d.body === '[removed]' || d.body === '[deleted]') return null;
  return {
    type: 'comment',
    id: d.id,
    postId: d.link_id ? String(d.link_id).replace(/^t3_/, '') : undefined,
    author: d.author,
    body: d.body,
    score: d.score ?? 0,
    depth,
    created: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
  };
}

function flattenComments(children, out = [], depth = 0) {
  for (const node of children || []) {
    if (!node || node.kind !== 't1') continue;
    const c = normalizeComment(node.data, depth);
    if (c) out.push(c);
    const replies = node.data && node.data.replies;
    if (replies && replies.data && replies.data.children) {
      flattenComments(replies.data.children, out, depth + 1);
    }
  }
  return out;
}

/**
 * Posts from one subreddit.
 * @param {string} subreddit
 * @param {{sort?: string, timeFilter?: string, limit?: number, fetchImpl?: Function}} opts
 */
async function fetchSubredditPosts(subreddit, opts = {}) {
  const sub = normalizeSubreddit(subreddit);
  if (!sub) throw new Error(`Invalid subreddit: ${subreddit}`);
  const sort = SORTS.has(opts.sort) ? opts.sort : 'top';
  const limit = Math.min(Math.max(1, opts.limit || 25), 100);

  const params = new URLSearchParams({ limit: String(limit), raw_json: '1' });
  if (sort === 'top') {
    const t = TIME_FILTERS.has(opts.timeFilter) ? opts.timeFilter : 'day';
    params.set('t', t);
  }
  const body = await getJson(`${BASE}/r/${sub}/${sort}.json?${params}`, opts);
  return ((body && body.data && body.data.children) || [])
    .filter((c) => c && c.kind === 't3')
    .map((c) => normalizePost(c.data))
    .filter(Boolean);
}

/**
 * One post + flattened comment tree from its permalink URL.
 * @param {string} postUrl — full reddit.com /comments/ permalink
 * @param {{maxComments?: number, fetchImpl?: Function}} opts
 */
async function fetchPostWithComments(postUrl, opts = {}) {
  const m = String(postUrl || '').match(/reddit\.com(\/r\/[^/]+\/comments\/[a-z0-9]+[^?#\s]*)/i);
  if (!m) throw new Error(`Not a reddit comments permalink: ${postUrl}`);
  const maxComments = Math.min(Math.max(1, opts.maxComments || 200), 500);

  const params = new URLSearchParams({
    limit: String(maxComments),
    sort: 'top',
    raw_json: '1',
  });
  const path = m[1].replace(/\/$/, '');
  const listings = await getJson(`${BASE}${path}.json?${params}`, opts);
  if (!Array.isArray(listings) || listings.length < 2) {
    throw new Error('Unexpected comments payload shape');
  }
  const postNode = listings[0]?.data?.children?.[0];
  const post = postNode && postNode.kind === 't3' ? normalizePost(postNode.data) : null;
  if (!post) throw new Error(`Post not found at ${postUrl}`);

  const comments = flattenComments(listings[1]?.data?.children)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxComments);
  return { post, comments };
}

module.exports = {
  fetchSubredditPosts,
  fetchPostWithComments,
  normalizeSubreddit,
  normalizePost,
  normalizeComment,
  flattenComments,
};
