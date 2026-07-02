'use strict';

const assert = require('assert');
const { buildGate1StyleQaPrompt } = require('../lib/portals/portal1');

const jobSpec = {
  contentType: 'twitch',
  order: {
    inputs: {
      items: [
        {
          displayName: 'Cinna',
          handle: 'cinna',
          clips: [{ title: 'cinna crashing out' }],
        },
      ],
    },
  },
};

const { qaPrompt } = buildGate1StyleQaPrompt(jobSpec, '=== INTRO ===\nHi\n', {});

assert.match(qaPrompt, /Do NOT set fabricationFound for these unless they CONTRADICT/i);
assert.match(qaPrompt, /softAccuracyIssues/i);
assert.ok(!/names a game not in AUTHORIZED FACTS → flag as fabrication/i.test(qaPrompt));

console.log('portal1_twitch_fabrication_soft.test.js: ok');
