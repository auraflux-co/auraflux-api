'use strict';

const {
  appendSupportPromoToDescription,
  supportPromoLine,
  applySupportPromoToPublishCopy,
  descriptionHasSupportPromo,
} = require('../lib/clipzworld_support');

describe('clipzworld_support', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  test('default promo line includes goal URL', () => {
    delete process.env.CLIPZWORLD_SUPPORT_PROMO_MESSAGE;
    expect(supportPromoLine()).toMatch(/ko-fi\.com\/clipzworldnews\/goal/);
    expect(supportPromoLine().length).toBeLessThanOrEqual(200);
  });

  test('appendSupportPromoToDescription is idempotent', () => {
    const once = appendSupportPromoToDescription('Hello world');
    expect(descriptionHasSupportPromo(once)).toBe(true);
    const twice = appendSupportPromoToDescription(once);
    expect(twice).toBe(once);
  });

  test('applySupportPromoToPublishCopy updates youtube description', () => {
    const payload = { youtube: { title: 'Test', description: 'Episode hook.' } };
    applySupportPromoToPublishCopy(payload);
    expect(payload.youtube.description).toMatch(/ko-fi\.com\/clipzworldnews/);
  });
});
