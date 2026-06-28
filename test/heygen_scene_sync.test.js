'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePipelineHeyGenTitle,
  captureHeygenBaseline,
  diffHeygenSceneOverrides,
  runTagFromJobId,
} = require('../lib/heygen_scene_sync');

describe('heygen_scene_sync', () => {
  it('parses pipeline HeyGen title idx_ct_scene_runTag', () => {
    const p = parsePipelineHeyGenTitle('09_tw_JASON_CLIP2_SETUP_782513992551');
    assert.equal(p.sceneIndex, 9);
    assert.equal(p.contentTypeTag, 'tw');
    assert.equal(p.sceneName, 'JASON_CLIP2_SETUP');
    assert.equal(p.runTag, '782513992551');
  });

  it('runTagFromJobId uses last 12 chars', () => {
    assert.equal(runTagFromJobId('script_twitch_1782513992551'), '782513992551');
  });

  it('diff detects newer created_at for same scene', () => {
    const card = {
      jobId: 'script_twitch_1782513992551',
      assemblyId: 'asm_r32',
      heygen: {
        videoJobs: [
          { sceneName: 'JASON_CLIP2_SETUP', sceneIndex: 9, video_id: 'old_id', video_url: 'http://old' },
          { sceneName: 'INTRO', sceneIndex: 0, video_id: 'intro_id', video_url: 'http://intro' },
        ],
        baseline: null,
      },
    };
    card.heygen.baseline = captureHeygenBaseline(card, [
      { video_id: 'old_id', created_at: 1000, title: '09_tw_JASON_CLIP2_SETUP_782513992551', status: 'completed' },
      { video_id: 'intro_id', created_at: 1000, title: '00_tw_INTRO_782513992551', status: 'completed' },
    ]);

    const diff = diffHeygenSceneOverrides(card, [
      {
        video_id: 'new_id',
        created_at: 5000,
        title: '09_tw_JASON_CLIP2_SETUP_782513992551',
        status: 'completed',
        video_url: 'http://new',
      },
      {
        video_id: 'intro_id',
        created_at: 1000,
        title: '00_tw_INTRO_782513992551',
        status: 'completed',
        video_url: 'http://intro',
      },
    ]);

    assert.equal(diff.ok, true);
    assert.equal(diff.overrideCount, 1);
    assert.equal(diff.overrides[0].sceneName, 'JASON_CLIP2_SETUP');
    assert.equal(diff.overrides[0].reason, 'new_video_id');
  });
});
