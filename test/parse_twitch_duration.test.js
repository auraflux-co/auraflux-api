'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTwitchDuration } = require('../lib/pickers/streamers/vods');

describe('parseTwitchDuration', () => {
  it('parses Helix duration strings', () => {
    assert.equal(parseTwitchDuration('5h2m3s'), 5 * 3600 + 2 * 60 + 3);
    assert.equal(parseTwitchDuration('42m'), 42 * 60);
    assert.equal(parseTwitchDuration(120), 120);
  });
});
