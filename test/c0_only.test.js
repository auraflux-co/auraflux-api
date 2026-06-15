'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isC0Localhost } = require('../lib/middleware/c0_only');

test('isC0Localhost respects C0_LOCALHOST flag', () => {
  const orig = { ...process.env };
  try {
    delete process.env.C0_LOCALHOST;
    delete process.env.DATABASE_URL;
    assert.equal(isC0Localhost(), true);

    process.env.C0_LOCALHOST = '0';
    assert.equal(isC0Localhost(), false);

    process.env.C0_LOCALHOST = '1';
    assert.equal(isC0Localhost(), true);

    process.env.C0_LOCALHOST = '0';
    process.env.DATABASE_URL = 'postgres://x';
    assert.equal(isC0Localhost(), false);
  } finally {
    process.env = orig;
  }
});
