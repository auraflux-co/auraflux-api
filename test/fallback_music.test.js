'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  listFallbackTracks, pickFallbackTrack, fallbackMusicEnabled, DEFAULT_DIR,
} = require('../lib/live_grid/fallback_music');

describe('fallback_music', () => {
  it('lists ES tracks when assets dir exists', () => {
    const tracks = listFallbackTracks(DEFAULT_DIR);
    assert.ok(Array.isArray(tracks));
    if (tracks.length) {
      assert.match(path.basename(tracks[0]), /^ES_.+\.mp3$/i);
    }
  });

  it('pickFallbackTrack returns stable path from dir', () => {
    const tracks = listFallbackTracks(DEFAULT_DIR);
    if (!tracks.length) return;
    const a = pickFallbackTrack(DEFAULT_DIR);
    const b = pickFallbackTrack(DEFAULT_DIR);
    assert.ok(a);
    assert.ok(tracks.includes(a));
    assert.ok(tracks.includes(b));
  });

  it('fallbackMusicEnabled defaults on', () => {
    const prev = process.env.LIVE_GRID_FALLBACK_MUSIC;
    delete process.env.LIVE_GRID_FALLBACK_MUSIC;
    assert.equal(fallbackMusicEnabled(), true);
    process.env.LIVE_GRID_FALLBACK_MUSIC = 'off';
    assert.equal(fallbackMusicEnabled(), false);
    if (prev == null) delete process.env.LIVE_GRID_FALLBACK_MUSIC;
    else process.env.LIVE_GRID_FALLBACK_MUSIC = prev;
  });
});
