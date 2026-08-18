'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractClipIdFromUrl } = require('../lib/content_library/clip_ids');
const {
  needsYtdlpDownload,
  isYouTubeUrl,
  youtubeYtdlpExtraArgs,
  YOUTUBE_PLAYER_CLIENT_ARG,
} = require('../lib/content_library/media_download');

describe('clip id extraction (CPD-1230)', () => {
  it('parses YouTube watch, Shorts, and youtu.be URLs', () => {
    assert.equal(extractClipIdFromUrl('https://www.youtube.com/watch?v=lJcJefu9ceo'), 'lJcJefu9ceo');
    assert.equal(extractClipIdFromUrl('https://youtube.com/shorts/abc123XYZ'), 'abc123XYZ');
    assert.equal(extractClipIdFromUrl('https://youtu.be/abc123XYZ?t=4'), 'abc123XYZ');
  });

  it('parses Kick clip URLs', () => {
    assert.equal(extractClipIdFromUrl('https://kick.com/xqc/clips/clip-uuid-here'), 'clip-uuid-here');
  });

  it('still parses Twitch clip slugs', () => {
    assert.equal(extractClipIdFromUrl('https://clips.twitch.tv/FriendlyWanderingBear-Kl9abc'), 'FriendlyWanderingBear-Kl9abc');
  });
});

describe('media download routing', () => {
  it('routes YouTube page URLs through yt-dlp', () => {
    const url = 'https://www.youtube.com/watch?v=abc';
    assert.equal(isYouTubeUrl(url), true);
    assert.equal(needsYtdlpDownload({ mp4Url: url, quality: 'youtube-page-ytdlp' }), true);
  });

  it('uses ffmpeg copy for direct Twitch CDN URLs', () => {
    const cdn = 'https://clips-media-assets2.twitch.tv/abc.mp4';
    assert.equal(needsYtdlpDownload({ mp4Url: cdn, quality: 'helix-cdn' }), false);
  });

  it('uses yt-dlp for Twitch page URLs when not direct CDN', () => {
    assert.equal(
      needsYtdlpDownload({ pageUrl: 'https://www.twitch.tv/xqc/clip/CuriousCloudyBear', quality: 'page-url-ytdlp' }),
      true,
    );
  });

  it('CPD-1312 YouTube client is android/ios not ANDROID_VR', () => {
    const args = youtubeYtdlpExtraArgs('https://www.youtube.com/watch?v=abc');
    assert.deepEqual(args, ['--extractor-args', YOUTUBE_PLAYER_CLIENT_ARG]);
    assert.match(YOUTUBE_PLAYER_CLIENT_ARG, /android,ios/);
    assert.doesNotMatch(YOUTUBE_PLAYER_CLIENT_ARG, /ANDROID_VR/);
  });
});
