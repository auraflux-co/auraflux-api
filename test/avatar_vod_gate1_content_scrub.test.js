'use strict';

const assert = require('assert');
const {
  prepareScriptForGate1,
  getLockedIntro,
  getLockedOutro,
} = require('../lib/scaffold');

const lockedIntro = getLockedIntro('clips-long');
const lockedOutro = getLockedOutro();

const inlineScript = [
  '=== INTRO ===Wrong opener.',
  '=== CINNA_INTRO ===First up Emily breaks something.',
  '=== OUTRO ===Bye.',
].join('\n');

const expectedHeaders = ['INTRO', 'CINNA_INTRO', 'OUTRO'];
const prepared = prepareScriptForGate1(inlineScript, {
  expectedHeaders,
  lockedIntro,
  lockedOutro,
  streamers: [{ streamer: 'extraemily', displayName: 'ExtraEmily' }],
});

assert.ok(prepared.includes(lockedIntro.substring(0, 40)), 'locked intro injected');
assert.ok(prepared.includes(lockedOutro.substring(0, 40)), 'locked outro injected');
assert.ok(prepared.includes('ExtraEmily'), 'Emily → ExtraEmily in spoken text');

const cinnaScript = '=== INTRO ===\nFirst up cinna does something wild.\n=== OUTRO ===\nBye.';
const cinnaPrep = prepareScriptForGate1(cinnaScript, {
  expectedHeaders: ['INTRO', 'OUTRO'],
  streamers: [{ streamer: 'cinna', displayName: 'Cinna' }],
});
assert.ok(cinnaPrep.includes('Cinna'), 'cinna → Cinna');
assert.ok(!/\bcinna\b/.test(cinnaPrep), 'no lowercase handle in spoken text');

console.log('avatar_vod_gate1_content_scrub.test.js: ok');
