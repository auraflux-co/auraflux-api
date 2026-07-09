'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildFcpxml } = require('../lib/composition_fcpxml');

describe('composition_fcpxml', () => {
  it('builds fcpxml with clip assets', () => {
    const xml = buildFcpxml({
      title: 'Test Comp',
      clips: [{ title: 'Clip A', url: 'file:///a.mp4', trimStart: 5, trimEnd: 35, duration: 60 }],
    });
    assert.ok(xml.includes('fcpxml version="1.9"'));
    assert.ok(xml.includes('Clip A'));
    assert.ok(xml.includes('asset-clip'));
  });
});
