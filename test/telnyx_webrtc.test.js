'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sipUri, phonePageUrl, getAppPublicUrl } = require('../lib/services/telnyx_webrtc');
const { lineKeyFromNumber } = require('../lib/services/telnyx_voice_control');

test('sipUri builds Telnyx SIP destination', () => {
  assert.equal(sipUri('userabc'), 'sip:userabc@sip.telnyx.com');
  assert.equal(sipUri(''), null);
});

test('phonePageUrl encodes dial and line query params', () => {
  const url = phonePageUrl({ dial: '+15551234567', line: '437' });
  assert.match(url, /\/phone\?/);
  assert.match(url, /dial=%2B15551234567/);
  assert.match(url, /line=437/);
});

test('lineKeyFromNumber maps AuraFlux lines', () => {
  assert.equal(lineKeyFromNumber('+14375231177'), '437');
  assert.equal(lineKeyFromNumber('+15716002835'), '571');
  assert.equal(lineKeyFromNumber('+19998887777'), null);
});

test('getAppPublicUrl strips trailing slash', () => {
  const prev = process.env.APP_PUBLIC_URL;
  process.env.APP_PUBLIC_URL = 'https://app.auraflux.co/';
  assert.equal(getAppPublicUrl(), 'https://app.auraflux.co');
  if (prev === undefined) delete process.env.APP_PUBLIC_URL;
  else process.env.APP_PUBLIC_URL = prev;
});
