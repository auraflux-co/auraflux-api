'use strict';

const {
  leadMinutesForKind,
  productionTriggerMinutes,
  isProductionDue,
  slotAlreadyCovered,
  isLongformAvatarBlocked,
  resolveCustomerId,
} = require('../lib/calendar/auto_production');
const { productionCronDefault } = require('../lib/services/production_cron');

describe('auto_production (CPD-1053)', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('leadMinutesForKind defaults', () => {
    expect(leadMinutesForKind('longform')).toBe(120);
    expect(leadMinutesForKind('short')).toBe(90);
  });

  test('productionTriggerMinutes subtracts lead from slot time', () => {
    const mins = productionTriggerMinutes({ time: '17:00', kind: 'short' });
    expect(mins).toBe(15 * 60 + 30); // 17:00 - 90m = 15:30
  });

  test('slotAlreadyCovered when matching job already in flight', () => {
    const jobs = {
      j1: { contentType: 'twitch-short', stage: 'assembling' },
    };
    expect(slotAlreadyCovered({ id: 'twitch_short', contentType: 'twitch-short' }, '2026-06-16', jobs)).toBe(true);
  });

  test('isLongformAvatarBlocked when HEYGEN_API_KEY missing', () => {
    delete process.env.HEYGEN_API_KEY;
    const r = isLongformAvatarBlocked();
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/HEYGEN/);
  });

  test('resolveCustomerId prefers env then config default', () => {
    process.env.PRODUCTION_CRON_CUSTOMER_ID = 'brand-abc';
    expect(resolveCustomerId({ customerId: 'c0' })).toBe('brand-abc');
  });

  test('productionCronDefault is off on Render unless explicitly enabled', () => {
    process.env.RENDER = 'true';
    delete process.env.PRODUCTION_CRON;
    expect(productionCronDefault()).toBe('off');
    process.env.PRODUCTION_CRON = 'on';
    expect(productionCronDefault()).toBe('on');
  });
});
