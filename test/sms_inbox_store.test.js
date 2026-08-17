'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { persistInboundSms } = require('../lib/services/sms_inbox_store');

test('persistInboundSms skips when from or to missing', async () => {
  assert.equal(await persistInboundSms({ from: '+1', to: '', body: 'hi' }), null);
  assert.equal(await persistInboundSms({ from: '', to: '+14375231177', body: 'hi' }), null);
});
