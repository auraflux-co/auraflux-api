'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('long-form group concat uses xfade helper wired to transition param', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /async function concatMediaWithTransition\(/);
  assert.match(src, /xfade=transition=/);
  assert.match(src, /acrossfade=d=/);
  assert.match(src, /concatTsToMp4 = async \(tsList, outMp4, encodeAudio = true, trans = transition\)/);
  assert.match(src, /concatMediaWithTransition\(stitchPaths, stitchTmp/);
});

test('concatMediaWithTransition is exported for integration tests', () => {
  const { concatMediaWithTransition } = require('../lib/assembly');
  assert.equal(typeof concatMediaWithTransition, 'function');
});
