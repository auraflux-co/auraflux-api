'use strict';

const { validatePublishMetadata, reviewHoldEnabled } = require('../lib/gates/metadata_qa');

describe('metadata_qa (CPD-1049)', () => {
  test('blocks AI in clip comp title', () => {
    const r = validatePublishMetadata(
      { contentType: 'twitch-short', designSpec: { chrome: { layout: 'clip-comp' } } },
      { title: 'Streamers Go Wild With AI', description: 'Clips' }
    );
    expect(r.passed).toBe(false);
    expect(r.violations.some((v) => v.includes('AI'))).toBe(true);
  });

  test('passes title referencing clip topic', () => {
    const r = validatePublishMetadata(
      {
        contentType: 'twitch-short',
        designSpec: { chrome: { layout: 'clip-comp' } },
        order: { inputs: { items: [{ title: 'Jason Rage Quits Minecraft' }] } },
      },
      { title: 'Jason Rage Quits — Twitch Clips', description: '@clipzworld' }
    );
    expect(r.passed).toBe(true);
  });

  test('review hold on by default', () => {
    delete process.env.C0_REVIEW_HOLD;
    expect(reviewHoldEnabled()).toBe(true);
  });
});
