'use strict';
/**
 * Reddit Data API client — ClipzWorld / C0 Reddit desk source.
 *
 * Auth (optional — PullPush read fallback when unset):
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
 *   REDDIT_REFRESH_TOKEN  — preferred (from one-time OAuth)
 *   REDDIT_USERNAME, REDDIT_PASSWORD — script-app fallback only
 *   REDDIT_USER_AGENT — required by Reddit ToS
 *   REDDIT_USE_PULLPUSH=1 — force PullPush archive
 *   REDDIT_SOURCE=apify|oauth|pullpush — override auto priority (CPD-1121)
 *   APIFY_API_TOKEN — live Reddit via labrat011/reddit-scraper when OAuth unavailable
 *
 * Source priority (when REDDIT_SOURCE unset): OAuth → Apify → PullPush
 */

const https = require('https');
const redditApify = require('./reddit_apify');

const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'oauth.reddit.com';
const PULLPUSH_BASE = 'https://api.pullpush.io/reddit/search';

/** Map dashboard window → Reddit OAuth `t` + PullPush cutoff seconds. */
function resolveRedditTimeWindow(window) {
  const w = String(window || '24h').toLowerCase().replace(/\s+/g, '');
  if (w === 'all' || w === 'alltime' || w === 'any') {
    return { window: 'all', t: 'all', windowSec: 0 };
  }
  if (w === '7d' || w === 'week') {
    return { window: '7d', t: 'week', windowSec: 604800 };
  }
  if (w === '30d' || w === 'month') {
    return { window: '30d', t: 'month', windowSec: 2592000 };
  }
  if (w === 'year' || w === '365d') {
    return { window: 'year', t: 'year', windowSec: 31536000 };
  }
  return { window: '24h', t: 'day', windowSec: 86400 };
}

class RedditClient {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.REDDIT_CLIENT_ID || '';
    this.clientSecret = options.clientSecret || process.env.REDDIT_CLIENT_SECRET || '';
    this.refreshToken = options.refreshToken || process.env.REDDIT_REFRESH_TOKEN || '';
    this.username = options.username || process.env.REDDIT_USERNAME || '';
    this.password = options.password || process.env.REDDIT_PASSWORD || '';
    this.userAgent = options.userAgent
      || process.env.REDDIT_USER_AGENT
      || 'ClipzWorldNews:c0-reddit-desk:v1.0 (by /u/rgreggs78)';
    this.dataSource = options.dataSource
      || (options.usePullpush === false ? 'oauth' : null)
      || RedditClient.resolveDataSource();
    this.usePullpush = this.dataSource === 'pullpush';

