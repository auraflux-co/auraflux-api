'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('fetchTwitchClips sets ended_at when started_at window is used', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../lib/pickers/streamers/adapters/twitch.js'),
    'utf8',
  );
  assert.match(src, /if \(startedAt\) params\.set\('started_at', startedAt\)/);
  assert.match(src, /if \(endedAt\) params\.set\('ended_at', endedAt\)/);
  assert.match(src, /const endedAt = startedAt \? new Date\(\)\.toISOString\(\) : null/);
});

test('fetchStreamerPickerClips does not force 24h when pubHours is null', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/pickers/streamers/index.js'), 'utf8');
  assert.match(src, /pubHours: pubHours != null \? pubHours : null/);
  assert.doesNotMatch(src, /pubHours: pubHours \|\| 24/);
});
