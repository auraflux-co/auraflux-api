'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sanitizeStreamer,
  stableClipId,
  assertSafeLocalPath,
  probeDurationSec,
} = require('../lib/content_library/stage_local');

describe('stage_local helpers (Peaks browser upload)', () => {
  it('sanitizes streamer names', () => {
    expect(sanitizeStreamer('Foo Bar!', 'x')).toBe('foobar');
    expect(sanitizeStreamer('', 'peaks_upload')).toBe('peaks_upload');
  });

  it('builds stable clip ids', () => {
    const a = stableClipId('seed-one');
    const b = stableClipId('seed-one');
    const c = stableClipId('seed-two');
    expect(a).toBe(b);
    expect(a).toMatch(/^imp_[a-f0-9]{16}$/);
    expect(a).not.toBe(c);
  });

  it('allows paths under os.tmpdir()', () => {
    const f = path.join(os.tmpdir(), `peaks_test_${Date.now()}.mp4`);
    fs.writeFileSync(f, Buffer.alloc(8000, 1));
    expect(assertSafeLocalPath(f)).toBe(path.resolve(f));
    fs.unlinkSync(f);
  });

  it('rejects paths outside allowed roots', () => {
    expect(() => assertSafeLocalPath('/etc/passwd')).toThrow(/must be under/);
  });

  it('probes duration of a tiny non-media file as 0', async () => {
    const f = path.join(os.tmpdir(), `peaks_probe_${Date.now()}.bin`);
    fs.writeFileSync(f, Buffer.alloc(100, 2));
    const d = await probeDurationSec(f);
    expect(d).toBe(0);
    fs.unlinkSync(f);
  });
});
