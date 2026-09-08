/**
 * Superadmin email allowlist tests.
 * Run: node --test test/superadmin_emails.test.js
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const DEFAULT =
  'support@auraflux.co,robert@auraflux.co,robert@businessrocket.ai';

function parseSuperadminEmails(raw) {
  return (raw || DEFAULT)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isSuperadminEmail(email, raw) {
  if (!email) return false;
  return parseSuperadminEmails(raw).includes(email.trim().toLowerCase());
}

describe('superadmin emails', () => {
  const prev = process.env.AURAFLUX_SUPERADMIN_EMAILS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AURAFLUX_SUPERADMIN_EMAILS;
    else process.env.AURAFLUX_SUPERADMIN_EMAILS = prev;
  });

  it('defaults include robert@businessrocket.ai', () => {
    assert.equal(isSuperadminEmail('robert@businessrocket.ai'), true);
    assert.equal(isSuperadminEmail('Robert@BusinessRocket.ai'), true);
    assert.equal(isSuperadminEmail('robert@auraflux.co'), true);
    assert.equal(isSuperadminEmail('customer@example.com'), false);
  });

  it('honours env override', () => {
    assert.equal(
      isSuperadminEmail('only@example.com', 'only@example.com'),
      true,
    );
    assert.equal(
      isSuperadminEmail('robert@businessrocket.ai', 'only@example.com'),
      false,
    );
  });
});
