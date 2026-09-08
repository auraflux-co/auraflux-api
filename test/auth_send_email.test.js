/**
 * Auth email helper smoke tests (no live SMTP).
 * Run: node --test test/auth_send_email.test.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function isSmtpConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

describe('isSmtpConfigured', () => {
  const prevUser = process.env.SMTP_USER;
  const prevPass = process.env.SMTP_PASS;

  beforeEach(() => {
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  afterEach(() => {
    if (prevUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = prevUser;
    if (prevPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = prevPass;
  });

  it('false when unset', () => {
    assert.equal(isSmtpConfigured(), false);
  });

  it('true when user+pass set', () => {
    process.env.SMTP_USER = 'a@b.co';
    process.env.SMTP_PASS = 'x';
    assert.equal(isSmtpConfigured(), true);
  });
});
