'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('live_grid delivery_qa', () => {
  const orig = { ...process.env };

  afterEach(() => {
    process.env = { ...orig };
    jest.resetModules();
  });

  test('idle when grid not running', () => {
    const { assessDelivery } = require('../lib/live_grid/delivery_qa');
    const r = assessDelivery({ running: false });
    expect(r.viewerLevel).toBe('idle');
    expect(r.signals).toHaveLength(0);
  });

  test('critical hls_stale suggests restart_restreamer self-heal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-qa-'));
    const previewDir = path.join(tmp, 'preview');
    fs.mkdirSync(previewDir, { recursive: true });
    const seg = path.join(previewDir, 'seg0.ts');
    fs.writeFileSync(seg, 'x');
    fs.writeFileSync(path.join(previewDir, 'index.m3u8'), '#EXTM3U\nseg0.ts\n');
    const past = Date.now() - 60_000;
    fs.utimesSync(seg, past / 1000, past / 1000);

    jest.doMock('../lib/live_grid/local_preview', () => ({
      hlsPreviewLive: () => false,
      hlsSegmentAgeMs: () => 60_000,
    }));
    const { assessDelivery } = require('../lib/live_grid/delivery_qa');

    const r = assessDelivery({
      running: true,
      middleware: { outputMiddleware: true, restreamer: { running: true, restarts: 0, uptimeSec: 100 } },
      master: { running: true, uptimeSec: 100, restarts: 0 },
      relays: [{ running: true, restarts: 0 }, { running: true, restarts: 0 }, { running: true, restarts: 0 }, { running: true, restarts: 0 }],
    });

    expect(r.viewerLevel).toBe('degraded');
    expect(r.viewerScore).toBe(55);
    expect(r.signals.some((s) => s.key === 'hls_stale')).toBe(true);
    expect(r.selfHeal?.actions).toContain('restart_restreamer');
    expect(r.humanQaRequired).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('relayChurnScore handles relay array from manager.status', () => {
    const { relayChurnScore } = require('../lib/live_grid/delivery_qa');
    const s = relayChurnScore([
      { running: true, restarts: 2 },
      { running: false, restarts: 1 },
    ]);
    expect(s.churn).toBe(3);
    expect(s.down).toBe(1);
  });
});
