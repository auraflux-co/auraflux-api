'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAuthoritativeClipCount,
  resolveUniformClipsPerStreamer,
  resolveRequestClipsPerStreamer,
} = require('../lib/clip_lineup');

test('resolveAuthoritativeClipCount prefers orderedClipUrls', () => {
  const items = [{ clips: [{}, {}, {}] }, { clips: [{}, {}] }];
  assert.equal(
    resolveAuthoritativeClipCount({
      orderedClipUrls: new Array(8).fill({ streamer: 'x' }),
      items,
    }),
    8
  );
});

test('resolveUniformClipsPerStreamer from even orderedClipUrls', () => {
  const urls = [
    { displayName: 'Cinna' }, { displayName: 'Cinna' },
    { displayName: 'Emiru' }, { displayName: 'Emiru' },
    { displayName: 'ExtraEmily' }, { displayName: 'ExtraEmily' },
    { displayName: 'Yonna' }, { displayName: 'Yonna' },
  ];
  assert.equal(resolveUniformClipsPerStreamer({ orderedClipUrls: urls, items: new Array(4).fill({}) }), 2);
});

test('resolveRequestClipsPerStreamer uses POST body then items', () => {
  assert.equal(resolveRequestClipsPerStreamer({ clipsPerStreamer: 2 }, []), 2);
  const items = [{ clips: [{}, {}], targetClipsPerStreamer: 2 }, { clips: [{}, {}] }];
  assert.equal(resolveRequestClipsPerStreamer({}, items), 2);
});

test('createJobSpec scaffold: 4 streamers × 2 clips = 8 expectedClipCount', () => {
  const { createJobSpec } = require('../lib/job_spec');
  const items = ['A', 'B', 'C', 'D'].map((name, i) => ({
    displayName: name,
    streamer: name,
    clips: [{ url: `https://twitch.tv/c${i}a` }, { url: `https://twitch.tv/c${i}b` }],
    targetClipsPerStreamer: 2,
  }));
  const spec = createJobSpec({
    customerId: 'c0',
    contentType: 'twitch',
    sourceType: 'url_list',
    items,
    clipsPerStreamer: 2,
  });
  assert.equal(spec.designSpec.sceneStructure.expectedClipCount, 8);
  assert.ok(spec.designSpec.sceneStructure.sceneHeaders.length >= 20);
});
