'use strict';

/**
 * C0-only scrape routes (sports/news/twitch pickers) must not mount on C1+ API.
 * Set C0_LOCALHOST=1 on auraflux-c0 pm2; set C0_LOCALHOST=0 on Render auraflux-api.
 */
function isC0Localhost() {
  const flag = String(process.env.C0_LOCALHOST || '').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  // Backward compat: localhost C0 server has no Postgres; C1+ Render always has DATABASE_URL.
  return !process.env.DATABASE_URL;
}

function requireC0Localhost(req, res, next) {
  if (isC0Localhost()) return next();
  return res.status(404).json({
    ok: false,
    error: 'C0-only route — sports/news source scraping is not available on C1+ API',
  });
}

module.exports = { isC0Localhost, requireC0Localhost };
