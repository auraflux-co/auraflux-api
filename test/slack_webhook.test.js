'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { escapeMrkdwn, sanitizePlainText, slackLinkButton } = require('../lib/services/slack_webhook');
const { extractVerificationCode } = require('../lib/services/telnyx_slack_notify');

test('escapeMrkdwn escapes Slack-special characters', () => {
  assert.equal(escapeMrkdwn('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('sanitizePlainText strips control characters', () => {
  assert.equal(sanitizePlainText('hello\x00world'), 'helloworld');
});

test('slackLinkButton has no style field (avoids Slack 400)', () => {
  const btn = slackLinkButton('Open', 'https://example.com');
  assert.equal(btn.type, 'button');
  assert.equal(btn.url, 'https://example.com');
  assert.equal('style' in btn, false);
});

test('extractVerificationCode finds numeric codes', () => {
  assert.equal(extractVerificationCode('179969 is your YouTube verification code'), '179969');
  assert.equal(extractVerificationCode('[TikTok] 421449 is your code'), '421449');
});
