'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClipCompDesignSpec,
  resolveClipCompPublishContentType,
  resolveClipCompVoiceKey,
} = require('../lib/clip_comp');

test('clip comp design spec matches streamer comp profile', () => {
  const spec = buildClipCompDesignSpec({ clipCount: 4, sourceContentType: 'twitch-short' });
  assert.equal(spec.chrome.layout, 'clip-comp');
  assert.equal(spec.chrome.hasTopBar, false);
  assert.equal(spec.chrome.hasFlag, false);
  assert.equal(spec.chrome.hasSidebar, false);
  assert.equal(spec.chrome.hasTicker, false);
  assert.equal(spec.chrome.hasLogo, true);
  assert.equal(spec.chrome.logoPosition, 'top-blur-fold');
  assert.equal(spec.chrome.resolvedContentType, 'clips');
  assert.equal(spec.expectedClipCount, 4);
  assert.equal(spec.sceneStructure.expectedClipCount, 4);
  assert.equal(spec.sceneStructure.sceneHeaders.length, 4);
  assert.equal(spec.audio.avatarTrack, false);
  assert.equal(spec.audio.sourceTrack, true);
});

test('sports clip comp uses sports voice key and show branding', () => {
  const spec = buildClipCompDesignSpec({ clipCount: 4, sourceContentType: 'sports-short' });
  assert.equal(resolveClipCompVoiceKey('sports-short'), 'sports');
  assert.equal(spec.chrome.resolvedContentType, 'sports');
  assert.equal(spec.chrome.skin, 'sports');
  assert.ok(spec.voice.showName);
  assert.ok(!/\.html/i.test(spec.voice.showName));
});

test('sports clip comp includes clip-comp hook caption config', () => {
  const spec = buildClipCompDesignSpec({ clipCount: 2, sourceContentType: 'sports-short' });
  assert.equal(spec.chrome.caption.position, 'clip-comp-hook');
  assert.ok(spec.chrome.caption.colors.sports);
});

test('publish content type passes through job card type', () => {
  assert.equal(resolveClipCompPublishContentType('sports-short'), 'sports-short');
  assert.equal(resolveClipCompPublishContentType('news-short'), 'news-short');
  assert.equal(resolveClipCompPublishContentType('twitch-short'), 'twitch-short');
});

test('appendClipCompTitleSuffix adds " and more..." for multi-clip comps', () => {
  const { appendClipCompTitleSuffix } = require('../lib/clip_comp');
  assert.equal(
    appendClipCompTitleSuffix('ExtraEmily Wrong Shirt Gift #Shorts', { clipCount: 4 }),
    'ExtraEmily Wrong Shirt Gift and more... #Shorts',
  );
  assert.equal(
    appendClipCompTitleSuffix('Single Clip Moment #Shorts', { clipCount: 1 }),
    'Single Clip Moment #Shorts',
  );
  assert.equal(
    appendClipCompTitleSuffix('Already Has and more... #Shorts', { clipCount: 4 }),
    'Already Has and more... #Shorts',
  );
});
