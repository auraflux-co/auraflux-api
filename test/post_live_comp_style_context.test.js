'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCompStyleExamples,
  formatCompStylePromptBlock,
  clipDurationSec,
  sanitizeClip,
} = require('../lib/post_live/comp_style_context');

const mockJobs = {
  script_old: {
    clipsOnly: true,
    clipCompProfile: 'streamer',
    status: 'completed',
    stage: 'published',
    title: 'Clips Comp — Lacy, Adapt',
    createdAt: '2026-06-20T12:00:00.000Z',
    streamers: ['lacy', 'adapt'],
    clipHookTitles: ['First Scare', 'Chat Meltdown'],
    orderedClipUrls: [
      {
        displayName: 'Lacy',
        streamer: 'lacy',
        title: 'Jump scare reaction',
        trimStart: 200,
        trimEnd: 260,
        postLiveVod: true,
        pageUrl: 'https://www.youtube.com/watch?v=abc',
      },
      {
        displayName: 'Adapt',
        streamer: 'adapt',
        title: 'What just happened',
        pageUrl: 'https://www.twitch.tv/adapt/clip/FakeSlug-123',
      },
    ],
  },
  script_dismissed: {
    clipsOnly: true,
    status: 'dismissed',
    title: 'Bad comp',
    orderedClipUrls: [{ title: 'skip me', streamer: 'x' }],
  },
};

test('clipDurationSec uses trim window', () => {
  assert.equal(clipDurationSec({ trimStart: 200, trimEnd: 260 }), 60);
  assert.equal(clipDurationSec({ trimStart: 10 }), null);
});

test('buildCompStyleExamples prioritizes matching streamer and skips dismissed when better exists', () => {
  const ctx = buildCompStyleExamples({ streamer: 'lacy', jobs: mockJobs, limitComps: 3 });
  assert.equal(ctx.examples.length, 1);
  assert.equal(ctx.examples[0].clips[0].streamer, 'Lacy');
  assert.equal(ctx.examples[0].clips[0].vodTimestamp, '3:20');
  assert.equal(ctx.stats.preferredClipDurationSec, 60);
});

test('formatCompStylePromptBlock includes comp titles and hooks', () => {
  const ctx = buildCompStyleExamples({ streamer: 'lacy', jobs: mockJobs });
  const block = formatCompStylePromptBlock(ctx);
  assert.match(block, /Jump scare reaction/);
  assert.match(block, /First Scare/);
  assert.match(block, /Target window length: ~60s/);
});

test('sanitizeClip strips long titles', () => {
  const clip = sanitizeClip({ title: 'x'.repeat(200), streamer: 'lacy' }, 'Hook', 0);
  assert.equal(clip.title.length, 100);
  assert.equal(clip.hook, 'Hook');
});
