'use strict';

const assert = require('assert');
const { buildItemsFromJobClipLineup } = require('../lib/avatar_vod_retry');

const job = {
  orderedClipUrls: [
    { displayName: 'Cinna', title: 'clip a', pageUrl: 'https://clips.twitch.tv/A', url: 'https://cdn/a.mp4' },
    { displayName: 'Cinna', title: 'clip b', pageUrl: 'https://clips.twitch.tv/B' },
    { displayName: 'ExtraEmily', title: 'ICANT', pageUrl: 'https://clips.twitch.tv/C' },
  ],
};

const items = buildItemsFromJobClipLineup(job);
assert.strictEqual(items.length, 2);
assert.strictEqual(items[0].displayName, 'Cinna');
assert.strictEqual(items[0].clips.length, 2);
assert.strictEqual(items[1].clips.length, 1);
assert.strictEqual(items[0].clips[0].url, 'https://clips.twitch.tv/A');

console.log('avatar_vod_retry.test.js: ok');
