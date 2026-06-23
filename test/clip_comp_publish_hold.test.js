'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClipCompDeliverySpec,
  clipCompUsesPostLivePublishHold,
  isClipCompPublishHeld,
  releaseClipCompPostLiveHold,
} = require('../lib/clip_comp');

test('news/sports clip comps use post_live publish hold in delivery spec', () => {
  const news = buildClipCompDeliverySpec({ platforms: ['youtube', 'tiktok'], contentType: 'news-short' });
  assert.equal(news.publishHold, 'post_live');
  assert.ok(news.publishHoldReason);

  const sports = buildClipCompDeliverySpec({ contentType: 'sports-short' });
  assert.equal(sports.publishHold, 'post_live');

  const twitch = buildClipCompDeliverySpec({ contentType: 'twitch-short' });
  assert.equal(twitch.publishHold, undefined);
});

test('clipCompUsesPostLivePublishHold identifies editorial types only', () => {
  assert.equal(clipCompUsesPostLivePublishHold('news-short'), true);
  assert.equal(clipCompUsesPostLivePublishHold('sports-short'), true);
  assert.equal(clipCompUsesPostLivePublishHold('twitch-short'), false);
});

test('isClipCompPublishHeld respects release flag', () => {
  const card = {
    contentType: 'news-short',
    deliverySpec: buildClipCompDeliverySpec({ contentType: 'news-short' }),
    publishHold: 'post_live',
  };
  assert.equal(isClipCompPublishHeld(card), true);
  releaseClipCompPostLiveHold(card);
  assert.equal(isClipCompPublishHeld(card), false);
  assert.equal(card.postLivePublishReleased, true);
  assert.equal(card.deliverySpec.publishHold, null);
});

test('twitch clip comp is not held by content type alone when hold cleared from spec', () => {
  const card = {
    contentType: 'twitch-short',
    deliverySpec: buildClipCompDeliverySpec({ contentType: 'twitch-short' }),
  };
  assert.equal(isClipCompPublishHeld(card), false);
});
