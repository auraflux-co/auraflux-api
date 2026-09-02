'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  isDualSourceStackMode,
  resolveTrimWindow,
  resolvePaneLabels,
  assembleDualSourceStack,
} = require('../lib/clip_comp_dual_source');
const {
  mergeCompCreative,
  finalizeCompCreativeForAssembly,
  getCompLineupTarget,
} = require('../lib/clip_comp_creative');

function localFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  if (fs.existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg')) {
    return '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
  }
  return '/opt/homebrew/bin/ffmpeg';
}

// Prefer drawtext-capable ffmpeg for dual-source assemble (labels)
process.env.FFMPEG_PATH = localFfmpeg();

describe('clip_comp_dual_source', () => {
  it('detects dual mode from preset or layout', () => {
    assert.strictEqual(isDualSourceStackMode({ preset: 'dual_source_stack' }), true);
    assert.strictEqual(isDualSourceStackMode({ layout: { mode: 'dual_source_vstack' } }), true);
    assert.strictEqual(isDualSourceStackMode({ preset: 'full_bleed' }), false);
  });

  it('resolves trim window and labels', () => {
    const w = resolveTrimWindow({ trimStart: 5, trimEnd: 25 }, 120);
    assert.strictEqual(w.seek, 5);
    assert.strictEqual(w.playDur, 20);
    const labels = resolvePaneLabels({ layout: { paneLabels: { top: 'Age 7', bottom: 'Age 16' } } });
    assert.strictEqual(labels.top, 'Age 7');
    assert.strictEqual(labels.bottom, 'Age 16');
  });

  it('creative preset is 2-clip dual_source_vstack', () => {
    const c = mergeCompCreative({ preset: 'dual_source_stack' });
    assert.strictEqual(c.preset, 'dual_source_stack');
    assert.strictEqual(c.layout.mode, 'dual_source_vstack');
    const target = getCompLineupTarget('dual_source_stack');
    assert.strictEqual(target.minClips, 2);
    assert.strictEqual(target.maxClips, 2);
    const locked = finalizeCompCreativeForAssembly(c, { clipOrientations: ['portrait', 'portrait'] });
    assert.strictEqual(locked.layout.mode, 'dual_source_vstack');
    assert.strictEqual(locked.layout.landscapeSplit, false);
  });

  it('assembles hold-then-switch stack (ffmpeg smoke)', async function () {
    this.timeout(120000);
    const tmp = path.join(__dirname, '..', 'tmp', 'dual_source_test');
    fs.mkdirSync(tmp, { recursive: true });
    const top = path.join(tmp, 'top.mp4');
    const bottom = path.join(tmp, 'bottom.mp4');
    const ff = localFfmpeg();
    // 6s solid color clips with tone
    execFileSync(ff, [
      '-f', 'lavfi', '-i', 'color=c=red:s=720x1280:d=6',
      '-f', 'lavfi', '-i', 'sine=f=440:d=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', top,
    ], { stdio: 'ignore' });
    execFileSync(ff, [
      '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:d=6',
      '-f', 'lavfi', '-i', 'sine=f=880:d=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', bottom,
    ], { stdio: 'ignore' });

    const creative = mergeCompCreative({
      preset: 'dual_source_stack',
      overrides: {
        layout: {
          switchAtSec: 2,
          paneLabels: { top: 'Age 7', bottom: 'Age 16' },
        },
      },
    });
    const out = await assembleDualSourceStack({
      clipFiles: [top, bottom],
      clipMetas: [
        { trimStart: 0, trimEnd: 2 },
        { trimStart: 0, trimEnd: 2 },
      ],
      compCreative: creative,
      asmId: 'test_dual',
      tmpDir: tmp,
      log: () => {},
    });
    assert.ok(fs.existsSync(out.outputPath));
    assert.ok(Math.abs(out.switchSec - 2) < 0.05);
    assert.ok(out.totalDur >= 3.5 && out.totalDur <= 4.5);
  });
});