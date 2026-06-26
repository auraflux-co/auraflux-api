'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadRoster, RETENTION_DAYS } = require('../lib/content_library');

describe('content_library roster', () => {
  it('loads roster with twitch logins', () => {
    const roster = loadRoster();
    assert.ok(roster.length >= 10);
    assert.ok(roster.some((s) => s.login === 'cinna' && s.platform === 'twitch'));
  });

  it('retention is 7 days', () => {
    assert.equal(RETENTION_DAYS, 7);
  });
});
