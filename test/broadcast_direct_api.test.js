describe('broadcast cors middleware (CPD-1055)', () => {
  test('allows localhost origin', () => {
    const { broadcastCorsMiddleware } = require('../lib/broadcast/cors_middleware');
    const mw = broadcastCorsMiddleware();
    const headers = {};
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (c) => ({ end: () => c }),
    };
    let nextCalled = false;
    mw({ method: 'GET', headers: { origin: 'http://localhost:3002' } }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3002');
  });

  test('OPTIONS returns 204', () => {
    const { broadcastCorsMiddleware } = require('../lib/broadcast/cors_middleware');
    const mw = broadcastCorsMiddleware();
    let code = 0;
    const res = {
      setHeader: () => {},
      status: (c) => { code = c; return { end: () => {} }; },
    };
    mw({ method: 'OPTIONS', headers: {} }, res, () => {});
    expect(code).toBe(204);
  });
});

describe('broadcast direct API path routing', () => {
  function isSidecarPath(path) {
    return /^\/live-grid(\/|$)/.test(path)
      || /^\/live-tv(\/|$)/.test(path)
      || /^\/live-broadcast(\/|$)/.test(path);
  }

  test('live grid and tv paths use sidecar', () => {
    expect(isSidecarPath('/live-grid/status')).toBe(true);
    expect(isSidecarPath('/live-tv/start')).toBe(true);
    expect(isSidecarPath('/live-broadcast/health')).toBe(true);
  });

  test('pipeline paths stay local', () => {
    expect(isSidecarPath('/calendar/plan')).toBe(false);
    expect(isSidecarPath('/broadcast/ops')).toBe(false);
    expect(isSidecarPath('/connect/twitch')).toBe(false);
  });
});
