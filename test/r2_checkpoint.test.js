'use strict';

const { _resolveCheckpointUrl } = require('../lib/services/r2_checkpoint');

describe('r2_checkpoint (CPD-1047)', () => {
  test('resolves r2VideoUrl from savedOutputs', () => {
    const url = _resolveCheckpointUrl({
      state: { savedOutputs: { r2VideoUrl: 'https://r2.example/out.mp4' } },
    });
    expect(url).toBe('https://r2.example/out.mp4');
  });

  test('falls back to assembledVideoUrl', () => {
    const url = _resolveCheckpointUrl({ assembledVideoUrl: 'https://r2.example/v2.mp4' });
    expect(url).toBe('https://r2.example/v2.mp4');
  });

  test('returns null when no checkpoint', () => {
    expect(_resolveCheckpointUrl({})).toBeNull();
  });
});
