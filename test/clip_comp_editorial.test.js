'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  editorialEnabled,
  isEditorialContentType,
  fillTemplate,
  formatEditorialDate,
  buildSpokenScripts,
  fallbackPlan,
  resolveTemplateKey,
} = require('../lib/clip_comp_editorial');
const { isEditorialContentType: timelineEligible } = require('../lib/clip_comp_timeline');

describe('clip_comp_editorial', () => {
  test('isEditorialContentType — sports and news only', () => {
    assert.equal(isEditorialContentType('sports-short'), true);
    assert.equal(isEditorialContentType('news-short'), true);
    assert.equal(isEditorialContentType('twitch-short'), false);
    assert.equal(timelineEligible('twitch-short'), false);
  });

  test('fillTemplate substitutes vars', () => {
    const out = fillTemplate('News for {dateLong}. {topic}.', { dateLong: 'June 15', topic: 'NHL OT' });
    assert.ok(out.includes('June 15'));
    assert.ok(out.includes('NHL OT'));
  });

  test('formatEditorialDate returns ET dateLine', () => {
    const { dateLine, dateLong } = formatEditorialDate(new Date('2026-06-15T12:00:00Z'));
    assert.ok(dateLine.length > 5);
    assert.equal(dateLine, dateLong);
  });

  test('buildSpokenScripts uses ClipzWorld News not sub-show names', () => {
    const scripts = buildSpokenScripts('sports-short', { topic: 'playoff overtime' });
    assert.ok(scripts.introText.includes('ClipzWorld News'));
    assert.ok(!scripts.introText.includes('Other Side'));
    assert.ok(!scripts.introText.includes('Pillow'));
    assert.equal(scripts.categoryLabel, 'SPORTS HIGHLIGHTS');
    assert.equal(scripts.networkBrand, 'ClipzWorld News');
    assert.equal(scripts.handle, '@clipzworldnews');
  });

  test('fallbackPlan generates bridges between clips', () => {
    const plan = fallbackPlan('news-short', [
      { title: 'Story A' },
      { title: 'Story B' },
      { title: 'Story C' },
    ]);
    assert.equal(plan.bridges.length, 2);
    assert.ok(plan.topic);
  });

  test('resolveTemplateKey maps nba to sports', () => {
    assert.equal(resolveTemplateKey('nba-short'), 'sports');
    assert.equal(resolveTemplateKey('news-short'), 'news');
  });

  test('editorialEnabled defaults on', () => {
    const prev = process.env.CLIP_COMP_EDITORIAL;
    delete process.env.CLIP_COMP_EDITORIAL;
    assert.equal(editorialEnabled(), true);
    process.env.CLIP_COMP_EDITORIAL = 'off';
    assert.equal(editorialEnabled(), false);
    if (prev === undefined) delete process.env.CLIP_COMP_EDITORIAL;
    else process.env.CLIP_COMP_EDITORIAL = prev;
  });
});
