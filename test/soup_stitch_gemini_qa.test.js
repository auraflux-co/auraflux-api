'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  joinTypeHint,
  parseJoinQaResponse,
  PASS_SCORE,
} = require('../lib/soup_stitch_gemini_qa');

test('joinTypeHint covers hold_cut and handoff', () => {
  assert.match(joinTypeHint('LACY_INTRO', 'LACY_CLIP1_SETUP', 'hold_cut'), /hold last frame/i);
  assert.match(joinTypeHint('LACY_CLIP2_REACTION', 'JASON_INTRO', 'hold_cut'), /hold-cut handoff/i);
});

test('parseJoinQaResponse accepts JSON and computes pass', () => {
  const raw = JSON.stringify({
    smoothness_score: 88,
    pass: true,
    video_issues: ['none'],
    audio_issues: ['none'],
    join_center_feel: 'smooth',
    summary: 'Clean join',
    recommendation: 'keep_policy',
  });
  const r = parseJoinQaResponse(raw);
  assert.equal(r.pass, true);
  assert.equal(r.smoothness_score, 88);
  assert.equal(r.recommendation, 'keep_policy');
});

test('parseJoinQaResponse fails on ghost even with high score', () => {
  const raw = JSON.stringify({
    smoothness_score: 80,
    pass: true,
    video_issues: ['ghost'],
    audio_issues: ['none'],
    join_center_feel: 'muddy_blend',
    summary: 'Double image',
    recommendation: 'hard_cut_video',
  });
  const r = parseJoinQaResponse(raw);
  assert.equal(r.pass, false);
});

test('parseJoinQaResponse handles malformed output', () => {
  const r = parseJoinQaResponse('not json at all');
  assert.equal(r.pass, false);
  assert.ok(r.video_issues.includes('parse_error'));
});

test('parseJoinQaResponse salvages truncated JSON', () => {
  const raw = '{\n  "smoothness_score": 65,\n  "pass": false,\n  "video_issues": ["pose_jump"],\n  "summary": "Noticeable pose jump at cut';
  const r = parseJoinQaResponse(raw);
  assert.equal(r.smoothness_score, 65);
  assert.equal(r.pass, false);
});
