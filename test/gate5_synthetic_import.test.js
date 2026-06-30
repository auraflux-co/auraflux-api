'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('gate5 upload-post synthetic flags', () => {
  it('gate5 imports resolveSyntheticMediaFlags (Upload-Post TikTok/IG path)', () => {
    const gate5Src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib', 'gates', 'gate5.js'),
      'utf8',
    );
    assert.match(gate5Src, /resolveSyntheticMediaFlags/);
    assert.match(gate5Src, /require\('\.\.\/publish_synthetic'\)/);
    const { resolveSyntheticMediaFlags } = require('../lib/publish_synthetic');
    const flags = resolveSyntheticMediaFlags({ contentType: 'twitch-short' });
    assert.equal(flags.isAigc, false);
  });
});
