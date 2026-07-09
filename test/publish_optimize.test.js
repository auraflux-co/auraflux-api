'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scorePublishMetadata } = require('../lib/publish_optimize');

describe('publish_optimize', () => {
  it('scores strong metadata higher', () => {
    const strong = scorePublishMetadata({
      title: 'Mind-Blowing Game Still OPEN? Defying All Logic Today',
      description: 'A'.repeat(200) + ' #gaming #twitch',
      tags: ['a', 'b', 'c', 'd', 'e'],
      primaryKeyword: 'gaming',
      hasThumbnail: true,
    });
    assert.ok(strong.score >= 75);
    assert.equal(strong.label, 'Strong');
  });

  it('flags thin metadata', () => {
    const weak = scorePublishMetadata({ title: 'Hi', description: '', tags: [] });
    assert.ok(weak.score < 60);
    assert.ok(weak.fixes.length > 0);
  });
});
