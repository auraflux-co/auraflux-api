'use strict';

/**
 * Optional HTTP Basic Auth for C0 dashboard/API (tunnel sharing).
 * Off when BASIC_AUTH_USER or BASIC_AUTH_PASS is unset.
 */

const DEFAULT_EXEMPT = [
  '/health',
  '/connect/youtube/callback',
  '/connect/twitch',
  '/channels/callback/kick',
];

function parseExemptPaths(raw) {
  if (raw == null || String(raw).trim() === '') return DEFAULT_EXEMPT.slice();
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isExemptPath(pathname, exemptPaths) {
  const p = String(pathname || '').split('?')[0];
  return exemptPaths.some((ex) => p === ex || p.startsWith(ex + '/'));
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return require('crypto').timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function parseBasicAuth(header) {
  if (!header || typeof header !== 'string') return null;
  const m = /^Basic\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

/**
 * @param {object} opts
 * @param {string} opts.user
 * @param {string} opts.pass
 * @param {string[]} [opts.exemptPaths]
 * @param {string} [opts.realm]
 */
function createBasicAuthMiddleware({
  user,
  pass,
  exemptPaths = DEFAULT_EXEMPT,
  realm = 'CWN C0 Operator',
} = {}) {
  const expectedUser = String(user || '');
  const expectedPass = String(pass || '');
  const exempt = Array.isArray(exemptPaths) ? exemptPaths : DEFAULT_EXEMPT;

  return function basicAuthMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    if (isExemptPath(req.path || req.url, exempt)) return next();

    const creds = parseBasicAuth(req.headers.authorization);
    if (
      creds
      && timingSafeEqualStr(creds.user, expectedUser)
      && timingSafeEqualStr(creds.pass, expectedPass)
    ) {
      return next();
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${String(realm).replace(/"/g, '')}"`);
    res.status(401).type('text/plain').send('Authentication required');
  };
}

function basicAuthEnabled() {
  return !!(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS);
}

function createBasicAuthFromEnv() {
  if (!basicAuthEnabled()) return null;
  return createBasicAuthMiddleware({
    user: process.env.BASIC_AUTH_USER,
    pass: process.env.BASIC_AUTH_PASS,
    exemptPaths: parseExemptPaths(process.env.BASIC_AUTH_EXEMPT),
    realm: process.env.BASIC_AUTH_REALM || 'CWN C0 Operator',
  });
}

module.exports = {
  DEFAULT_EXEMPT,
  parseExemptPaths,
  isExemptPath,
  parseBasicAuth,
  createBasicAuthMiddleware,
  createBasicAuthFromEnv,
  basicAuthEnabled,
};
