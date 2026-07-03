'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  fetchSubredditPosts,
  fetchPostWithComments,
  normalizeSubreddit,
  normalizePost,
  flattenComments,
} = require('../src/reddit_public');

function listingPost(over = {}) {
  return {
    kind: 't3',
    data: {
      id: 'abc123',
      subreddit: 'PublicFreakout',
      title: 'wild scene downtown',
      selftext: '',
      permalink: '/r/PublicFreakout/comments/abc123/wild_scene_downtown/',
      url: 'https://v.redd.it/xyz',
      domain: 'v.redd.it',
      score: 4200,
      upvote_ratio: 0.93,
      num_comments: 310,
      created_utc: 1780000000,
      is_video: true,
      media: { reddit_video: { fallback_url: 'https://v.redd.it/xyz/DASH_720.mp4?source=fallback' } },
      thumbnail: 'https://b.thumbs.redditmedia.com/x.jpg',
      author: 'someone',
      over_18: false,
      stickied: false,
      ...over,
    },
  };
}

function fakeFetch(payload) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

describe('normalizeSubreddit', () => {
  test('accepts name, r/ prefix, URL; rejects junk', () => {
    assert.equal(normalizeSubreddit('PublicFreakout'), 'PublicFreakout');
    assert.equal(normalizeSubreddit('r/videos'), 'videos');
    assert.equal(normalizeSubreddit('https://www.reddit.com/r/funny/top'), 'funny');
    assert.equal(normalizeSubreddit('bad sub!'), null);
    assert.equal(normalizeSubreddit(''), null);
  });
});

describe('fetchSubredditPosts', () => {
  test('normalizes listing posts with video fields', async () => {
    const impl = fakeFetch({ data: { children: [listingPost()] } });
    const posts = await fetchSubredditPosts('PublicFreakout', { fetchImpl: impl, limit: 5 });
    assert.equal(posts.length, 1);
    const p = posts[0];
    assert.equal(p.type, 'post');
    assert.equal(p.id, 'abc123');
    assert.equal(p.score, 4200);
    assert.equal(p.isVideo, true);
    assert.equal(p.videoUrl, 'https://v.redd.it/xyz/DASH_720.mp4');
    assert.equal(p.externalUrl, 'https://v.redd.it/xyz');
    assert.match(p.url, /^https:\/\/www\.reddit\.com\/r\/PublicFreakout\/comments/);
    assert.equal(p.created, new Date(1780000000 * 1000).toISOString());
  });

  test('top sort sends time filter; new sort does not', async () => {
    const impl = fakeFetch({ data: { children: [] } });
    await fetchSubredditPosts('videos', { fetchImpl: impl, sort: 'top', timeFilter: 'week' });
    assert.match(impl.calls[0], /\/r\/videos\/top\.json/);
    assert.match(impl.calls[0], /[?&]t=week/);
    await fetchSubredditPosts('videos', { fetchImpl: impl, sort: 'new' });
    assert.match(impl.calls[1], /\/r\/videos\/new\.json/);
    assert.doesNotMatch(impl.calls[1], /[?&]t=/);
  });

  test('invalid subreddit throws before network', async () => {
    const impl = fakeFetch({});
    await assert.rejects(fetchSubredditPosts('no way', { fetchImpl: impl }), /Invalid subreddit/);
    assert.equal(impl.calls.length, 0);
  });

  test('HTTP error surfaces status', async () => {
    const impl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await assert.rejects(
      fetchSubredditPosts('videos', { fetchImpl: impl }),
      /HTTP 403/,
    );
  });
});

describe('fetchPostWithComments', () => {
  test('returns post + flattened sorted comments, drops removed', async () => {
    const payload = [
      { data: { children: [listingPost()] } },
      {
        data: {
          children: [
            { kind: 't1', data: { id: 'c1', author: 'a', body: 'top comment', score: 900, created_utc: 1780000100, replies: { data: { children: [
              { kind: 't1', data: { id: 'c2', author: 'b', body: 'nested reply', score: 50, created_utc: 1780000200 } },
            ] } } } },
            { kind: 't1', data: { id: 'c3', author: 'c', body: '[removed]', score: 10 } },
            { kind: 'more', data: { children: ['zzz'] } },
          ],
        },
      },
    ];
    const impl = fakeFetch(payload);
    const { post, comments } = await fetchPostWithComments(
      'https://www.reddit.com/r/PublicFreakout/comments/abc123/wild_scene_downtown/',
      { fetchImpl: impl },
    );
    assert.equal(post.id, 'abc123');
    assert.deepEqual(comments.map((c) => c.id), ['c1', 'c2']);
    assert.equal(comments[1].depth, 1);
    assert.match(impl.calls[0], /\/comments\/abc123\/wild_scene_downtown\.json/);
  });

  test('rejects non-permalink URLs', async () => {
    await assert.rejects(
      fetchPostWithComments('https://example.com/foo', { fetchImpl: fakeFetch([]) }),
      /Not a reddit comments permalink/,
    );
  });
});

describe('flattenComments edge cases', () => {
  test('handles empty and non-t1 nodes', () => {
    assert.deepEqual(flattenComments(null), []);
    assert.deepEqual(flattenComments([{ kind: 'more', data: {} }]), []);
  });
});

describe('normalizePost edge cases', () => {
  test('non-video external link post', () => {
    const p = normalizePost({
      id: 'x1', subreddit: 'videos', title: 't', permalink: '/r/videos/comments/x1/t/',
      url: 'https://youtube.com/watch?v=1', domain: 'youtube.com', score: 10,
      num_comments: 2, created_utc: 1780000000, is_video: false,
    });
    assert.equal(p.isVideo, false);
    assert.equal(p.videoUrl, undefined);
    assert.equal(p.externalUrl, 'https://youtube.com/watch?v=1');
  });
});
