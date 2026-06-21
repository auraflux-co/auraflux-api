/**
 * Broadcast API routing — live grid/TV calls go direct to Render sidecar (CPD-1055).
 * Pipeline routes (/jobs, /calendar, /connect) stay on local CFG.ffmpegUrl.
 */
(function (global) {
  const DEFAULT_SIDECAR = 'https://auraflux-broadcast-staging.onrender.com';

  function sidecarUrl() {
    if (global.__BROADCAST_SIDECAR_URL__) return String(global.__BROADCAST_SIDECAR_URL__).replace(/\/$/, '');
    try {
      const stored = global.localStorage && global.localStorage.getItem('BROADCAST_SIDECAR_URL');
      if (stored) return stored.replace(/\/$/, '');
    } catch (_) { /* private mode */ }
    return DEFAULT_SIDECAR;
  }

  const DEFAULT_SIDECAR_B = 'https://auraflux-broadcast-staging-b.onrender.com';

  function sidecarBUrl() {
    if (global.__BROADCAST_SIDECAR_B_URL__) return String(global.__BROADCAST_SIDECAR_B_URL__).replace(/\/$/, '');
    try {
      const stored = global.localStorage && global.localStorage.getItem('BROADCAST_SIDECAR_B_URL');
      if (stored) return stored.replace(/\/$/, '');
    } catch (_) { /* private mode */ }
    return DEFAULT_SIDECAR_B;
  }

  function localUrl() {
    return ((typeof global.CFG !== 'undefined' && global.CFG.ffmpegUrl) || 'http://localhost:3000').replace(/\/$/, '');
  }

  function isSidecarPath(path) {
    return /^\/live-grid(\/|$)/.test(path)
      || /^\/live-tv(\/|$)/.test(path)
      || /^\/live-broadcast(\/|$)/.test(path);
  }

  function apiUrl(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return (isSidecarPath(p) ? sidecarUrl() : localUrl()) + p;
  }

  global.BroadcastApi = { sidecarUrl, sidecarBUrl, localUrl, apiUrl, isSidecarPath, DEFAULT_SIDECAR, DEFAULT_SIDECAR_B };
})(typeof window !== 'undefined' ? window : global);
