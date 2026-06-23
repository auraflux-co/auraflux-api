'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLiveDescription,
  buildGridLiveDescription,
  buildYoutubeTags,
  appendChannelHashtag,
  fallbackSeo,
  displayName,
  AUDIO_INSTRUCTIONS,
} = require('../lib/live_grid/seo');

describe('live_grid seo', () => {
  test('chat announce lines fit YouTube 200-char cap', () => {
    for (const line of AUDIO_INSTRUCTIONS) {
      assert.ok(line.length <= 200);
    }
  });

  test('withLiveTitleDate inserts ET date after LIVE without duplicating', () => {
    const { withLiveTitleDate, liveTitleDateEt } = require('../lib/live_grid/seo');
    const when = new Date('2026-06-16T20:00:00Z');
    const stamp = liveTitleDateEt(when);
    const t = withLiveTitleDate('🔴 LIVE: Twitch Multiview Grid | Lacy, Emily', when);
    assert.match(t, new RegExp(`^🔴 LIVE: ${stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\|`));
    assert.equal(withLiveTitleDate(t, when), t);
  });

  test('withLiveTitleDate replaces stale GPT dates (e.g. Oct 5, 2023 Mario Kart)', () => {
    const { withLiveTitleDate, liveTitleDateEt } = require('../lib/live_grid/seo');
    const stamp = liveTitleDateEt(new Date('2026-06-16T20:00:00Z'));
    const t = withLiveTitleDate(
      '🔴 LIVE: Oct 5, 2023 | Mario Kart Party | Cinna, Jason',
      new Date('2026-06-16T20:00:00Z'),
    );
    assert.ok(t.includes(stamp));
    assert.ok(!t.includes('2023'));
    assert.ok(!/Mario Kart/i.test(t));
  });

  test('appendChannelHashtag skips channel hashtag by default', () => {
    const t = appendChannelHashtag('🔴 LIVE: Brazil vs Morocco | Watch Party');
    assert.ok(!t.includes('#ClipzWorldNews'));
    assert.ok(t.length <= 100);
  });

  test('appendChannelHashtag adds ClipzWorldNews when env on', () => {
    process.env.LIVE_GRID_TITLE_CHANNEL_HASHTAG = 'on';
    const t = appendChannelHashtag('🔴 LIVE: Brazil vs Morocco | Watch Party');
    assert.ok(t.includes('#ClipzWorldNews'));
    delete process.env.LIVE_GRID_TITLE_CHANNEL_HASHTAG;
  });

  test('buildGridLiveDescription lists quadrants with Twitch links', () => {
    const desc = buildGridLiveDescription({
      streamers: [
        { login: 'lacy', quadrant: 1 },
        { login: 'arky', quadrant: 2 },
        { login: 'clix', quadrant: 3 },
        { login: 'chosen_ow', quadrant: 4 },
      ],
    });
    assert.ok(desc.includes('Q1 — Lacy — https://www.twitch.tv/lacy'));
    assert.ok(desc.includes('Q4 — ChosenOw — https://www.twitch.tv/chosen_ow'));
    assert.ok(desc.includes('2×2 multiview'));
    assert.ok(desc.includes('!listen 1-4'));
    assert.ok(desc.includes('#ClipzWorldNews'));
    assert.ok(!desc.includes('\n\nTags:\n'));
  });

  test('buildYoutubeTags includes streamer names and discovery terms', () => {
    const tags = buildYoutubeTags(
      [{ login: 'lacy' }, { login: 'arky' }],
      { mode: 'grid' },
    );
    assert.ok(tags.includes('lacy'));
    assert.ok(tags.includes('arky'));
    assert.ok(tags.includes('twitch live'));
    assert.ok(tags.includes('twitch multistream'));
    const total = tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0) + 1, 0);
    assert.ok(total <= 450);
  });

  test('fallbackSeo grid mode uses rich description and tags', () => {
    const seo = fallbackSeo({
      programMode: 'grid',
      streamers: [{ login: 'lacy' }, { login: 'extraemily' }],
    });
    assert.match(seo.title, /^🔴 LIVE:/);
    assert.ok(seo.description.includes('ON SCREEN NOW'));
    assert.ok(seo.tags.includes('lacy'));
    assert.ok(seo.tags.includes('twitch live'));
    assert.equal(seo.thumbnailHeadline, 'Twitch Multiview');
  });

  test('buildLiveDescription includes member perks and streamers', () => {
    const desc = buildLiveDescription({
      hookLine: '⚽ LIVE NOW: Brazil vs Morocco',
      streamers: [{ login: 'lacy' }, { login: 'ishowspeed' }],
      hashtags: ['WorldCup', 'ClipzWorldNews'],
      skipTagLine: true,
    });
    assert.ok(desc.includes('!listen 1-4'));
    assert.ok(desc.includes('🔥 Lacy'));
    assert.ok(desc.includes('#ClipzWorldNews'));
    assert.ok(!desc.includes('Tags:'));
  });

  test('displayName formats logins', () => {
    assert.equal(displayName('ow_esports'), 'OwEsports');
    assert.equal(displayName('ishowspeed'), 'Ishowspeed');
  });
});
