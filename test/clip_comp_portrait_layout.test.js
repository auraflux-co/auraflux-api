'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Prefer host ffmpeg for lavfi fixtures — bin/ffmpeg-docker often lacks lavfi in CI/local.
const FFMPEG = process.env.FFMPEG_PATH
  || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : null)
  || require('../lib/ffmpeg_utils').ffmpegPath();
const FFPROBE = process.env.FFPROBE_PATH
  || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : null)
  || require('../lib/ffmpeg_utils').ffprobePath();

const {
  applyClipCompPortraitLayout,
  applyPortraitFullBleed,
  applyPortraitBlurPad,
} = require('../lib/assembly_postprocess');

function makeSample(outPath) {
  execFileSync(FFMPEG, [
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-y', outPath,
  ], { stdio: 'pipe' });
}

function probeWh(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' }).trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

test('clip-comp portrait layouts produce 9:16', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-portrait-'));
  const src = path.join(dir, 'src.mp4');
  makeSample(src);

  const bleed = path.join(dir, 'bleed.mp4');
  await applyPortraitFullBleed(src, bleed, { jobId: 't' });
  const b = probeWh(bleed);
  assert.equal(b.w, 720);
  assert.equal(b.h, 1280);

  const pad = path.join(dir, 'pad.mp4');
  await applyPortraitBlurPad(src, pad, { jobId: 't' });
  const p = probeWh(pad);
  assert.equal(p.w, 1080);
  assert.equal(p.h, 1920);

  const routed = path.join(dir, 'routed.mp4');
  await applyClipCompPortraitLayout(src, routed, {
    layoutMode: 'full_bleed_crop',
    lookName: 'punch',
    jobId: 't',
  });
  const r = probeWh(routed);
  assert.equal(r.w, 720);
  assert.equal(r.h, 1280);

  fs.rmSync(dir, { recursive: true, force: true });
});
