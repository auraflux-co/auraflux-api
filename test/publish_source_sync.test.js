'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('publish source sync', () => {
  it('detects when local file is newer than last R2 sync', () => {
    const { isLocalPublishSourceSynced } = require('../lib/assembly_r2_persist');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-sync-'));
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, 'v1');
    const st = fs.statSync(file);
    const card = {
      outputPath: file,
      driveUrl: 'https://assets.example/outputs/job/clip.mp4',
      driveUrlLocalMtime: st.mtimeMs,
      driveUrlLocalSize: st.size,
    };
    assert.equal(isLocalPublishSourceSynced(card), true);
    fs.writeFileSync(file, 'v2-longer-content');
    assert.equal(isLocalPublishSourceSynced(card), false);
  });
});
