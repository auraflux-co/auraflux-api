'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('partial_scene_reassemble', () => {
  let tmpRoot;
  let jobId;
  let origManualRoot;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-scene-'));
    jobId = 'script_test_partial_001';
    origManualRoot = process.env.C0_MANUAL_SEGMENTS_ROOT;
    process.env.C0_MANUAL_SEGMENTS_ROOT = tmpRoot;
  });

  afterEach(() => {
    if (origManualRoot === undefined) delete process.env.C0_MANUAL_SEGMENTS_ROOT;
    else process.env.C0_MANUAL_SEGMENTS_ROOT = origManualRoot;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function card() {
    return {
      jobId,
      contentType: 'twitch',
      heygen: {
        avatarId: 'e481249929c141b1a7450da2bf519614',
        videoJobs: [
          { sceneName: 'INTRO', video_url: 'https://example.com/intro.mp4' },
          { sceneName: 'JASON_CLIP2_SETUP', video_url: 'https://example.com/j2s.mp4' },
          { sceneName: 'RON_CLIP2_SETUP', video_url: 'https://example.com/r2s.mp4' },
        ],
      },
      script: {
        scenes: [
          { name: 'INTRO', type: 'avatar' },
          { name: 'JASON_CLIP2_SETUP', type: 'avatar', hasClipInsert: true },
          { name: 'JASON_CLIP2_REACTION', type: 'avatar' },
          { name: 'RON_CLIP2_SETUP', type: 'avatar', hasClipInsert: true },
        ],
      },
      orderedClipUrls: [{ url: 'https://example.com/clip.mp4' }],
    };
  }

  it('blocks stray root manual files without partial mode', () => {
    const {
      getManualDir,
      getSceneUpdatesDir,
      countManualAvatarFilesOutsideSceneUpdates,
      validatePartialSceneUpdateApply,
    } = require('../lib/partial_scene_reassemble');

    const root = getManualDir(jobId);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '00_avatar_intro.mp4'), Buffer.alloc(20000));

    assert.equal(countManualAvatarFilesOutsideSceneUpdates(jobId), 1);
    const v = validatePartialSceneUpdateApply(jobId, card());
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('scene_updates')));
  });

  it('discovers overrides only in scene_updates/', () => {
    const {
      getSceneUpdatesDir,
      discoverSceneUpdateOverrides,
      validatePartialSceneUpdateApply,
    } = require('../lib/partial_scene_reassemble');

    const dir = getSceneUpdatesDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    const nested = path.join(dir, '09_tw_JASON_CLIP2_SETUP_782513992551');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'out.mp4'), Buffer.alloc(20000));

    const d = discoverSceneUpdateOverrides(jobId, card());
    assert.ok(d.labels.includes('JASON_CLIP2_SETUP'));
    const v = validatePartialSceneUpdateApply(jobId, card(), { explicitLabels: ['JASON_CLIP2_SETUP'] });
    assert.equal(v.ok, true);
  });

  it('applyManualOverrides partial mode ignores root manual files', () => {
    const { getManualDir, getSceneUpdatesDir } = require('../lib/partial_scene_reassemble');
    const { applyManualOverrides } = require('../lib/manual_segment_workflow');

    const root = getManualDir(jobId);
    const updates = getSceneUpdatesDir(jobId);
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(updates, { recursive: true });
    fs.writeFileSync(path.join(root, '00_avatar_intro.mp4'), Buffer.alloc(20000));
    const nested = path.join(updates, '09_tw_JASON_CLIP2_SETUP_782513992551');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'out.mp4'), Buffer.alloc(20000));

    const segs = [
      { type: 'avatar', label: 'INTRO', url: 'https://example.com/intro.mp4' },
      { type: 'avatar', label: 'JASON_CLIP2_SETUP', url: 'https://example.com/old.mp4' },
    ];
    const applied = applyManualOverrides(jobId, segs, {
      partialSceneLabels: ['JASON_CLIP2_SETUP'],
      searchDir: updates,
    });
    assert.equal(applied.overrideCount, 1);
    assert.match(applied.segmentData[0].url, /^https:/);
    assert.ok(applied.segmentData[1].localCache?.includes('scene_updates'));
  });
});
