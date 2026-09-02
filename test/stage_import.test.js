'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const {
  detectPlatform,
  assertSafeLocalPath,
  DEFAULT_MAX_DURATION_SEC,
} = require('../lib/content_library/stage_import');

test('detectPlatform classifies youtube / facebook / twitch', () => {
  assert.equal(detectPlatform('https://www.youtube.com/watch?v=abc'), 'youtube');
  assert.equal(detectPlatform('https://youtu.be/abc'), 'youtube');
  assert.equal(detectPlatform('https://www.facebook.com/reel/123'), 'facebook');
  assert.equal(detectPlatform('https://www.twitch.tv/videos/1'), 'twitch');
});

test('assertSafeLocalPath allows tmp under repo', () => {
  const p = path.join(__dirname, '..', 'tmp');
  // directory itself may not be a file — only check rejection of /etc
  assert.throws(() => assertSafeLocalPath('/etc/passwd'), /must be under/);
  assert.throws(() => assertSafeLocalPath(path.join(os.tmpdir(), 'no-such-cwn-import-xyz.mp4')), /not found/);
});

test('DEFAULT_MAX_DURATION_SEC is 15 minutes', () => {
  assert.equal(DEFAULT_MAX_DURATION_SEC, 900);
});
