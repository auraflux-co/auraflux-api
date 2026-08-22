'use strict';
/**
 * Short-lived HS256 JWTs for AuraFlux API bearer auth (Better Auth sessions).
 * Issued by the Next app (/api/auth/token); verified by requireAuth on the API.
 */
const crypto = require('crypto');

function _b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function _secret() {
  return (
    process.env.AUTH_JWT_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    process.env.CLERK_SECRET_KEY ||
    ''
  );
}

function signAuthJwt(claims, { expiresInSec = 3600 } = {}) {
  const secret = _secret();
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_JWT_SECRET / BETTER_AUTH_SECRET not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = _b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = _b64url(
    JSON.stringify({
      ...claims,
      iat: now,
      exp: now + expiresInSec,
      iss: 'auraflux',
    }),
  );
  const data = `${header}.${payload}`;
  const sig = _b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyAuthJwt(token) {
  const secret = _secret();
  if (!secret || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const data = `${header}.${payload}`;
  const expected = _b64url(crypto.createHmac('sha256', secret).update(data).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!body?.sub || !body?.exp) return null;
  if (body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

module.exports = { signAuthJwt, verifyAuthJwt };
