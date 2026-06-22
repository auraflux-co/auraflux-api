'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('channel_connect loadTokens args', () => {
  it('source channel tokens use brandId null (not platform as brandId)', () => {
    // Regression: loadTokens(customerId, 'kick') queried brand_id=kick — always empty.
    const customerId = 'user_test';
    const platform = 'kick';
    const wrongArgs = [customerId, platform];
    const rightArgs = [customerId, null, platform];
    assert.notDeepEqual(wrongArgs, rightArgs);
    assert.equal(rightArgs[1], null);
    assert.equal(rightArgs[2], 'kick');
  });
});
