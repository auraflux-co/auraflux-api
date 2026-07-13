'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeState, decodeState } = require('../lib/services/telnyx_voice_control');

test('encodeState round-trips client_state payload', () => {
  const payload = { flow: 'outbound_operator', destination: '+15551234567' };
  assert.deepEqual(decodeState(encodeState(payload)), payload);
});
