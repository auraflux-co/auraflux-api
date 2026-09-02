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

  it('places labels in the same relative spot on each pane', () => {
    const { resolvePaneLabelPlacement, buildDualPaneLabelFilter } = require('../lib/clip_comp_dual_source');
    const top = resolvePaneLabelPlacement({ layout: { paneLabelAnchor: 'top' } });
    assert.strictEqual(top.anchor, 'top');
    assert.ok(top.topY < 100);
    assert.ok(top.bottomY > 960 && top.bottomY < 1100);
    assert.strictEqual(top.bottomY - top.topY, 960); // same inset in each half
    const bot = resolvePaneLabelPlacement({ layout: { paneLabelAnchor: 'bottom' } });
    assert.strictEqual(bot.anchor, 'bottom');
    assert.ok(bot.topY < 960);
    assert.ok(bot.bottomY > 1700);
    const filt = buildDualPaneLabelFilter({
      layout: { paneLabels: { top: 'Age 7', bottom: 'Age 16' }, paneLabelAnchor: 'top' },
    });
    assert.ok(filt.includes("text='Age 7'"));
    assert.ok(filt.includes("text='Age 16'"));
    assert.ok(filt.includes('box=1'));
  });

  it('enriches C11 SEO brief from Age labels (not Local import Twitch)', async () => {
    const { enrichDualSourceSeoBrief } = require('../lib/clip_comp_dual_source');
    const card = {
      compCreative: {
        preset: 'dual_source_stack',
        layout: { mode: 'dual_source_vstack', paneLabels: { top: 'Age 7', bottom: 'Age 16' } },
      },
      orderedClipUrls: [
        { title: 'reel_upscaled_1080x1920', displayName: 'Local import', url: 'local://cwn_import_1.mp4', game: 'import' },
        { title: 'youtube import 6JD5Vzpa29g', displayName: 'yt_paste', pageUrl: 'https://www.youtube.com/shorts/6JD5Vzpa29g' },
      ],
      clipCompBrief: { clips: [], leadStreamer: 'Local import' },
    };
    const brief = await enrichDualSourceSeoBrief(card);
    assert.ok(brief.leadTitleDraft.includes('Age 7'));
    assert.ok(brief.leadTitleDraft.includes('Age 16'));
    assert.ok(!/Local import/i.test(brief.leadStreamer));
    assert.ok(!/Local import/i.test(brief.leadTitleDraft));
    assert.strictEqual(brief.clips[1].platform, 'youtube');
    // oEmbed should replace "youtube import …" with real title when network available
    assert.ok(brief.clips[1].platformTitle);
    assert.ok(!/^youtube\s*import/i.test(brief.clips[1].platformTitle));
    assert.ok(brief.dualSourceStack);
    assert.ok(brief.sourceVideoPreferred);
  });

  it('finalize locks music bed off for dual_source_stack', () => {
    const c = finalizeCompCreativeForAssembly(
      mergeCompCreative({
        preset: 'dual_source_stack',
        overrides: { audio: { musicBed: 'low_trap' } },
      }),
      { clipOrientations: ['portrait', 'portrait'] },
    );
    assert.strictEqual(c.audio.musicBed, 'off');
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

  it('assembles hold-then-switch stack (ffmpeg smoke)', async () => {
    jest.setTimeout(120000);
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
    assert.strictEqual(out.hasBottomAudio, true);
  });
});