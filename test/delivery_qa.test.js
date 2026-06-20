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

  test('critical hls_stale suggests restart_compositor self-heal', () => {
    jest.doMock('../lib/live_grid/local_preview', () => ({
      hlsPreviewLive: () => false,
      hlsSegmentAgeMs: () => 60_000,
    }));
    const { assessDelivery } = require('../lib/live_grid/delivery_qa');

    const r = assessDelivery({
      running: true,
      middleware: { outputMiddleware: true, restreamer: { running: true, restarts: 0, uptimeSec: 100 } },
      master: { running: true, uptimeSec: 100, restarts: 0 },
      relays: [
        { running: true, restarts: 0 },
        { running: true, restarts: 0 },
        { running: true, restarts: 0 },
        { running: true, restarts: 0 },
      ],
    });

    expect(r.viewerLevel).toBe('degraded');
    expect(r.viewerScore).toBe(55);
    expect(r.signals.some((s) => s.key === 'hls_stale')).toBe(true);
    expect(r.selfHeal?.actions).toContain('restart_compositor');
    expect(r.selfHeal?.actions).not.toContain('restart_restreamer');
    expect(r.humanQaRequired).toBe(true);
  });

  test('restreamer_down when HLS live suggests restart_restreamer', () => {
    jest.doMock('../lib/live_grid/local_preview', () => ({
      hlsPreviewLive: () => true,
      hlsSegmentAgeMs: () => 1500,
    }));
    const { assessDelivery } = require('../lib/live_grid/delivery_qa');

    const r = assessDelivery({
      running: true,
      middleware: { outputMiddleware: true, restreamer: { running: false, restarts: 0 } },
      master: { running: true, uptimeSec: 100, restarts: 0 },
      relays: [{ running: true }, { running: true }, { running: true }, { running: true }],
    });

    expect(r.signals.some((s) => s.key === 'restreamer_down')).toBe(true);
    expect(r.selfHeal?.actions).toContain('restart_restreamer');
  });

  test('restreamer_down when HLS stale suggests restart_encode_pipeline', () => {
    jest.doMock('../lib/live_grid/local_preview', () => ({
      hlsPreviewLive: () => false,
      hlsSegmentAgeMs: () => 30_000,
    }));
    const { assessDelivery } = require('../lib/live_grid/delivery_qa');

    const r = assessDelivery({
      running: true,
      middleware: { outputMiddleware: true, restreamer: { running: false, restarts: 0 } },
      master: { running: true, uptimeSec: 100, restarts: 0 },
      relays: [{ running: true }, { running: true }, { running: true }, { running: true }],
    });

    expect(r.selfHeal?.actions).toContain('restart_encode_pipeline');
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
