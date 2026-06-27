'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeCreditsDurationSec,
  creditsTextFromCard,
} = require('../lib/twitch_bookends');

describe('twitch_bookends', () => {
  it('computeCreditsDurationSec scales with description length', () => {
    const short = computeCreditsDurationSec('Line one\nLine two', { minDurationSec: 12, maxDurationSec: 55 });
    assert.ok(short >= 12);

    const longDesc = Array.from({ length: 40 }, (_, i) => `Streamer beat ${i}: clip summary and link`).join('\n');
    const long = computeCreditsDurationSec(longDesc, { minDurationSec: 12, maxDurationSec: 55 });
    assert.ok(long > short);
    assert.ok(long <= 55);
  });

  it('creditsTextFromCard prefers youtube.description from publishCopy', () => {
    const card = {
      title: 'Fallback Title',
      streamers: [{ displayName: 'Lacy' }],
      publishCopy: {
        youtube: { description: 'YT DESC LINE 1\nCHAPTERS:\n0:00 Intro' },
      },
    };
    assert.equal(creditsTextFromCard(card), 'YT DESC LINE 1\nCHAPTERS:\n0:00 Intro');
  });

  it('creditsTextFromCard falls back when no publishCopy', () => {
    const card = {
      title: 'Twitch Soup',
      streamers: [{ displayName: 'Lacy' }, { displayName: 'Jason' }],
    };
    const text = creditsTextFromCard(card);
    assert.match(text, /Twitch Soup/);
    assert.match(text, /Featuring: Lacy, Jason/);
  });
});
