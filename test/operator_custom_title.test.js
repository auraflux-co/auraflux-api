'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOperatorTitle,
  applyOperatorCustomTitle,
  selectPublishTitle,
} = require('../lib/operator_publish_titles');

test('normalizeOperatorTitle appends #Shorts for Shorts jobs', () => {
  assert.equal(normalizeOperatorTitle('Card declined at counter'), 'Card declined at counter #Shorts');
});

test('applyOperatorCustomTitle updates publishCopy and titleCandidates', () => {
  const card = {
    clipsOnly: true,
    contentType: 'twitch-short',
    publishCopy: { youtube: { titles: ['Old Title #Shorts'] } },
  };
  const result = applyOperatorCustomTitle(card, 'My Custom Title');
  assert.equal(result.ok, true);
  assert.equal(result.title, 'My Custom Title #Shorts');
  assert.equal(card.publishCopy.youtube.title, 'My Custom Title #Shorts');
  assert.equal(card.titleCandidates[0].operatorCustom, true);
  assert.equal(card.titleCandidates[0].selected, true);
});

test('selectPublishTitle picks SEO candidate by index', () => {
  const card = {
    clipsOnly: true,
    titleCandidates: [
      { text: 'A #Shorts', source: 'SEO', selected: false },
      { text: 'B #Shorts', source: 'SEO', selected: false },
    ],
    publishCopy: { youtube: { titles: ['A #Shorts', 'B #Shorts'] } },
  };
  const result = selectPublishTitle(card, 1);
  assert.equal(result.ok, true);
  assert.equal(result.title, 'B #Shorts');
  assert.equal(card.publishCopy.youtube.title, 'B #Shorts');
});
