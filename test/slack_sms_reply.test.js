'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifySlackRequest } = require('../lib/services/slack_bot');

function signSlackBody(secret, timestamp, raw) {
  const base = `v0:${timestamp}:${raw}`;
  return `v0=${crypto.createHmac('sha256', secret).update(base).digest('hex')}`;
}

test('verifySlackRequest accepts valid Slack signature', () => {
  const secret = 'test-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
  const signature = signSlackBody(secret, timestamp, raw);

  const prev = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = secret;
  try {
    const ok = verifySlackRequest({
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      rawBody: Buffer.from(raw, 'utf8'),
      body: JSON.parse(raw),
    });
    assert.equal(ok, true);
  } finally {
    process.env.SLACK_SIGNING_SECRET = prev;
  }
});

test('verifySlackRequest rejects tampered body', () => {
  const secret = 'test-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ type: 'event_callback' });
  const signature = signSlackBody(secret, timestamp, raw);

  const prev = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = secret;
  try {
    const ok = verifySlackRequest({
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      rawBody: Buffer.from(JSON.stringify({ type: 'tampered' }), 'utf8'),
      body: { type: 'tampered' },
    });
    assert.equal(ok, false);
  } finally {
    process.env.SLACK_SIGNING_SECRET = prev;
  }
});

test('extractEventText reads plain message text', () => {
  const { extractEventText } = require('../lib/services/slack_sms_reply');
  assert.equal(extractEventText({ text: 'hello there' }), 'hello there');
});

test('verifySlackRequest rejects stale timestamps', () => {
  const secret = 'test-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
  const raw = JSON.stringify({ type: 'event_callback' });
  const signature = signSlackBody(secret, timestamp, raw);

  const prev = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = secret;
  try {
    const ok = verifySlackRequest({
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      rawBody: Buffer.from(raw, 'utf8'),
      body: JSON.parse(raw),
    });
    assert.equal(ok, false);
  } finally {
    process.env.SLACK_SIGNING_SECRET = prev;
  }
});
