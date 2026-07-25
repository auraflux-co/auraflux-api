'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ffmpegPath } = require('../lib/ffmpeg_utils');
const {
  normalizeShakes,
  buildShakeFilter,
  buildCameraFxFilter,
  applyCameraFx,
} = require('../lib/camera_fx');
const {
  normalizeSpeedRamps,
  buildSpeedPlan,
  buildAtempoChain,
  buildSetpts,
  applySpeedRamps,
  constantSpeedFilters,
} = require('../lib/speed_ramps');
const {
  peaksFromPcm,
  suggestionsFromPeaks,
} = require('../lib/beat_detect');
const { VIDEO_EFFECTS, AUDIO_EFFECTS, buildVideoFilterChain } = require('../lib/assembly_effects');

describe('CPD-1280 camera shake', () => {
  it('normalizes shakes and builds crop wobble filter', () => {
    const shakes = normalizeShakes({
      enabled: true,
      shakes: [{ atSec: 1.2, duration: 0.3, intensity: 1.2 }],
    });
    assert.equal(shakes.length, 1);
    const frag = buildShakeFilter(shakes);
    assert.match(frag, /^crop=/);
    assert.match(frag, /between\(t/);
  });

  it('camera_shake effect returns filter when enabled', () => {
    const frag = VIDEO_EFFECTS.camera_shake({
      effects: { video: { camera_shake: { enabled: true, atSec: 2, intensity: 1 } } },
    });
    assert.ok(frag && frag.includes('crop='));
  });

  it('combines punch + shake', () => {
    const frag = buildCameraFxFilter({
      zoomPunch: { enabled: true, atSec: 1, zoom: 1.25, duration: 0.3 },
      cameraShake: { enabled: true, atSec: 1, intensity: 1 },
      width: 320,
      height: 568,
      fps: 24,
    });
    assert.match(frag, /zoompan=/);
    assert.match(frag, /crop=/);
  });
});

describe('CPD-1281 speed ramps', () => {
  it('builds atempo chains for extreme factors', () => {
    assert.equal(buildAtempoChain(1), null);
    assert.match(buildAtempoChain(1.5), /atempo=1\.5000/);
    assert.match(buildAtempoChain(3), /atempo=2\.0/);
    assert.match(buildAtempoChain(0.25), /atempo=0\.5/);
  });

  it('fills speed plan with 1× gaps', () => {
    const plan = buildSpeedPlan(
      [{ startSec: 2, endSec: 4, factor: 1.5 }],
      10,
    );
    assert.equal(plan.length, 3);
    assert.equal(plan[0].factor, 1);
    assert.equal(plan[1].factor, 1.5);
    assert.equal(plan[2].factor, 1);
  });

  it('speed_ramp video + audio sync from video.speedRamp', () => {
    const vf = VIDEO_EFFECTS.speed_ramp({ effects: { video: { speedRamp: 1.5 } } });
    const af = AUDIO_EFFECTS.speed({ effects: { video: { speedRamp: 1.5 } } });
    assert.ok(vf && vf.includes('setpts='));
    assert.ok(af && af.includes('atempo='));
  });

  it('constantSpeedFilters matches registry', () => {
    const { vf, af } = constantSpeedFilters(2);
    assert.equal(vf, buildSetpts(2));
    assert.equal(af, buildAtempoChain(2));
  });
});

describe('CPD-1282 beat peaks → suggestions', () => {
  it('picks peaks from synthetic PCM bursts', () => {
    const sampleRate = 8000;
    const seconds = 4;
    const samples = new Int16Array(sampleRate * seconds);
    // Quiet bed
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.01) * 200;
    // Burst at 1.0s and 2.5s
    for (const t of [1.0, 2.5]) {
      const start = Math.floor(t * sampleRate);
      for (let i = 0; i < 800; i++) samples[start + i] = Math.sin(i * 0.4) * 20000;
    }
    const pcm = Buffer.from(samples.buffer);
    const peaks = peaksFromPcm(pcm, { sampleRate, minGapSec: 0.5, maxPeaks: 4, thresholdRatio: 1.2 });
    assert.ok(peaks.length >= 2, `expected ≥2 peaks, got ${peaks.length}`);
    const sug = suggestionsFromPeaks(peaks);
    assert.ok(sug.zoomPunch?.punches?.length >= 2);
    assert.ok(sug.cameraShake?.shakes?.length >= 2);
  });
});

describe('CPD-1280/1281 ffmpeg smoke', () => {
  it('applies shake and 1.5× speed to a short color clip', async () => {
    // Docker Desktop may be down in local test runs — prefer Homebrew for smoke.
    if (!process.env.FFMPEG_PATH && fs.existsSync('/opt/homebrew/bin/ffmpeg')) {
      process.env.FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';
    }
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cpd1280-'));
    const src = path.join(dir, 'src.mp4');
    const shook = path.join(dir, 'shake.mp4');
    const sped = path.join(dir, 'speed.mp4');
    execFileSync(ffmpegPath(), [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=2',
      '-f', 'lavfi', '-i', 'sine=f=440:d=2',
      '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac',
      src,
    ], { stdio: 'ignore' });

    await applyCameraFx(src, shook, {
      cameraShake: { enabled: true, atSec: 0.5, duration: 0.35, intensity: 1.2 },
      width: 640,
      height: 360,
      fps: 24,
      previewFast: true,
    });
    assert.ok(fs.statSync(shook).size > 1000);

    await applySpeedRamps(src, sped, [{ startSec: 0.5, endSec: 1.5, factor: 1.5 }], { previewFast: true });
    assert.ok(fs.statSync(sped).size > 1000);

    const chain = buildVideoFilterChain({
      effects: {
        video: {
          zoom_punch: { enabled: true, atSec: 0.4, zoom: 1.2 },
          camera_shake: { enabled: true, atSec: 0.4, intensity: 1 },
        },
      },
    });
    assert.ok(chain.includes('zoompan=') || chain.includes('crop='));
  });
});