    this._accessToken = null;
    this._expiresAt = 0;
  }

  /** @returns {'oauth'|'apify'|'pullpush'} */
  static resolveDataSource() {
    const forcePullpush = process.env.REDDIT_USE_PULLPUSH === '1'
      || process.env.REDDIT_USE_PULLPUSH === 'true';
    if (forcePullpush) return 'pullpush';

    const forced = String(process.env.REDDIT_SOURCE || '').toLowerCase();
    if (forced === 'pullpush') return 'pullpush';
    if (forced === 'apify') {
      return process.env.APIFY_API_TOKEN ? 'apify' : 'pullpush';
    }

    const clientId = process.env.REDDIT_CLIENT_ID || '';
    const hasSecret = !!(process.env.REDDIT_CLIENT_SECRET || '');
    const hasRefresh = !!(process.env.REDDIT_REFRESH_TOKEN || '');
    const hasPassword = !!(process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD);
    const useOAuth = !!(clientId && hasSecret && (hasRefresh || hasPassword));
    if (useOAuth && forced !== 'apify') return 'oauth';

    if (process.env.APIFY_API_TOKEN) return 'apify';
    return 'pullpush';
  }

  _httpGetJson(url, { timeoutMs = 45000 } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || parsed.message || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`JSON parse failed: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('PullPush request timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async _pullpushGet(kind, query, { timeoutMs = 90000 } = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = `${PULLPUSH_BASE}/${kind}/?${qs}`;
    const body = await this._httpGetJson(url, { timeoutMs });
    return body.data || [];
  }

  _normalizePullpushSubmission(row) {
    if (!row) return null;
    const isVideo = !!row.is_video
      || /v\.redd\.it|reddit\.com\/video|streamable|youtube|youtu\.be|tiktok|vimeo/i.test(row.url || '');
    const videoUrl = row.is_video && row.media?.reddit_video?.fallback_url
      ? row.media.reddit_video.fallback_url.split('?')[0]
      : null;
    return {
      id: row.id,
      name: row.name || `t3_${row.id}`,
      subreddit: row.subreddit,
      title: row.title,
      selftext: row.selftext || '',
      url: row.url,
      permalink: row.permalink ? `https://www.reddit.com${row.permalink}` : null,
      score: row.score,
      num_comments: row.num_comments,
      created_utc: row.created_utc,
      is_video: isVideo,
      media: row.media,
      thumbnail: row.thumbnail,
      _source: 'pullpush',
    };
  }

  async _listSubredditPullpush(subreddit, { sort = 'top', t = 'day', limit = 25 } = {}) {
    const tw = resolveRedditTimeWindow(t === 'day' || t === 'week' || t === 'month' || t === 'all' ? ({
      day: '24h', week: '7d', month: '30d', all: 'all',
    }[t] || t) : t);
    const cutoff = tw.windowSec ? Math.floor(Date.now() / 1000) - tw.windowSec : 0;
    const fetchSize = cutoff
      ? Math.min(Math.max(limit * 2, 25), 40)
      : Math.min(Math.max(limit * 2, 25), 50);
    let rows = [];
    let archiveFallback = false;

    if (cutoff) {
      rows = await this._pullpushGet('submission', {
        subreddit,
        size: fetchSize,
        sort: 'desc',
        sort_type: 'created_utc',
        after: cutoff,
      });
    }
    if (!rows.length) {
      rows = await this._pullpushGet('submission', {
        subreddit,
        size: fetchSize,
        sort: 'desc',
        sort_type: sort === 'new' ? 'created_utc' : 'score',
      });
    }

    let filtered = cutoff
      ? rows.filter((r) => (r.created_utc || 0) >= cutoff)
      : rows;
    if (cutoff && filtered.length < limit && rows.length) {
      filtered = rows.slice(0, limit);
      archiveFallback = true;
    }
    return filtered.slice(0, limit).map((r) => {
      const norm = this._normalizePullpushSubmission(r);
      if (norm && archiveFallback) norm._archiveFallback = true;
      return norm;
    }).filter(Boolean);
  }

  async _listSubredditApify(subreddit, opts = {}) {
    const limit = opts.limit || 25;
    const window = opts.window || opts.t || '24h';
    return redditApify.fetchSubredditPosts(subreddit, {
      sort: opts.sort || 'top',
      window,
      limit,
    });
  }

  async _getPostApify(postId, opts = {}) {
    const { postUrl, permalink, limit = 200 } = opts;
    return redditApify.fetchPostWithComments(postId, {
      postUrl: postUrl || permalink,
      limit,
    });
  }

  async _getPostPullpush(postId) {
    const id = String(postId).replace(/^t3_/, '');
    const rows = await this._pullpushGet('submission', { ids: `t3_${id}`, size: 1 });
    const post = this._normalizePullpushSubmission(rows[0]);
    if (!post) throw new Error(`Post not found: ${id}`);
    const commentRows = await this._pullpushGet('comment', {
      link_id: `t3_${id}`,
      size: 200,
      sort: 'desc',
      sort_type: 'score',
    });
    const comments = (commentRows || [])
      .filter((c) => c.body && c.body !== '[removed]' && c.body !== '[deleted]')
      .map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        score: c.score,
        depth: c.depth || 0,
        createdUtc: c.created_utc,
      }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    return { post, comments };
  }

  _basicAuth() {
    return Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  _postForm(url, form, extraHeaders = {}) {
    const body = new URLSearchParams(form).toString();
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          Authorization: `Basic ${this._basicAuth()}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': this.userAgent,
          ...extraHeaders,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error || parsed.message || `HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Token parse failed: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async getAccessToken() {
    if (this._accessToken && Date.now() < this._expiresAt - 30_000) {
      return this._accessToken;
    }
    if (!this.clientId || !this.clientSecret) {
      throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET required');
    }

    let form;
    if (this.refreshToken) {
      form = { grant_type: 'refresh_token', refresh_token: this.refreshToken };
    } else if (this.username && this.password) {
      form = { grant_type: 'password', username: this.username, password: this.password };
    } else {
      throw new Error('Set REDDIT_REFRESH_TOKEN or REDDIT_USERNAME + REDDIT_PASSWORD');
    }

    const tok = await this._postForm(OAUTH_TOKEN_URL, form);
    if (!tok.access_token) throw new Error('No access_token in Reddit OAuth response');
    this._accessToken = tok.access_token;
    this._expiresAt = Date.now() + (Number(tok.expires_in) || 3600) * 1000;
    if (tok.refresh_token) this.refreshToken = tok.refresh_token;
    return this._accessToken;
  }

  async apiGet(path, query = {}) {
    const token = await this.getAccessToken();
    const qs = new URLSearchParams(query).toString();
    const fullPath = (path.startsWith('/') ? path : `/${path}`) + (qs ? `?${qs}` : '');

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: API_BASE,
        path: fullPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': this.userAgent,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data || '{}');
            if (res.statusCode >= 400) {
              reject(new Error(parsed.message || `HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`API parse failed: ${data.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** @returns {Promise<object[]>} raw listing children `.data` */
  async listSubreddit(subreddit, opts = {}) {
    const tw = resolveRedditTimeWindow(opts.window || opts.t || '24h');
    const t = tw.t;
    const limit = opts.limit || 25;
    if (this.dataSource === 'pullpush') {
      return this._listSubredditPullpush(subreddit, { ...opts, t: tw.window, limit });
    }
    if (this.dataSource === 'apify') {
      return this._listSubredditApify(subreddit, { ...opts, window: tw.window, limit });
    }
    const { sort = 'top' } = opts;
    const path = sort === 'hot'
      ? `/r/${subreddit}/hot`
      : `/r/${subreddit}/${sort}`;
    const query = { limit: Math.min(limit, 100), raw_json: 1 };
    if (sort === 'top') query.t = t;
    const listing = await this.apiGet(path, query);
    return (listing?.data?.children || []).map((c) => c.data).filter(Boolean);
  }

  /**
   * Post + comment tree. Returns { post, comments } (comments flattened separately).
   */
  async getPostWithComments(postId, opts = {}) {
    if (this.dataSource === 'pullpush') {
      return this._getPostPullpush(postId);
    }
    if (this.dataSource === 'apify') {
      return this._getPostApify(postId, opts);
    }
    const { sort = 'top', limit = 200, depth = 10 } = opts;
    const id = String(postId).replace(/^t3_/, '');
    const listings = await this.apiGet(`/comments/${id}`, {
      sort, limit, depth, raw_json: 1, threaded: true,
    });
    if (!Array.isArray(listings) || listings.length < 2) {
      throw new Error(`Unexpected comments response for ${id}`);
    }
    const post = listings[0]?.data?.children?.[0]?.data;
    const commentChildren = listings[1]?.data?.children || [];
    const comments = this.flattenComments(commentChildren);
    await this._expandMoreChildren(id, commentChildren, comments, sort);
    comments.sort((a, b) => (b.score || 0) - (a.score || 0));
    return { post, comments };
  }

  flattenComments(nodes, out = [], depth = 0) {
    for (const node of nodes || []) {
      if (!node || node.kind === 'more') continue;
      if (node.kind !== 't1') continue;
      const d = node.data;
      if (!d || d.body == null) continue;
      if (d.body === '[removed]' || d.body === '[deleted]') continue;
      out.push({
        id: d.id,
        author: d.author,
        body: d.body,
        score: d.score,
        depth,
        createdUtc: d.created_utc,
      });
      if (d.replies && d.replies.data && d.replies.data.children) {
        this.flattenComments(d.replies.data.children, out, depth + 1);
      }
    }
    return out;
  }

  async _expandMoreChildren(linkId, nodes, comments, sort) {
    const moreIds = [];
    const walk = (list) => {
      for (const node of list || []) {
        if (node?.kind === 'more' && node.data?.children) {
          moreIds.push(...node.data.children);
        }
        if (node?.data?.replies?.data?.children) walk(node.data.replies.data.children);
      }
    };
    walk(nodes);
    if (!moreIds.length) return;

    const fullname = linkId.startsWith('t3_') ? linkId : `t3_${linkId}`;
    for (let i = 0; i < moreIds.length; i += 100) {
      const batch = moreIds.slice(i, i + 100);
      const body = new URLSearchParams({
        api_type: 'json',
        link_id: fullname,
        children: batch.join(','),
        sort,
        limit_children: 'true',
      }).toString();
      const token = await this.getAccessToken();
      const chunk = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: API_BASE,
          path: '/api/morechildren',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': this.userAgent,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      const things = chunk?.json?.data?.things || [];
      for (const thing of things) {
        if (thing.kind !== 't1') continue;
        const d = thing.data;
        if (!d?.body || d.body === '[removed]') continue;
        comments.push({
          id: d.id,
          author: d.author,
          body: d.body,
          score: d.score,
          depth: d.depth || 0,
          createdUtc: d.created_utc,
        });
      }
    }
  }

  /** Normalize post for ClipzWorld source picker / script bundle */
  normalizePost(post) {
    if (!post) return null;
    const videoUrl = post.is_video
      ? post.media?.reddit_video?.fallback_url?.split('?')[0]
      : null;
    const url = post.url || '';
    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    const isStreamable = /streamable\.com/i.test(url);
    const isRedditHosted = /v\.redd\.it|reddit\.com\/video/i.test(url);
    const isVideo = !!post.is_video || isYoutube || isStreamable || isRedditHosted;
    return {
      id: post.id,
      subreddit: post.subreddit,
      title: post.title,
      selftext: post.selftext || '',
      url,
      permalink: post.permalink ? (post.permalink.startsWith('http') ? post.permalink : `https://www.reddit.com${post.permalink}`) : null,
      score: post.score,
      numComments: post.num_comments ?? post.numComments,
      createdUtc: post.created_utc ?? post.createdUtc,
      isVideo,
      isYoutube,
      isStreamable,
      videoUrl: videoUrl || (isVideo ? url : null),
      thumbnail: post.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : null,
      source: post._source || this.dataSource,
      archiveFallback: !!post._archiveFallback,
    };
  }

  filterVideoCandidates(posts, { minScore = 500 } = {}) {
    return posts
      .map((p) => this.normalizePost(p))
      .filter((p) => p && p.score >= minScore && p.isVideo);
  }

  /**
   * Exchange OAuth authorization code for access + refresh tokens (one-time setup).
   */
  async exchangeAuthorizationCode(code, redirectUri) {
    if (!this.clientId || !this.clientSecret) {
      throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET required');
    }
    const tok = await this._postForm(OAUTH_TOKEN_URL, {
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
    });
    if (!tok.access_token) throw new Error('No access_token in Reddit OAuth response');
    return tok;
  }

  /** Probe which backend is active and whether credentials are configured. */
  static configStatus() {
    const clientId = process.env.REDDIT_CLIENT_ID || '';
    const hasSecret = !!(process.env.REDDIT_CLIENT_SECRET || '');
    const hasRefresh = !!(process.env.REDDIT_REFRESH_TOKEN || '');
    const hasPassword = !!(process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD);
    const forcePullpush = process.env.REDDIT_USE_PULLPUSH === '1'
      || process.env.REDDIT_USE_PULLPUSH === 'true';
    const hasApify = !!process.env.APIFY_API_TOKEN;
    const mode = RedditClient.resolveDataSource();
    return {
      clientId: clientId ? `${clientId.slice(0, 6)}…` : null,
      hasSecret,
      hasRefresh,
      hasPassword,
      forcePullpush,
      hasApify,
      redditSource: process.env.REDDIT_SOURCE || null,
      mode,
      source: mode,
    };
  }

  /**
   * Bundle for script gen: post + top comments + video hint.
   */
  async buildPostBundle(postId, { commentLimit = 40, postUrl, permalink } = {}) {
    const { post, comments } = await this.getPostWithComments(postId, {
      commentLimit,
      limit: commentLimit,
      postUrl: postUrl || permalink,
      permalink: postUrl || permalink,
    });
    const normalized = this.normalizePost(post);
    return {
      ...normalized,
      topComments: comments.slice(0, commentLimit).map((c) => ({
        author: c.author,
        body: c.body,
        score: c.score,
        createdUtc: c.createdUtc ?? c.created_utc ?? null,
      })),
    };
  }
}

module.exports = RedditClient;
module.exports.resolveRedditTimeWindow = resolveRedditTimeWindow;
