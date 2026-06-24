'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildKaraokeAssFromVerboseJson } = require('../lib/clip_comp_karaoke');

test('buildKaraokeAssFromVerboseJson emits karaoke tags', () => {
  const ass = buildKaraokeAssFromVerboseJson({
    segments: [{
      start: 0,
      end: 2,
      words: [
        { word: 'Hello', start: 0, end: 0.5 },
        { word: 'world', start: 0.5, end: 1.2 },
      ],
    }],
  }, { fullBleed: true });
  assert.ok(ass.includes('\\k'));
  assert.ok(ass.includes('Hello'));
  assert.ok(ass.includes('[Events]'));
});
