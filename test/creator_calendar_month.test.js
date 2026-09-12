'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMonthView,
  setDayPlan,
  setMonthDefaults,
  emptyPlan,
  dateKey,
} = require('../lib/creator_calendar/month_plan');

test('buildMonthView marks met when actual >= planned', () => {
  let plan = emptyPlan();
  plan = setMonthDefaults(plan, 2026, 9, { short: 1, longform: 0, live: 0 });
  const jobs = [{
    id: 'j1',
    status: 'published',
    published_at: Date.parse('2026-09-10T15:00:00Z'),
    job_spec: { formFactor: 'short', title: 'A' },
  }];
  const view = buildMonthView(plan, jobs, 2026, 9);
  const cell = view.daysByDate[dateKey(2026, 9, 10)];
  assert.equal(cell.planned.short, 1);
  assert.equal(cell.actual.short, 1);
  assert.equal(cell.status, 'met');
});

test('setDayPlan customizes a single day', () => {
  let plan = emptyPlan();
  plan = setDayPlan(plan, 2026, 9, 11, { short: 3, note: 'Launch' });
  const view = buildMonthView(plan, [], 2026, 9);
  assert.equal(view.daysByDate['2026-09-11'].planned.short, 3);
  assert.equal(view.daysByDate['2026-09-11'].planned.note, 'Launch');
  assert.equal(view.daysByDate['2026-09-11'].planned.custom, true);
});
