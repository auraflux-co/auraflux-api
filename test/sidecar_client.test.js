const { isEnabled, sidecarBaseUrl } = require('../lib/broadcast/sidecar_client');

describe('sidecar_client', () => {
  const origSidecar = process.env.LIVE_BROADCAST_SIDECAR;
  const origUrl = process.env.LIVE_SIDECAR_URL;

  afterEach(() => {
    process.env.LIVE_BROADCAST_SIDECAR = origSidecar;
    process.env.LIVE_SIDECAR_URL = origUrl;
  });

  test('enabled by default with LIVE_SIDECAR_URL', () => {
    process.env.LIVE_BROADCAST_SIDECAR = 'on';
    process.env.LIVE_SIDECAR_URL = 'http://127.0.0.1:3001';
    expect(isEnabled()).toBe(true);
    expect(sidecarBaseUrl()).toBe('http://127.0.0.1:3001');
  });

  test('disabled when LIVE_BROADCAST_SIDECAR=off', () => {
    process.env.LIVE_BROADCAST_SIDECAR = 'off';
    process.env.LIVE_SIDECAR_URL = 'http://127.0.0.1:3001';
    expect(isEnabled()).toBe(false);
  });
});

describe('live_routes health', () => {
  test('registerLiveBroadcastRoutes exposes health path', () => {
    const express = require('express');
    const { registerLiveBroadcastRoutes } = require('../lib/broadcast/live_routes');
    const app = express();
    app.use(express.json());
    registerLiveBroadcastRoutes(app, { grid: null, tv: null });
    const routes = app._router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(routes).toContain('/live-broadcast/health');
    expect(routes).toContain('/live-tv/status');
  });
});
