'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { coldOpenPhraseFromSetup } = require('../lib/twitch_bookends');

describe('cold open phrase', () => {
  it('does not double ExtraEmily + Emily', () => {
    const phrase = coldOpenPhraseFromSetup(
      'Emily is enjoying a relaxing day on the water, until the local watercraft gets too close.',
      'ExtraEmily'
    );
    assert.doesNotMatch(phrase, /ExtraEmily emily/i);
    assert.match(phrase, /^Emily /i);
  });

  it('uses phonetic Yawn-uh without Yonna prefix', () => {
    const phrase = coldOpenPhraseFromSetup(
      'Yawn-uh is enjoying a day at the water park and decides to get comfortable on stream.',
      'Yonna'
    );
    assert.doesNotMatch(phrase, /Yonna yawn/i);
    assert.match(phrase, /^Yawn-uh /i);
  });
});
