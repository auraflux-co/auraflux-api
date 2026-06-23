'use strict';

const { isTrustedDownloadUrl } = require('../lib/downloader');

describe('isTrustedDownloadUrl — CPD-1014 Twitch/Kick page URLs', () => {
  test('allows Twitch clip page URLs', () => {
    expect(isTrustedDownloadUrl('https://clips.twitch.tv/AmbitiousGlutenFreeCarabeefPanicBasket-abc123')).toBe(true);
    expect(isTrustedDownloadUrl('https://www.twitch.tv/tenshi/clip/AmbitiousGlutenFreeCarabeefPanicBasket')).toBe(true);
  });

  test('allows Twitch Helix CDN URLs', () => {
    expect(
      isTrustedDownloadUrl(
        'https://static-cdn.jtvnw.net/twitch-video-assets/abc123/1234567890/abc123.mp4'
      )
    ).toBe(true);
    expect(
      isTrustedDownloadUrl(
        'https://clips-media-assets2.twitch.tv/abc123-1234567890-abc123.mp4'
      )
    ).toBe(true);
  });

  test('allows Kick clip page URLs', () => {
    expect(isTrustedDownloadUrl('https://kick.com/somechannel/clips/clip_01abc')).toBe(true);
  });

  test('blocks unknown hosts', () => {
    expect(isTrustedDownloadUrl('https://evil.example.com/video.mp4')).toBe(false);
  });
});
