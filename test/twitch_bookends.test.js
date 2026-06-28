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

  it('probeMp4DecodeIntegrity flags non-monotonic DTS on r13 master', async () => {
    const path = require('path');
    const fs = require('fs');
    const r13 = path.join(__dirname, '..', 'output', 'twitch_soup_jason_s_spelling_bee_world_c_8clips_script_twitch_1782513992551.mp4');
    if (!fs.existsSync(r13)) return;
    const { probeMp4DecodeIntegrity } = require('../lib/ffmpeg_utils');
    const r = await probeMp4DecodeIntegrity(r13);
    // r13 may be pre-fix (493s with bad splice) or post-r14 (445s clean) — only assert when known-bad size
    const stat = fs.statSync(r13);
    if (stat.size > 300_000_000) {
      assert.equal(r.ok, false, 'expected DTS failure on old credits-spliced master');
    }
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

  it('buildTwitchSoupPostAssemblyRundown emits timestamp timeline', async () => {
    const {
      buildTwitchSoupPostAssemblyRundown,
      formatTimestampSec,
    } = require('../lib/twitch_bookends');
    assert.equal(formatTimestampSec(125), '2:05');
    const r = await buildTwitchSoupPostAssemblyRundown({
      asmId: 'asm_test',
      jobId: 'script_twitch_test',
      card: { thumbnailDriveUrl: 'https://x' },
      segsToProcess: [
        { label: 'INTRO', type: 'avatar' },
        { label: 'LACY_REACTION_LAUGHTER', type: 'studio_laughter', holdFromLabel: 'LACY_REACTION' },
      ],
      segmentDurations: [12, 4.5],
      coldOpenSec: 18,
      bodySecBeforeCredits: 34.5,
      creditsSec: 12,
      verifyResult: { ok: true, decodeOk: true, creditsAppended: true },
    });
    assert.equal(r.entries[0].feature, 'cold_open');
    assert.equal(r.entries[0].timestamp, '0:00');
    assert.equal(r.entries[1].feature, 'bobby_intro');
    assert.equal(r.entries[1].timestamp, '0:18');
    assert.ok(r.qaFeatures.some((f) => f.feature === 'studio_laugh' && f.status === 'pass'));
    assert.equal(r.totalDurationSec, 46.5);
  });
});
