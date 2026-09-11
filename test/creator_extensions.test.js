'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  detectSponsorMarkers,
  adjustBoundariesForSponsors,
  buildSponsorLowerThird,
} = require('../lib/services/sponsor_markers');
const { matchPlaylistStrategy } = require('../lib/services/playlist_strategy');
const { mergeBrandCreativeProfile } = require('../lib/services/brand_creative_profile');

test('detectSponsorMarkers finds timed phrase', () => {
  const markers = detectSponsorMarkers([
    { text: 'Hey folks welcome back', startSec: 0, endSec: 3 },
    { text: 'This video is sponsored by Acme', startSec: 40, endSec: 48 },
  ]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].startSec, 40);
  assert.match(markers[0].phrase, /sponsored by/i);
});

test('adjustBoundariesForSponsors trims before sponsor', () => {
  const out = adjustBoundariesForSponsors(30, 60, [
    { startSec: 45, endSec: 55, phrase: 'sponsored by', confidence: 0.9 },
  ]);
  assert.equal(out.adjusted, true);
  assert.ok(out.trimEnd < 45);
});

test('buildSponsorLowerThird', () => {
  const lt = buildSponsorLowerThird([
    { startSec: 10, endSec: 16, phrase: 'sponsored by', confidence: 0.9 },
  ], 'Acme');
  assert.ok(lt);
  assert.match(lt.text, /Acme/);
});

test('matchPlaylistStrategy by tag', () => {
  const m = matchPlaylistStrategy([
    { match: { tag: 'Gaming' }, destination: { platform: 'youtube', playlistId: 'PL1', playlistTitle: 'Best Gaming Shorts 2026' } },
  ], { tags: ['gaming', 'shorts'], platform: 'youtube' });
  assert.equal(m.matched, true);
  assert.equal(m.playlistId, 'PL1');
  assert.equal(m.badge, 'Auto-matched by strategy rule');
});

test('mergeBrandCreativeProfile applies caption and bed', () => {
  const out = mergeBrandCreativeProfile({}, {
    captionStyle: 'word_karaoke',
    audioBed: 'low_trap',
    colors: { primary: '#111' },
  });
  assert.equal(out.captions.style, 'word_karaoke');
  assert.equal(out.audio.musicBed, 'low_trap');
  assert.equal(out.look.brandColors.primary, '#111');
});
