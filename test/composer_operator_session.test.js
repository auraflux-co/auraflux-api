'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('operator composer session round-trips openingLayout', () => {
  const modPath = require.resolve('../lib/composer_operator_session');
  delete require.cache[modPath];
  const orig = path.join(__dirname, '../data/composer_operator_session.json');
  const backup = fs.existsSync(orig) ? fs.readFileSync(orig, 'utf8') : null;
  const {
    writeOperatorComposerSession,
    readOperatorComposerSession,
    clearOperatorComposerSession,
  } = require('../lib/composer_operator_session');
  try {
    const saved = writeOperatorComposerSession({
      version: 1,
      streamers: [{
        name: 'speedyboykins7869',
        displayName: 'Speedy Boykins',
        selected: true,
        clips: [{
          url: 'https://www.youtube.com/watch?v=REekcufpbdc',
          selected: true,
          title: 'iShowSpeed Becomes Spider-Man On Fortnite',
          openingLayout: { mode: 'split_screen', topHeight: 960, operatorIntent: true },
        }],
      }],
      compCreative: { preset: 'fableflow_speed' },
    });
    assert.equal(saved.version, 1);
    const read = readOperatorComposerSession();
    assert.ok(read);
    assert.equal(read.streamers[0].clips[0].openingLayout.mode, 'split_screen');
    assert.equal(read.streamers[0].clips[0].title, 'iShowSpeed Becomes Spider-Man On Fortnite');

    const overwritten = writeOperatorComposerSession({
      version: 1,
      streamers: [{
        name: 'speedyboykins7869',
        selected: true,
        clips: [{
          url: 'https://www.youtube.com/watch?v=REekcufpbdc',
          selected: true,
          openingLayout: {
            mode: 'split_screen',
            topHeight: 960,
            facecamRect: { x: 0.4, y: 0.23, w: 0.36, h: 0.57 },
          },
        }],
      }],
      compCreative: { preset: 'classic_blur_pad' },
    });
    assert.equal(overwritten.streamers[0].clips[0].openingLayout.operatorIntent, true);
    assert.equal(overwritten.compCreative.preset, 'fableflow_speed');
  } finally {
    if (backup != null) fs.writeFileSync(orig, backup);
    else clearOperatorComposerSession();
    delete require.cache[modPath];
  }
});
