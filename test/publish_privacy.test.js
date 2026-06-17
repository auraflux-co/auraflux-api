'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveYouTubePrivacy, resolveTikTokPrivacy } = require('../lib/publish_privacy');
const { buildClipCompDeliverySpec, buildClipCompPublishOrder } = require('../lib/clip_comp');

describe('publish_privacy', () => {
  test('clip comp delivery spec is private', () => {
    const d = buildClipCompDeliverySpec({ platforms: ['youtube', 'tiktok'] });
    assert.equal(d.visibility, 'private');
    assert.equal(buildClipCompPublishOrder().privacyStatus, 'private');
  });

  test('sports-short always resolves YouTube private', () => {
    assert.equal(resolveYouTubePrivacy({ contentType: 'sports-short', clipsOnly: true }), 'private');
  });

  test('sports-short TikTok is SELF_ONLY draft', () => {
    assert.equal(resolveTikTokPrivacy({ contentType: 'sports-short', clipsOnly: true }), 'SELF_ONLY');
  });

  test('long-form respects deliverySpec when set public', () => {
    assert.equal(resolveYouTubePrivacy({
      contentType: 'news',
      deliverySpec: { visibility: 'public' },
      order: { publish: { privacyStatus: 'public' } },
    }), 'public');
  });
});
