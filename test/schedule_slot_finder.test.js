'use strict';
/**
 * test/schedule_slot_finder.test.js — CPD-873
 */

jest.mock('../lib/db/postgres', () => ({
  query: jest.fn(),
  updateJobPublishSchedule: jest.fn(),
}));

const { query, updateJobPublishSchedule } = require('../lib/db/postgres');
const { _nextOccurrence, _weekBoundsMs, findNextPublishSlot, autoSlotApprovedJob } =
  require('../lib/services/schedule_slot_finder');

// ─── _nextOccurrence ──────────────────────────────────────────────────────────

describe('_nextOccurrence', () => {
  // Fix: Monday 2026-06-08 09:00
  const from = new Date('2026-06-08T09:00:00.000Z');

  it('daily slot — time today not yet reached → same day', () => {
    const slot = { day: -1, time: '14:00' };
    const result = _nextOccurrence(slot, from);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(0);
    // Same day as fromDate
    expect(result.getDate()).toBe(from.getDate());
  });

  it('daily slot — time already passed today → result is > from', () => {
    // Use a time clearly before 09:00 so the slot is always in the past
    const slot = { day: -1, time: '03:00' };
    const result = _nextOccurrence(slot, from);
    // Must be strictly after fromDate since 03:00 is already past 09:00
    expect(result.getTime()).toBeGreaterThan(from.getTime());
    // Must be within 24h
    expect(result.getTime()).toBeLessThan(from.getTime() + 24 * 60 * 60 * 1000 + 1);
  });

  it('weekday slot — same day but time not yet reached → same day', () => {
    // from is Monday (getDay()=1), slot also Monday at 14:00
    const slot = { day: 1, time: '14:00' };
    const result = _nextOccurrence(slot, from);
    expect(result.getDay()).toBe(1);
    expect(result.getHours()).toBe(14);
    expect(result >= from).toBe(true);
  });

  it('weekday slot — next occurrence of Wednesday from Monday', () => {
    const slot = { day: 3, time: '10:00' };  // Wednesday
    const result = _nextOccurrence(slot, from);
    expect(result.getDay()).toBe(3);
    // 2 days ahead
    expect(result.getDate()).toBe(from.getDate() + 2);
  });

  it('returns null for invalid time', () => {
    const slot = { day: 1, time: 'bad' };
    expect(_nextOccurrence(slot, from)).toBeNull();
  });
});

// ─── _weekBoundsMs ────────────────────────────────────────────────────────────

describe('_weekBoundsMs', () => {
  it('Monday → weekStart is same Monday 00:00, weekEnd is Sunday 23:59', () => {
    const monday = new Date('2026-06-08T12:00:00Z');
    const { weekStart, weekEnd } = _weekBoundsMs(monday);
    const start = new Date(weekStart);
    const end   = new Date(weekEnd);
    expect(start.getDay()).toBe(1);  // Monday
    expect(end.getDay()).toBe(0);    // Sunday
    expect(end.getHours()).toBe(23);
  });

  it('weekEnd > weekStart', () => {
    const { weekStart, weekEnd } = _weekBoundsMs(new Date());
    expect(weekEnd).toBeGreaterThan(weekStart);
  });
});

// ─── findNextPublishSlot ──────────────────────────────────────────────────────

describe('findNextPublishSlot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when no prefs row found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const result = await findNextPublishSlot('brand-1', 'youtube', { fromDate: new Date() });
    expect(result).toBeNull();
  });

  it('returns null when platform has no slots configured', async () => {
    query.mockResolvedValueOnce({ rows: [{ publish_schedule_prefs: { tiktok: [] } }] });
    const result = await findNextPublishSlot('brand-1', 'youtube', { fromDate: new Date() });
    expect(result).toBeNull();
  });

  it('returns a slot when frequency cap is not hit', async () => {
    query
      // First call: load prefs
      .mockResolvedValueOnce({
        rows: [{ publish_schedule_prefs: { youtube: [{ day: -1, time: '14:00' }] } }],
      })
      // Second call: count scheduled in window
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] });

    const from   = new Date('2026-06-08T09:00:00.000Z');
    const result = await findNextPublishSlot('brand-1', 'youtube', { fromDate: from });
    expect(result).not.toBeNull();
    expect(result.slot.time).toBe('14:00');
    expect(result.scheduledPublishAt).toBeGreaterThan(from.getTime());
  });

  it('skips a slot when frequency cap is hit and finds next-week slot', async () => {
    query
      // Load prefs — 1 slot per week
      .mockResolvedValueOnce({
        rows: [{ publish_schedule_prefs: { youtube: [{ day: 2, time: '10:00' }] } }],
      })
      // Week 1 cap hit (count=1, cap=1)
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }] })
      // Week 2 under cap (count=0)
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] });

    const from   = new Date('2026-06-08T09:00:00.000Z'); // Monday
    const result = await findNextPublishSlot('brand-1', 'youtube', { fromDate: from });
    expect(result).not.toBeNull();
    // Should be 8+ days ahead (next week's Tuesday)
    expect(result.scheduledPublishAt).toBeGreaterThan(from.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  });
});

// ─── autoSlotApprovedJob ──────────────────────────────────────────────────────

describe('autoSlotApprovedJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing if no platforms on spec', async () => {
    const spec = { jobId: 'j1', brandId: 'b1', order: { publish: { platforms: [] } } };
    await autoSlotApprovedJob(spec, 'j1');
    expect(spec.status).toBeUndefined();
  });

  it('does nothing if no schedule prefs found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const spec = {
      jobId: 'j1', brandId: 'b1',
      order: { publish: { platforms: ['youtube'] } },
    };
    await autoSlotApprovedJob(spec, 'j1');
    expect(spec.status).toBeUndefined();
  });

  it('sets status=ready_to_publish and scheduledPublishAt when slot found', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ publish_schedule_prefs: { youtube: [{ day: -1, time: '14:00' }] } }],
      })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    updateJobPublishSchedule.mockResolvedValueOnce();

    const spec = {
      jobId: 'j1', brandId: 'b1', customerId: 'cust-1',
      order: { publish: { platforms: ['youtube'] } },
    };
    await autoSlotApprovedJob(spec, 'j1');
    expect(spec.status).toBe('ready_to_publish');
    expect(spec.order.publish.scheduledPublishAt).toBeDefined();
    expect(updateJobPublishSchedule).toHaveBeenCalledWith('j1', 'scheduled', expect.any(Number));
  });

  it('rolls back to status=complete if DB write fails', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ publish_schedule_prefs: { youtube: [{ day: -1, time: '14:00' }] } }],
      })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] });
    updateJobPublishSchedule.mockRejectedValueOnce(new Error('db error'));

    const spec = {
      jobId: 'j1', brandId: 'b1', customerId: 'cust-1',
      status: 'complete',
      order: { publish: { platforms: ['youtube'] } },
    };
    await autoSlotApprovedJob(spec, 'j1');
    expect(spec.status).toBe('complete');
    expect(spec.order.publish.scheduledPublishAt).toBeUndefined();
  });
});
