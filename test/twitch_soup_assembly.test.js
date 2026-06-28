'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupSegmentsByLabel } = require('../lib/assembly');
const { normalizeHeygenVideoJobs } = require('../lib/heygen_video_jobs');
const { resolveContainsSyntheticMediaForPublish } = require('../lib/publish_synthetic');

test('twitch soup groups by streamer not 4-segment chunks', () => {
  const segs = [
    { label: 'INTRO', type: 'avatar' },
    { label: 'LACY_INTRO', type: 'avatar' },
    { label: 'LACY_CLIP1_SETUP', type: 'avatar' },
    { label: 'LACY_CLIP1_REACTION', type: 'avatar' },
    { label: 'LACY_CLIP2_SETUP', type: 'avatar' },
    { label: 'LACY_CLIP2_REACTION', type: 'avatar' },
    { label: 'JASON_INTRO', type: 'avatar' },
    { label: 'JASON_CLIP1_SETUP', type: 'avatar' },
    { label: 'JASON_CLIP1_REACTION', type: 'avatar' },
    { label: 'OUTRO', type: 'avatar' },
  ];
  const groups = groupSegmentsByLabel(segs);
  assert.equal(groups[0].groupId, 'intro');
  assert.equal(groups[1].groupId, 'LACY');
  assert.equal(groups[1].indices.length, 5);
  assert.equal(groups[1].itemIdx, 0);
  assert.equal(groups[2].groupId, 'JASON');
  assert.equal(groups[2].indices.length, 3);
  assert.equal(groups[2].itemIdx, 1);
  assert.equal(groups[3].groupId, 'outro');
});

test('normalizeHeygenVideoJobs fixes stale sceneIndex and sort order', () => {
  const card = {
    script: {
      scenes: [
        { name: 'INTRO' },
        { name: 'JASON_INTRO' },
        { name: 'JASON_CLIP1_REACTION' },
      ],
    },
    heygen: {
      videoJobs: [
        { sceneName: 'JASON_INTRO', sceneIndex: 8 },
        { sceneName: 'INTRO', sceneIndex: 0 },
        { sceneName: 'JASON_CLIP1_REACTION', sceneIndex: 8 },
      ],
    },
  };
  const { jobs, changed } = normalizeHeygenVideoJobs(card);
  assert.equal(changed, true);
  assert.deepEqual(
    jobs.map((j) => [j.sceneIndex, j.sceneName]),
    [[0, 'INTRO'], [1, 'JASON_INTRO'], [2, 'JASON_CLIP1_REACTION']]
  );
});

test('twitch publish config disables synthetic media disclosure', () => {
  assert.equal(
    resolveContainsSyntheticMediaForPublish({ contentType: 'twitch', heygen: { videoJobs: [{}] } }, {}),
    false
  );
});
