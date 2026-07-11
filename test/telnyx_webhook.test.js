'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ORIGINAL_KEY = process.env.TELNYX_PUBLIC_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

let publicKeyB64;
let privateKey;

before(() => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  publicKeyB64 = spki.subarray(-32).toString('base64');
  privateKey = pair.privateKey;
  process.env.TELNYX_PUBLIC_KEY = publicKeyB64;
  process.env.NODE_ENV = 'test';
});

after(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.TELNYX_PUBLIC_KEY;
  else process.env.TELNYX_PUBLIC_KEY = ORIGINAL_KEY;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

function signPayload(body, timestamp) {
  const signed = `${timestamp}|${body}`;
  const sig = crypto.sign(null, Buffer.from(signed), privateKey);
  return sig.toString('base64');
}

test('validateWebhook accepts signed payload when rawBody is preserved', async () => {
  const { validateWebhook } = require('../lib/sms/adapters/telnyx');
  const body = JSON.stringify({
    data: {
      event_type: 'message.received',
      payload: {
        from: { phone_number: '+15551234567' },
        to:   [{ phone_number: '+15559876543' }],
        text: 'Your code is 123456',
      },
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signPayload(body, timestamp);
  const rawBuf = Buffer.from(body, 'utf8');

  const req = {
    path: '/support/sms-webhook',
    headers: {
      'telnyx-signature-ed25519': signature,
      'telnyx-timestamp': timestamp,
    },
    rawBody: rawBuf,
    body: JSON.parse(body),
  };

  const ok = await validateWebhook(req);
  assert.equal(ok, true);
});

test('validateWebhook rejects tampered body without rawBody', async () => {
  const { validateWebhook } = require('../lib/sms/adapters/telnyx');
  const body = JSON.stringify({ data: { event_type: 'message.received' } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signPayload(body, timestamp);

  const req = {
    path: '/support/sms-webhook',
    headers: {
      'telnyx-signature-ed25519': signature,
      'telnyx-timestamp': timestamp,
    },
    body: { data: { event_type: 'message.received', tampered: true } },
  };

  const ok = await validateWebhook(req);
  assert.equal(ok, false);
});
