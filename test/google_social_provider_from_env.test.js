/**
 * Unit tests for Google OAuth env helper (Better Auth Continue with Google).
 * Run: node --test test/google_social_provider_from_env.test.js
 *
 * Mirrors app/src/lib/auth/server.ts googleSocialProviderFromEnv — keep in sync.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function googleSocialProviderFromEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, prompt: 'select_account' };
}

describe('googleSocialProviderFromEnv', () => {
  const prevId = process.env.GOOGLE_CLIENT_ID;
  const prevSecret = process.env.GOOGLE_CLIENT_SECRET;

  beforeEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });

  afterEach(() => {
    if (prevId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = prevSecret;
  });

  it('returns null when credentials missing', () => {
    assert.equal(googleSocialProviderFromEnv(), null);
  });

  it('returns null when only client id set', () => {
    process.env.GOOGLE_CLIENT_ID = 'id-only';
    assert.equal(googleSocialProviderFromEnv(), null);
  });

  it('returns google provider when both set', () => {
    process.env.GOOGLE_CLIENT_ID = '  cid  ';
    process.env.GOOGLE_CLIENT_SECRET = '  csec  ';
    assert.deepEqual(googleSocialProviderFromEnv(), {
      clientId: 'cid',
      clientSecret: 'csec',
      prompt: 'select_account',
    });
  });
});
