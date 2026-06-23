'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveReportingRange, MAX_DAYS } = require('../lib/services/north_star_dates');

test('resolveReportingRange uses days preset ending on endDate', () => {
  const r = resolveReportingRange({ days: 7, endDate: '2026-06-12' });
  assert.equal(r.endDate, '2026-06-12');
  assert.equal(r.startDate, '2026-06-06');
  assert.equal(r.days, 7);
  assert.equal(r.focusDate, '2026-06-12');
});

test('resolveReportingRange clamps span to MAX_DAYS', () => {
  const r = resolveReportingRange({
    startDate: '2026-01-01',
    endDate: '2026-06-12',
  });
  assert.equal(r.days, MAX_DAYS);
  assert.equal(r.endDate, '2026-06-12');
});

test('resolveReportingRange rejects invalid dates', () => {
  assert.throws(() => resolveReportingRange({ startDate: 'bad', endDate: '2026-06-12' }), /Invalid reporting dates/);
  assert.throws(() => resolveReportingRange({ startDate: '2026-06-13', endDate: '2026-06-12' }), /startDate must be on or before endDate/);
});
