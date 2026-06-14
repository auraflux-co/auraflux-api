const { validatePrePublish } = require('../lib/gates/gate5');

describe('gate5 native scheduling metadata', () => {
  test('future scheduledAt sets private for YouTube', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const r = validatePrePublish({
      title: 'Test',
      description: 'Desc',
      platforms: ['youtube'],
      scheduledAt: future,
      privacyStatus: 'public',
    });
    expect(r.passed).toBe(true);
    expect(r.corrected.privacyStatus).toBe('private');
  });

  test('past scheduledAt fails validation', () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    const r = validatePrePublish({
      title: 'Test',
      platforms: ['youtube'],
      scheduledAt: past,
    });
    expect(r.passed).toBe(false);
  });
});
