'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanClipPathsForMusic,
  preflightAction,
  musicPreflightEnabled,
} = require('../lib/gates/music_preflight');

describe('music_preflight (CPD-1050)', () => {
  const prev = { ...process.env };
  let tmpClip;

  beforeEach(() => {
    tmpClip = path.join(os.tmpdir(), `music_pf_test_${Date.now()}.mp4`);
    fs.writeFileSync(tmpClip, 'stub');
  });

  afterEach(() => {
    process.env = { ...prev };
    try { fs.unlinkSync(tmpClip); } catch (_) { /* ignore */ }
  });

  test('skipped when C0_MUSIC_PREFLIGHT=off', async () => {
    process.env.C0_MUSIC_PREFLIGHT = 'off';
    const r = await scanClipPathsForMusic(['/tmp/nope.mp4']);
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(true);
  });

  test('warn action passes with flagged clips', async () => {
    process.env.C0_MUSIC_PREFLIGHT = 'on';
    process.env.C0_MUSIC_PREFLIGHT_ACTION = 'warn';
    const r = await scanClipPathsForMusic([tmpClip], {
      sample: async () => Buffer.from('audio'),
      classify: async () => ({ music: true, confidence: 0.95 }),
    });
    expect(r.flagged).toHaveLength(1);
    expect(r.passed).toBe(true);
    expect(r.action).toBe('warn');
  });

  test('hold action fails when music flagged', async () => {
    process.env.C0_MUSIC_PREFLIGHT = 'on';
    process.env.C0_MUSIC_PREFLIGHT_ACTION = 'hold';
    const r = await scanClipPathsForMusic([tmpClip], {
      sample: async () => Buffer.from('audio'),
      classify: async () => ({ music: true, confidence: 0.95 }),
    });
    expect(r.passed).toBe(false);
    expect(preflightAction()).toBe('hold');
    expect(musicPreflightEnabled()).toBe(true);
  });
});
