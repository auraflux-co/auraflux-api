'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  fetchStreamerClips,
  normalizeLogin,
  clipsQuery,
  PERIODS,
  SORTS,
} = require('../src/twitch_gql');

function fakeNode(over = {}) {
  return {
    id: '123',
    slug: 'FunnySlug-abc',
    title: 'big play',
    viewCount: 5000,
    durationSeconds: 20,
    createdAt: '2026-07-01T00:00:00Z',
    url: 'https://www.twitch.tv/somestreamer/clip/FunnySlug-abc',
    thumbnailURL: 'https://cdn/thumb.jpg',
    language: 'EN',
    isFeatured: false,
    videoOffsetSeconds: 100,
    curator: { login: 'cur', displayName: 'Cur' },
    game: { name: 'Just Chatting', displayName: 'Just Chatting' },
    broadcaster: { id: 'b1', login: 'somestreamer', displayName: 'SomeStreamer' },
    video: { id: 'v99' },
    ...over,
  };
}

function fakeFetch(userPayload) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({ data: { user: userPayload } }),
    };
  };
  impl.calls = calls;
  return impl;
}

function userWithClips(nodes) {
  return {
    id: 'b1',
    displayName: 'SomeStreamer',
    followers: { totalCount: 1000000 },
    clips: { pageInfo: { hasNextPage: false }, edges: nodes.map((n) => ({ node: n })) },
  };
}

describe('normalizeLogin', () => {
  test('accepts plain login, URL, @handle; rejects junk', () => {
    assert.equal(normalizeLogin('CaseOh_'), 'caseoh_');
    assert.equal(normalizeLogin('https://www.twitch.tv/jasontheween/videos'), 'jasontheween');
    assert.equal(normalizeLogin('@xqc'), 'xqc');
    assert.equal(normalizeLogin('bad name!'), null);
    assert.equal(normalizeLogin(''), null);
    assert.equal(normalizeLogin('ab'), null); // too short
  });
});

describe('clipsQuery', () => {
  test('maps period and sort enums', () => {
    const q = clipsQuery('xqc', { period: PERIODS['30d'], sort: SORTS.recent, first: 10 });
    assert.match(q, /period: LAST_MONTH/);
    assert.match(q, /sort: CREATED_AT_DESC/);
    assert.match(q, /first: 10/);
    assert.match(q, /user\(login: "xqc"\)/);
  });
});

describe('fetchStreamerClips', () => {
  test('normalizes clips with broadcaster meta', async () => {
    const impl = fakeFetch(userWithClips([fakeNode()]));
    const res = await fetchStreamerClips('SomeStreamer', { fetchImpl: impl });
    assert.equal(res.found, true);
    assert.equal(res.clips.length, 1);
    const c = res.clips[0];
    assert.equal(c.slug, 'FunnySlug-abc');
    assert.equal(c.viewCount, 5000);
    assert.equal(c.game, 'Just Chatting');
    assert.equal(c.curator, 'Cur');
    assert.equal(c.broadcaster.login, 'somestreamer');
    assert.equal(c.broadcaster.followers, 1000000);
    assert.equal(c.sourceVodId, 'v99');
    assert.equal(c.vodOffsetSeconds, 100);
  });

  test('applies duration and view filters then trims to limit', async () => {
    const nodes = [
      fakeNode({ id: '1', durationSeconds: 5, viewCount: 9000 }),
      fakeNode({ id: '2', durationSeconds: 20, viewCount: 8000 }),
      fakeNode({ id: '3', durationSeconds: 25, viewCount: 50 }),
      fakeNode({ id: '4', durationSeconds: 90, viewCount: 7000 }),
      fakeNode({ id: '5', durationSeconds: 30, viewCount: 6000 }),
    ];
    const impl = fakeFetch(userWithClips(nodes));
    const res = await fetchStreamerClips('somestreamer', {
      fetchImpl: impl,
      minDurationSeconds: 10,
      maxDurationSeconds: 60,
      minViews: 100,
      limit: 1,
    });
    assert.deepEqual(res.clips.map((c) => c.id), ['2']);
    // filters active → over-fetch a full page
    assert.match(impl.calls[0].body.query, /first: 100/);
  });

  test('unknown channel returns found=false', async () => {
    const impl = fakeFetch(null);
    const res = await fetchStreamerClips('nosuchchannel', { fetchImpl: impl });
    assert.equal(res.found, false);
    assert.equal(res.clips.length, 0);
  });

  test('invalid login short-circuits without a network call', async () => {
    const impl = fakeFetch(userWithClips([]));
    const res = await fetchStreamerClips('not a login!!', { fetchImpl: impl });
    assert.equal(res.found, false);
    assert.equal(impl.calls.length, 0);
  });

  test('GQL errors surface as thrown errors', async () => {
    const impl = async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: 'failed integrity check' }], data: { user: null } }),
    });
    await assert.rejects(
      fetchStreamerClips('somestreamer', { fetchImpl: impl }),
      /failed integrity check/,
    );
  });

  test('HTTP errors surface with status code', async () => {
    const impl = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
    await assert.rejects(
      fetchStreamerClips('somestreamer', { fetchImpl: impl }),
      /HTTP 503/,
    );
  });
});
