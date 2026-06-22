'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('token_store SQL_BRAND_MATCH', () => {
  it('uses IS NULL for null brandId (brand_id = NULL is always false in SQL)', () => {
    const SQL_BRAND_MATCH = '(($2::uuid IS NULL AND brand_id IS NULL) OR brand_id = $2::uuid)';
    assert.match(SQL_BRAND_MATCH, /brand_id IS NULL/);
    assert.doesNotMatch(SQL_BRAND_MATCH, /brand_id = \$2[^:]/);
  });
});
