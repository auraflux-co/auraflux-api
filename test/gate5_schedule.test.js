jest.mock('../lib/publish', () => ({
  canPublishDirect: jest.fn(async () => ({ canDirect: false })),
  publishDirect: jest.fn(),
}));

const { validatePrePublish } = require('../lib/portals/portal5');

describe('portal5 native scheduling metadata', () => {
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

  test('future scheduledAt passes for TikTok + YouTube shorts bundle', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const r = validatePrePublish({
      title: 'Short',
      description: 'Caption #news',
      platforms: ['youtube', 'tiktok', 'instagram'],
      scheduledAt: future,
    });
    expect(r.passed).toBe(true);
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
