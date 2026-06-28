'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildScaffoldRows,
  buildRepurposeSceneCandidates,
} = require('../lib/scene_scaffold_panel');

describe('scene_scaffold_panel', () => {
  const script = '=== INTRO ===\nHi\n\n=== JASON_CLIP1_SETUP ===\nSetup\n\n=== JASON_CLIP1 ===\nClip\n\n=== OUTRO ===\nBye';
  const rundown = {
    totalSec: 120,
    entries: [
      { segmentLabel: 'INTRO', startSec: 0, endSec: 10, durationSec: 10 },
      { segmentLabel: 'JASON_CLIP1_SETUP', startSec: 10, endSec: 25, durationSec: 15 },
      { segmentLabel: 'JASON_CLIP1', startSec: 25, endSec: 55, durationSec: 30 },
      { segmentLabel: 'OUTRO', startSec: 55, endSec: 60, durationSec: 5 },
    ],
  };

  it('buildScaffoldRows attaches rundown durations', () => {
    const s = buildScaffoldRows({ script, contentType: 'twitch', rundown });
    assert.equal(s.rows.length, 4);
    assert.equal(s.rows[2].durationSec, 30);
    assert.equal(s.totalDurationSec, 60);
  });

  it('buildRepurposeSceneCandidates picks clip scenes with timestamps', () => {
    const card = { contentType: 'twitch' };
    const r = buildRepurposeSceneCandidates({ card, rundown });
    assert.ok(r.candidates.length >= 1);
    const clip = r.candidates.find((c) => c.sceneLabel === 'JASON_CLIP1');
    assert.ok(clip);
    assert.equal(clip.start_s, 25);
    assert.equal(clip.durationSec, 30);
    assert.equal(r.targets.idealSec, 30);
  });
});
