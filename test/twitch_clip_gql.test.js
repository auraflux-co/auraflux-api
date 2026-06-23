'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signedClipMp4FromGqlClip } = require('../lib/clients/twitch_client');

test('signedClipMp4FromGqlClip parses ShareClipRenderStatus payload', () => {
  const clip = {
    playbackAccessToken: { signature: 'sig123', value: 'tok456' },
    assets: [{
      videoQualities: [
        { quality: '1080', sourceURL: 'https://cdn.example/1080', frameRate: 60 },
        { quality: '720', sourceURL: 'https://cdn.example/720', frameRate: 60 },
      ],
    }],
  };
  const out = signedClipMp4FromGqlClip(clip, 'high');
  assert.match(out.mp4Url, /^https:\/\/cdn\.example\/1080\?sig=/);
  assert.equal(out.quality, '1080p');
});

test('signedClipMp4FromGqlClip prefers 720 for low quality', () => {
  const clip = {
    playbackAccessToken: { signature: 's', value: 't' },
    videoQualities: [
      { quality: '1080', sourceURL: 'https://cdn.example/1080' },
      { quality: '720', sourceURL: 'https://cdn.example/720' },
    ],
  };
  const out = signedClipMp4FromGqlClip(clip, 'low');
  assert.match(out.mp4Url, /^https:\/\/cdn\.example\/720/);
});
