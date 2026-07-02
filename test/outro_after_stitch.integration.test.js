'use strict';

/**
 * Integration — outro-after-stitch (CPD-1127)
 * Simulates body-only partial reassemble output + appendCreditsOutroToVideo.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PRE_OUTRO = path.join(ROOT, 'output/twitch_soup_jason_s_spelling_bee_world_c_8clips_script_twitch_1782513992551_pre_outro.mp4');
const BODY_TARGET_SEC = 448.433;

describe('outro after stitch integration', { skip: !fs.existsSync(PRE_OUTRO) ? 'pre_outro backup missing' : false }, () => {
  it('appends env outro to body-only MP4 → ~478s, not double-stacked', async (t) => {
    const db = require('../lib/db');
    const { appendCreditsOutroToVideo, probeDurationSec } = require('../lib/twitch_bookends');
    const { ffmpegPath } = require('../lib/ffmpeg_utils');

    const jobId = 'script_twitch_1782513992551';
    const card = db.loadJob(jobId);
    if (!card) {
      t.skip('fixture job card no longer in SQLite — historical job purged');
      return;
    }
    const asmId = `test_outro_${Date.now()}`;
    const bodyOnly = path.join(ROOT, 'tmp', `${asmId}_body_only.mp4`);

    execFileSync(ffmpegPath(), [
      '-i', PRE_OUTRO,
      '-t', String(BODY_TARGET_SEC),
      '-c', 'copy',
      '-y', bodyOnly,
    ], { stdio: 'pipe' });

    const bodyDur = await probeDurationSec(bodyOnly);
    assert.ok(bodyDur >= 447 && bodyDur <= 450, `body should be ~448s, got ${bodyDur}`);

    const desc = card?.publishCopy?.youtube?.description
      || card?.state?.savedOutputs?.publishCopy?.youtube?.description;
    assert.ok(desc?.trim()?.length > 20, 'job card must have publishCopy for outro scroll');

    const res = await appendCreditsOutroToVideo({
      mainMp4Path: bodyOnly,
      card,
      asmId,
      customerId: 'c0',
      log: () => {},
    });
    assert.equal(res.appended, true, `append failed: ${res.reason || 'unknown'}`);

    const after = await probeDurationSec(bodyOnly);
    const delta = after - bodyDur;
    assert.ok(delta >= 25 && delta <= 35, `outro delta should be ~27-30s, got ${delta.toFixed(2)}`);
    assert.ok(after >= 473 && after <= 485, `total should be ~478s, got ${after}`);

    const res2 = await appendCreditsOutroToVideo({
      mainMp4Path: bodyOnly,
      card,
      asmId: `${asmId}_dup`,
      customerId: 'c0',
      log: () => {},
    });
    const after2 = await probeDurationSec(bodyOnly);
    assert.equal(res2.appended, false, 'second append must be skipped (idempotent)');
    assert.equal(res2.reason, 'duration_suggests_credits_present');
    assert.ok(Math.abs(after2 - after) < 0.5, 'duration must not grow on duplicate append');

    try { fs.unlinkSync(bodyOnly); } catch (_) {}
  });

  it('assembly.js has early outro path and post-SEO skip when already appended', () => {
    const asmSrc = fs.readFileSync(path.join(ROOT, 'lib/assembly.js'), 'utf8');
    assert.match(asmSrc, /Outro appended after stitch/);
    assert.match(asmSrc, /!assemblyJobs\[asmId\]\?\.creditsOutroAppended/);
  });

  it('publish path blocks Twitch Soup long-form without creditsOutroAppended', () => {
    const gate5Js = fs.readFileSync(path.join(ROOT, 'lib/gates/gate5.js'), 'utf8');
    const guardJs = fs.readFileSync(path.join(ROOT, 'lib/operator_creative_guard.js'), 'utf8');
    assert.match(gate5Js, /creditsOutroAppended/);
    assert.match(gate5Js, /assertTwitchSoupPublishReady/);
    assert.match(guardJs, /credits_outro_missing/);
  });
});
