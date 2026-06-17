'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { categorizeTitle } = require('../lib/services/channel_stats');

test('categorizeTitle detects streaming', () => {
  assert.equal(categorizeTitle('#lacy on #Twitch | Salad'), 'Streaming');
});

test('categorizeTitle detects sports', () => {
  assert.equal(categorizeTitle('Knicks Battle the 76ers | Full Highlights'), 'Sports');
});

test('categorizeTitle detects news', () => {
  assert.equal(categorizeTitle('June 12 News Roundup | Global Stories'), 'News');
});

test('categorizeTitle detects streaming personalities not in legacy keyword list', () => {
  assert.equal(categorizeTitle('Jay Cinco & Lala Baptiste Baby Shower Celebration'), 'Streaming');
  assert.equal(categorizeTitle('Marlon & IShowspeed Did What?'), 'Streaming');
  assert.equal(categorizeTitle('YonnaJay CHILLING w/ @bendadonnn @jaycinco Stream'), 'Streaming');
  assert.equal(categorizeTitle('Did Jason Lose?'), 'Streaming');
});

test('categorizeTitle defaults non-news/sports to Streaming', () => {
  assert.equal(categorizeTitle('Random clip title with no keywords'), 'Streaming');
});
