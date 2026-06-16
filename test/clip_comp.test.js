'use strict';

const {
  buildClipCompDesignSpec,
  resolveClipCompPublishContentType,
  resolveClipCompVoiceKey,
  resolveClipCompSourceContentType,
  applyClipCompProfileToJobSpec,
} = require('../lib/clip_comp');

describe('clip_comp (CPD-1042)', () => {
  test('clip comp design spec matches streamer comp profile', () => {
    const spec = buildClipCompDesignSpec({ clipCount: 4, sourceContentType: 'twitch-short' });
    expect(spec.chrome.layout).toBe('clip-comp');
    expect(spec.chrome.hasTopBar).toBe(false);
    expect(spec.chrome.logoPosition).toBe('top-blur-fold');
    expect(spec.chrome.resolvedContentType).toBe('clips');
    expect(spec.expectedClipCount).toBe(4);
    expect(spec.audio.avatarTrack).toBe(false);
    expect(spec.audio.sourceTrack).toBe(true);
  });

  test('sports clip comp uses sports voice key and branding', () => {
    const spec = buildClipCompDesignSpec({ clipCount: 4, sourceContentType: 'sports-short' });
    expect(resolveClipCompVoiceKey('sports-short')).toBe('sports');
    expect(spec.chrome.resolvedContentType).toBe('sports');
    expect(spec.chrome.skin).toBe('sports');
    expect(spec.voice.showName).toBeTruthy();
  });

  test('resolveClipCompSourceContentType from template name', () => {
    expect(resolveClipCompSourceContentType({ templateName: 'TikTok Clutch' })).toBe('twitch-short');
    expect(resolveClipCompSourceContentType({ templateName: 'Sports Punch' })).toBe('sports-short');
    expect(resolveClipCompSourceContentType({ contentType: 'sports-short' })).toBe('sports-short');
  });

  test('publish content type passes through job card type', () => {
    expect(resolveClipCompPublishContentType('sports-short')).toBe('sports-short');
    expect(resolveClipCompPublishContentType('news-short')).toBe('news-short');
    expect(resolveClipCompPublishContentType('twitch-short')).toBe('twitch-short');
  });

  test('applyClipCompProfileToJobSpec sets stageMap and privacy', () => {
    const spec = applyClipCompProfileToJobSpec(
      { order: { publish: { platforms: ['youtube'] } } },
      { customerId: 'c0', clipCount: 2, sourceContentType: 'sports-short' }
    );
    expect(spec.clipsOnly).toBe(true);
    expect(spec.stageMap.script.active).toBe(false);
    expect(spec.order.publish.privacyStatus).toBe('private');
    expect(spec.contentType).toBe('sports-short');
  });
});
