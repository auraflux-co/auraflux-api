/**
 * Proxy /live-tv and /live-grid to the broadcast sidecar (survives auraflux restarts).
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
        error: `Broadcast sidecar unreachable at ${base} — is pm2 process broadcast-sidecar running?`,
        detail: e.message,
      });
    }
  };

  app.all('/live-tv', forward);
  app.all('/live-tv/*', forward);
  app.all('/live-grid/start', forward);
  app.all('/live-grid/prepare', forward);
  app.all('/live-grid/prepare/refresh', forward);
  app.all('/live-grid/prepared', forward);
  app.all('/live-grid/prepared/clear', forward);
  app.all('/live-grid/program-mode', forward);
  app.all('/live-grid/avatar-pip/sync', forward);
  app.all('/live-grid/stop', forward);
  app.all('/live-grid/roster', forward);
  app.all('/live-grid/operator-mode', forward);
  app.all('/live-grid/audio', forward);
  app.all('/live-grid/audio/panic-mute', forward);
  app.all('/live-grid/audio/unmute', forward);
  app.all('/live-grid/youtube-sync', forward);
  app.all('/live-grid/master-refresh', forward);
  app.all('/live-grid/reload-encode', forward);
  app.all('/live-grid/refresh-youtube-seo', forward);
  app.all('/live-grid/status', forward);
  app.all('/live-grid/program/status', forward);
  app.all(/^\/live-grid\/quadrant\/\d+\/file$/, forward);
  app.all(/^\/live-grid\/quadrant\/\d+\/url$/, forward);
  app.all(/^\/live-grid\/quadrant\/\d+\/channel$/, forward);
  app.all(/^\/live-grid\/quadrant\/\d+\/replace$/, forward);
  app.all(/^\/live-grid\/quadrant\/\d+\/unlock$/, forward);
}

module.exports = {
  isEnabled,
  sidecarBaseUrl,
  request,
  getStatus,
  mountProxy,
};
