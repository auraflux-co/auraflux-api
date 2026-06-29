'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOperatorTitle,
  applyOperatorCustomTitle,
  reapplyOperatorTitleIfLocked,
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

test('reapplyOperatorTitleIfLocked restores selected custom title after SEO overwrite', () => {
  const card = {
    clipsOnly: true,
    contentType: 'twitch-short',
    operatorTitleLocked: true,
    title: "#Funnymike's Before and After Streamer U Interview",
    titleCandidates: [
      { text: "#Funnymike's Before and After Streamer U Interview #Shorts", selected: true, operatorCustom: true },
      { text: 'SEO Title #Shorts', selected: false, source: 'SEO' },
    ],
    publishCopy: { youtube: { title: 'SEO Title #Shorts' } },
  };
  reapplyOperatorTitleIfLocked(card);
  assert.equal(card.publishCopy.youtube.title, "#Funnymike's Before and After Streamer U Interview #Shorts");
});

test('long-form twitch custom title does not append #Shorts', () => {
  const card = {
    contentType: 'twitch',
    formType: 'compilation',
    publishCopy: { youtube: { titles: ['Jason\'s Spelling Bee Slip Stuns Crew'] } },
  };
  const result = applyOperatorCustomTitle(card, 'Spell Check Disaster Leaves Jason Speechless');
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Spell Check Disaster Leaves Jason Speechless');
  assert.ok(!/#Shorts/i.test(card.publishCopy.youtube.title));
});
