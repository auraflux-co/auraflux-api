'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveClipChannelSeo,
  applyClipChannelSeoToLead,
} = require('../lib/clip_channel_seo');
const { buildClipCompSeoInput } = require('../lib/clip_comp_hooks');

test('Speedy Boykins is a clip channel — SEO subject is IShowSpeed', () => {
  const r = resolveClipChannelSeo({
    displayName: 'Speedy Boykins',
    streamer: 'speedyboykins7869',
  });
  assert.equal(r.isClipChannel, true);
  assert.equal(r.subjectName, 'IShowSpeed');
  assert.equal(r.sourceName, 'Speedy Boykins');
});

test('SpeedUniverse clip channel maps to IShowSpeed', () => {
  const r = resolveClipChannelSeo({ displayName: 'SpeedUniverse', streamer: 'speeduniverse' });
  assert.equal(r.isClipChannel, true);
  assert.equal(r.subjectName, 'IShowSpeed');
});

test('IShowSpeed official channel is not remapped', () => {
  const r = resolveClipChannelSeo({ displayName: 'IShowSpeed', streamer: 'ishowspeed' });
  assert.equal(r.isClipChannel, false);
  assert.equal(r.subjectName, 'IShowSpeed');
});

test('lead title Speedy Boykins… becomes IShowSpeed…', () => {
  const mapped = applyClipChannelSeoToLead({
    leadClipIndex: 0,
    leadStreamer: 'Speedy Boykins',
    leadTitleDraft: "Speedy Boykins's Spider-Man Fortnite",
    leadReason: 'Single-clip',
  }, { displayName: 'Speedy Boykins', streamer: 'speedyboykins7869' });
  assert.equal(mapped.leadStreamer, 'IShowSpeed');
  assert.match(mapped.leadTitleDraft, /^IShowSpeed/);
  assert.equal(mapped.sourceChannel, 'Speedy Boykins');
});

test('SEO brief tells GPT not to title Speedy Boykins', () => {
  const text = buildClipCompSeoInput({
    leadStreamer: 'IShowSpeed',
    sourceChannel: 'Speedy Boykins',
    leadTitleDraft: 'IShowSpeed Becomes Spider-Man On Fortnite',
    clipCount: 1,
    isComp: false,
    clips: [{
      index: 0,
      displayName: 'Speedy Boykins',
      streamer: 'speedyboykins7869',
      platformTitle: 'iShowSpeed Becomes Spider-Man On Fortnite',
      observation: 'Fortnite gameplay with Speed cam.',
      hook: 'Spider-Man in Fortnite',
    }],
  });
  assert.match(text, /IShowSpeed/);
  assert.match(text, /do NOT lead the YouTube title/i);
  assert.match(text, /Speedy Boykins/);
});
