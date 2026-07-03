'use strict';
/**
 * main.js — Reddit Scraper Actor entrypoint.
 *
 * Two modes (matching our internal reddit_apify.js contract, CPD-1225):
 *   subreddit_posts — top/new/hot posts across subreddits
 *   post_comments   — post + flattened comments for given permalink URLs
 *
 * Reddit 403s datacenter IPs, so all requests go through Apify residential
 * proxy when running on-platform. Locally (apify run) it uses your own IP.
 */

const { Actor, log } = require('apify');
const { gotScraping } = require('got-scraping');
const { fetchSubredditPosts, fetchPostWithComments } = require('./reddit_public');

const PER_REQUEST_DELAY_MS = 700;

/** fetch-compatible wrapper over got-scraping with Apify proxy. */
function makeFetch(proxyUrl) {
  return async (url, init = {}) => {
    const res = await gotScraping({
      url,
      method: 'GET',
      headers: init.headers,
      proxyUrl,
      timeout: { request: 45000 },
      responseType: 'text',
      throwHttpErrors: false,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => JSON.parse(res.body),
      text: async () => res.body,
    };
  };
}

async function run() {
  const input = (await Actor.getInput()) || {};
  const mode = input.mode === 'post_comments' ? 'post_comments' : 'subreddit_posts';

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
  }).catch(() => null);
  const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
  const fetchImpl = makeFetch(proxyUrl);
  if (!proxyUrl) log.warning('No Apify proxy available — using direct connection (fine locally, will 403 from datacenters).');

  let pushed = 0;
  const failures = [];

  if (mode === 'subreddit_posts') {
    const subreddits = Array.isArray(input.subreddits) ? input.subreddits : [];
    if (!subreddits.length) throw new Error('Input "subreddits" must be a non-empty array.');
    const maxResults = Math.min(Math.max(1, input.maxResults || 25), 100);

    for (const sub of subreddits) {
      try {
        const posts = await fetchSubredditPosts(sub, {
          sort: input.sort || 'top',
          timeFilter: input.timeFilter || 'day',
          limit: maxResults,
          fetchImpl,
        });
        if (posts.length) await Actor.pushData(posts);
        pushed += posts.length;
        log.info(`r/${sub}: ${posts.length} posts`);
      } catch (e) {
        log.warning(`r/${sub} failed: ${e.message}`);
        failures.push({ subreddit: String(sub), error: e.message });
      }
      if (subreddits.length > 1) await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
    }
  } else {
    const postUrls = Array.isArray(input.postUrls) ? input.postUrls : [];
    if (!postUrls.length) throw new Error('Input "postUrls" must be a non-empty array for post_comments mode.');
    const maxComments = Math.min(Math.max(1, input.maxCommentsPerPost || 200), 500);

    for (const url of postUrls) {
      try {
        const { post, comments } = await fetchPostWithComments(url, { maxComments, fetchImpl });
        await Actor.pushData([post, ...comments]);
        pushed += 1 + comments.length;
        log.info(`${url}: post + ${comments.length} comments`);
      } catch (e) {
        log.warning(`${url} failed: ${e.message}`);
        failures.push({ postUrl: String(url), error: e.message });
      }
      if (postUrls.length > 1) await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
    }
  }

  await Actor.setValue('RUN_SUMMARY', { mode, itemsPushed: pushed, failures });
  if (!pushed) {
    throw new Error(`No items scraped — all targets failed: ${JSON.stringify(failures).slice(0, 500)}`);
  }
  log.info(`Done — ${pushed} items (${failures.length} failures).`);
}

Actor.main(run);
