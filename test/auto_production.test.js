const {
  isLongformAvatarBlocked,
  productionTriggerMinutes,
  isProductionDue,
  slotAlreadyCovered,
  leadMinutesForKind,
} = require('../lib/calendar/auto_production');

describe('auto_production', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('isLongformAvatarBlocked when HeyGen missing', () => {
    delete process.env.HEYGEN_API_KEY;
    process.env.GATE_TEST_MODE = 'false';
    process.env.GEMINI_API_KEY = 'test';
    expect(isLongformAvatarBlocked().blocked).toBe(true);
  });

  test('isLongformAvatarBlocked when GATE_TEST_MODE true', () => {
    process.env.HEYGEN_API_KEY = 'key';
    process.env.GATE_TEST_MODE = 'true';
    process.env.GEMINI_API_KEY = 'test';
    expect(isLongformAvatarBlocked().blocked).toBe(true);
  });

  test('isLongformAvatarBlocked clear when credentials ready', () => {
    process.env.HEYGEN_API_KEY = 'key';
    process.env.GATE_TEST_MODE = 'false';
    process.env.GEMINI_API_KEY = 'test';
    expect(isLongformAvatarBlocked().blocked).toBe(false);
  });

  test('productionTriggerMinutes subtracts lead for shorts', () => {
    const slot = { time: '17:00', kind: 'short' };
    expect(productionTriggerMinutes(slot)).toBe(15 * 60 + 30); // 90 min lead → 15:30
  });

  test('productionTriggerMinutes subtracts longer lead for longform', () => {
    const slot = { time: '10:45', kind: 'longform' };
    expect(productionTriggerMinutes(slot)).toBe(8 * 60 + 45); // 120 min lead → 08:45
  });

  test('slotAlreadyCovered detects in-flight job', () => {
    const slot = { id: 'news_short', contentType: 'news-short', kind: 'short' };
    const jobs = {
      j1: { contentType: 'news-short', stage: 'assembling' },
    };
    expect(slotAlreadyCovered(slot, '2026-06-13', jobs)).toBe(true);
  });

  test('isProductionDue after trigger window', () => {
    const slot = { time: '17:00', kind: 'short' };
    const trigger = productionTriggerMinutes(slot);
    const fakeDate = new Date('2026-06-13T12:00:00-04:00');
    // Mock nowET by using real isProductionDue only if we're past trigger — use lead math
    expect(leadMinutesForKind('short')).toBe(90);
    expect(trigger).toBe(15 * 60 + 30);
    // 16:00 ET is after 15:30 trigger
    const afternoon = new Date('2026-06-13T16:00:00-04:00');
    expect(isProductionDue(slot, afternoon)).toBe(true);
  });
});
