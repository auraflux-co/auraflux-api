'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAurafluxLine, parseCallingArgs } = require('../lib/services/telnyx_line_routing');
const { normalizeDialNumber } = require('../lib/services/slack_slash_call');

test('resolveAurafluxLine maps 437 and 571', () => {
  assert.equal(resolveAurafluxLine('437'), '+14375231177');
  assert.equal(resolveAurafluxLine('571'), '+15716002835');
});

test('parseCallingArgs requires line prefix', () => {
  assert.deepEqual(
    parseCallingArgs('437 5714497652', normalizeDialNumber),
    { from: '+14375231177', to: '+15714497652' },
  );
  assert.equal(parseCallingArgs('5714497652', normalizeDialNumber), null);
});
