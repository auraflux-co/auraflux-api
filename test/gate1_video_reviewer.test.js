'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  tryParseReviewerJson,
  contentTypeNeedsVideoReview,
  firstSourceUrl,
  cacheKeyForUrl,
  pruneStalePartFiles,
  cacheRootPath,
} = require('../lib/gates/gate1_video_reviewer');

describe('gate1_video_reviewer helpers', () => {
  test('tryParseReviewerJson parses fenced JSON', () => {
    const raw =
      'Here:\n```json\n{"fabricationFound":false,"examples":[],"observedSummary":"Raptors vs Cavs highlight"}\n```';
    const j = tryParseReviewerJson(raw);
    expect(j.fabricationFound).toBe(false);
    expect(j.observedSummary).toContain('Raptors');
  });

  test('contentTypeNeedsVideoReview', () => {
    expect(contentTypeNeedsVideoReview('nba')).toBe(true);
    expect(contentTypeNeedsVideoReview('news-short')).toBe(true);
    expect(contentTypeNeedsVideoReview('twitch')).toBe(false);
  });

  test('firstSourceUrl prefers gate0 confirmedSources', () => {
    const u = firstSourceUrl(
      { confirmedSources: [{ url: 'https://a.example/hls.m3u8' }] },
      { order: { inputs: { items: [{ url: 'https://b.example/x' }] } } }
    );
    expect(u).toContain('a.example');
  });

  test('cacheKeyForUrl is stable and differs by maxSecs', () => {
    const u = 'https://cdn.example/clip.m3u8';
    expect(cacheKeyForUrl(u, 90)).toBe(cacheKeyForUrl(u, 90));
    expect(cacheKeyForUrl(u, 90)).not.toBe(cacheKeyForUrl(u, 60));
  });
});

describe('pruneStalePartFiles', () => {
  let tmp;
  let prevPartAge;

  beforeEach(() => {
    prevPartAge = process.env.GATE1_VIDEO_CACHE_PART_MAX_AGE_MS;
    process.env.GATE1_VIDEO_CACHE_PART_MAX_AGE_MS = '2000';
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1b-cache-test-'));
  });

  afterEach(() => {
    if (prevPartAge === undefined) delete process.env.GATE1_VIDEO_CACHE_PART_MAX_AGE_MS;
    else process.env.GATE1_VIDEO_CACHE_PART_MAX_AGE_MS = prevPartAge;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_e) {
      /* ignore */
    }
  });

  test('removes stale .part_* files, keeps fresh', () => {
    const stale = path.join(tmp, 'deadbeef.mp4.part_1_1');
    const fresh = path.join(tmp, 'deadbeef.mp4.part_2_2');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'y');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(stale, old, old);
    pruneStalePartFiles(tmp);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  test('ignores non-.part_ files', () => {
    const keeper = path.join(tmp, 'full.mp4');
    fs.writeFileSync(keeper, 'z');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(keeper, old, old);
    pruneStalePartFiles(tmp);
    expect(fs.existsSync(keeper)).toBe(true);
  });
});

describe('cacheRootPath', () => {
  let prevDir;

  beforeEach(() => {
    prevDir = process.env.GATE1_VIDEO_CACHE_DIR;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.GATE1_VIDEO_CACHE_DIR;
    else process.env.GATE1_VIDEO_CACHE_DIR = prevDir;
  });

  test('uses GATE1_VIDEO_CACHE_DIR when set', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1b-root-'));
    try {
      process.env.GATE1_VIDEO_CACHE_DIR = t;
      expect(cacheRootPath()).toBe(path.resolve(t));
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});
