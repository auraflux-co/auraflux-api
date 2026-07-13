'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  outboundLineForInbound,
  outboundLineForDestination,
} = require('../lib/services/telnyx_line_routing');

test('CA inbound → US outbound', () => {
  assert.equal(outboundLineForInbound('+14375231177'), '+15716002835');
  assert.equal(outboundLineForInbound('+15716002835'), '+14375231177');
});

test('US dest → US line, CA dest → CA line for blind dial', () => {
  assert.equal(outboundLineForDestination('+15714497652'), '+15716002835');
  assert.equal(outboundLineForDestination('+14375551234'), '+14375231177');
});
