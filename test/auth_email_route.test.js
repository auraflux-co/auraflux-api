/**
 * Unit tests for /internal/auth-email helpers (no live SMTP / express).
 * Run: node --test test/auth_email_route.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function smtpConfigured(env = process.env) {
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

describe('auth_email helpers', () => {
  it('secretsMatch rejects missing/mismatch', () => {
    assert.equal(secretsMatch(null, 'secret'), false);
    assert.equal(secretsMatch('a', 'b'), false);
    assert.equal(secretsMatch('secret', 'secret'), true);
  });

  it('smtpConfigured requires host+user+pass', () => {
    assert.equal(smtpConfigured({}), false);
    assert.equal(
      smtpConfigured({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }),
      true,
    );
  });

  it('route file registers /internal/auth-email', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../lib/routes/auth_email.js'),
      'utf8',
    );
    assert.match(src, /\/internal\/auth-email/);
    assert.match(src, /x-auraflux-api-secret/);
    assert.match(src, /AURAFLUX_API_SECRET/);
  });
});
