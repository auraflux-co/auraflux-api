/**
 * Proxy /live-tv and /live-grid to the broadcast sidecar (survives auraflux restarts).
 * CPD-1055: catch-all forward — every sidecar route reachable from localhost dashboard.
 */

const axios = require('axios');

function sidecarBaseUrl() {
  const url = process.env.LIVE_SIDECAR_URL || `http://127.0.0.1:${process.env.LIVE_SIDECAR_PORT || 3001}`;
  return url.replace(/\/$/, '');
}

function isEnabled() {
  return String(process.env.LIVE_BROADCAST_SIDECAR || 'on').toLowerCase() !== 'off';
}

async function request(method, path, body) {
  const base = sidecarBaseUrl();
  const resp = await axios({
    method,
    url: `${base}${path}`,
    data: body,
    timeout: 120000,
    validateStatus: () => true,
  });
  return { status: resp.status, data: resp.data };
}

async function getStatus() {
  const [tv, grid] = await Promise.all([
    request('GET', '/live-tv/status'),
    request('GET', '/live-grid/status'),
  ]);
  return {
    tvRunning: !!(tv.data?.running || tv.data?.streaming),
    gridRunning: !!grid.data?.running,
    tv: tv.data,
    grid: grid.data,
    sidecarReachable: tv.status < 500,
  };
}

/** Paths forwarded to the broadcast sidecar (used by tests). */
const PROXY_PREFIXES = ['/live-grid', '/live-tv', '/live-broadcast'];

function mountProxy(app) {
  const base = sidecarBaseUrl();
  const forward = async (req, res) => {
    try {
      const url = `${base}${req.originalUrl}`;
      const resp = await axios({
        method: req.method,
        url,
        data: req.body,
        params: req.query,
        timeout: 120000,
        validateStatus: () => true,
      });
      res.status(resp.status).json(resp.data);
    } catch (e) {
      res.status(502).json({
        ok: false,
        error: `Broadcast sidecar unreachable at ${base} — check LIVE_SIDECAR_URL and sidecar health`,
        detail: e.message,
      });
    }
  };

  for (const prefix of PROXY_PREFIXES) {
    app.use(prefix, (req, res) => { forward(req, res); });
  }
}

module.exports = {
  isEnabled,
  sidecarBaseUrl,
  request,
  getStatus,
  mountProxy,
  PROXY_PREFIXES,
};
