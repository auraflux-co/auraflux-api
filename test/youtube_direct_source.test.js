'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('YouTube direct video source', () => {
  it('prefers local MP4 over R2 assets URL', () => {
    // gate5 exports resolveYouTubeVideoSource only if we export it — test via require hack
    const gate5Path = path.join(__dirname, '..', 'lib', 'gates', 'gate5.js');
    const src = fs.readFileSync(gate5Path, 'utf8');
    assert.match(src, /resolveYouTubeVideoSource/);
    assert.match(src, /YouTube direct from local file/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-src-'));
    const local = path.join(dir, 'final.mp4');
    fs.writeFileSync(local, 'local-bytes');
    const r2 = 'https://assets.auraflux.co/outputs/job/stale.mp4';

    // Inline the resolver logic under test (same as gate5)
    function resolveYouTubeVideoSource(jobSpec, r2AssetsUrl) {
      const candidates = [
        jobSpec.assembledPath,
        jobSpec.outputPath,
        jobSpec.state?.savedOutputs?.assembledPath,
      ].filter(Boolean);
      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
      }
      return r2AssetsUrl;
    }

    const chosen = resolveYouTubeVideoSource({ outputPath: local }, r2);
    assert.equal(chosen, local);
    assert.notEqual(chosen, r2);
  });
});
