'use strict';

// CPD-1210 — view prediction on clip candidates

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.CWN_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'predict-test-')), 'test.db');

const { getDb } = require('../lib/db');
const memory = require('../lib/intelligence/memory');
const predict = require('../lib/intelligence/predict');

function seedVideo({ title, streamer, views, tags = [] }) {
  memory.upsertVideo({
    platform: 'youtube',
    platformVideoId: 'vid_' + Math.random().toString(36).slice(2),
    jobId: 'job_' + Math.random().toString(36).slice(2),
    title,
    contentType: 'twitch-short',
    streamer,
    formFactor: 'short',
    metadata: { tags },
    performance: { views },
  });
}

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM content_memory_videos').run();
  db.prepare('DELETE FROM content_memory_decisions').run();
  db.prepare('DELETE FROM library_clips').run();
  db.prepare('DELETE FROM competitor_videos').run();
});

function seedCompetitorVideo({ channel, videoId, title, views, streamers }) {
  getDb().prepare(`
    INSERT INTO competitor_videos (platform, channel_handle, video_id, title, views, duration_sec, is_short, first_seen_at, fetched_at, streamers)
    VALUES ('youtube', ?, ?, ?, ?, 30, 1, ?, ?, ?)
  `).run(channel, videoId, title, views, Date.now(), Date.now(), JSON.stringify(streamers));
}

test('scoreCandidates: streamer with strong history scores higher than unknown', () => {
  seedVideo({ title: 'Hasan Reacts to Wild Drama', streamer: 'hasanabi', views: 50000, tags: ['drama', 'react'] });
  seedVideo({ title: 'Hasan Loses It On Stream', streamer: 'hasanabi', views: 40000 });
  seedVideo({ title: 'Quiet chess endgame analysis', streamer: 'gothamchess', views: 500 });

  const scored = predict.scoreCandidates([
    { title: 'Hasan Reacts to Insane Drama Again', streamer: 'hasanabi', views: 12000, clipCreatedAt: Date.now() - 3600000 },
    { title: 'Some brand new streamer moment', streamer: 'nobody_yet', views: 10, clipCreatedAt: Date.now() - 30 * 86400000 },
  ]);

  assert.equal(scored.length, 2);
  assert.ok(scored[0].prediction.score > scored[1].prediction.score);
  assert.ok(scored[0].prediction.reasons.length >= 2);
  assert.ok(['Very High', 'High', 'Medium', 'Low'].includes(scored[0].prediction.band));
});

test('scoreCandidates: empty memory still returns bands without crashing', () => {
  const scored = predict.scoreCandidates([
    { title: 'Fresh clip', streamer: 'anyone', views: 100, clipCreatedAt: Date.now() },
  ]);
  assert.equal(scored.length, 1);
  assert.ok(scored[0].prediction.score >= 0);
  assert.ok(scored[0].prediction.band);
});

test('recordPredictionsForJob: records once per job from library clips, dedupes', () => {
  seedVideo({ title: 'Hasan Reacts to Wild Drama', streamer: 'hasanabi', views: 50000 });
  const db = getDb();
  db.prepare(`
    INSERT INTO library_clips (clip_id, url, platform, streamer, title, views, duration_sec, clip_created_at, fetched_at, used_at, job_id)
    VALUES ('c1', 'https://clips.twitch.tv/c1', 'twitch', 'hasanabi', 'Hasan Reacts Again', 9000, 30, ?, ?, ?, 'job_predict_1')
  `).run(Date.now() - 3600000, Date.now(), Date.now());

  const first = predict.recordPredictionsForJob('job_predict_1');
  assert.ok(first && first.id);
  const second = predict.recordPredictionsForJob('job_predict_1');
  assert.equal(second, null);

  const decisions = memory.listDecisions('job_predict_1');
  const preds = decisions.filter((d) => d.kind === 'view_prediction');
  assert.equal(preds.length, 1);
  assert.ok(preds[0].choice.band);
  assert.equal(preds[0].choice.streamer, 'hasanabi');
});

test('recordPredictionsForJob: no clips for job returns null', () => {
  assert.equal(predict.recordPredictionsForJob('job_without_clips'), null);
});

// CPD-1219 — factor 6: competitor echo

test('competitor echo raises score and exposes match details', () => {
  seedCompetitorVideo({ channel: 'DahBluh', videoId: 'cv1', title: 'ExtraEmily FREAKS OUT live', views: 1_800_000, streamers: ['extraemily'] });
  seedCompetitorVideo({ channel: 'DahBluh', videoId: 'cv2', title: 'ordinary clip', views: 100_000, streamers: [] });

  const candidate = { title: 'ExtraEmily freaks out at donation', streamer: 'extraemily', views: 5000, clipCreatedAt: Date.now() - 3600000 };
  const [withEcho] = predict.scoreCandidates([candidate]);
  assert.ok(withEcho.prediction.competitorEcho, 'expected competitorEcho on prediction');
  assert.equal(withEcho.prediction.competitorEcho.channel, 'DahBluh');
  assert.equal(withEcho.prediction.competitorEcho.views, 1_800_000);
  assert.ok(withEcho.prediction.reasons.some((r) => r.includes('Competitor echo')));

  getDb().prepare('DELETE FROM competitor_videos').run();
  const [without] = predict.scoreCandidates([candidate]);
  assert.equal(without.prediction.competitorEcho, null);
  assert.ok(withEcho.prediction.score > without.prediction.score, 'echo should raise the score');
});

test('competitor echo resolves candidate display name to canonical login', () => {
  seedCompetitorVideo({ channel: 'core_fx', videoId: 'cv3', title: 'Yonna goes crazy', views: 900_000, streamers: ['yonnajay'] });
  const [scored] = predict.scoreCandidates([
    { title: 'Yonna wild moment', streamer: 'Yonna', views: 100, clipCreatedAt: Date.now() },
  ]);
  assert.ok(scored.prediction.competitorEcho, 'display name should hit the canonical tag');
  assert.equal(scored.prediction.competitorEcho.channel, 'core_fx');
});

// CPD-1218 — prediction accuracy self-scoring

function seedReconciled({ jobId, band, score, views }) {
  const dec = memory.recordDecision({
    jobId,
    kind: 'view_prediction',
    choice: { title: 't', streamer: 's', score, band },
    reasons: [],
  });
  memory.updateDecisionOutcome(dec.id, { views });
}

test('predictionAccuracy: flags under- and over-estimates against quantile bands', () => {
  seedReconciled({ jobId: 'j1', band: 'Low', score: 20, views: 5000 });     // low predicted, top actual → under
  seedReconciled({ jobId: 'j2', band: 'Medium', score: 40, views: 300 });
  seedReconciled({ jobId: 'j3', band: 'Medium', score: 45, views: 250 });
  seedReconciled({ jobId: 'j4', band: 'High', score: 60, views: 400 });
  seedReconciled({ jobId: 'j5', band: 'Very High', score: 80, views: 10 }); // big predicted, bottom actual → over
  memory.recordDecision({ jobId: 'j6', kind: 'view_prediction', choice: { band: 'Low', score: 10 }, reasons: [] }); // unreconciled

  const acc = predict.predictionAccuracy();
  assert.equal(acc.n, 5);
  assert.equal(acc.pending, 1);
  assert.equal(acc.lowSample, false);
  const j1 = acc.rows.find((r) => r.jobId === 'j1');
  assert.equal(j1.verdict, 'under');
  const j5 = acc.rows.find((r) => r.jobId === 'j5');
  assert.equal(j5.verdict, 'over');
  assert.ok(acc.misses.length >= 2);
  assert.ok(acc.hitRate >= 0 && acc.hitRate <= 100);
});

test('predictionAccuracy: low sample counts everything as hit without banding', () => {
  seedReconciled({ jobId: 'j1', band: 'Low', score: 20, views: 5000 });
  seedReconciled({ jobId: 'j2', band: 'High', score: 60, views: 10 });
  const acc = predict.predictionAccuracy();
  assert.equal(acc.n, 2);
  assert.equal(acc.lowSample, true);
  assert.equal(acc.hitRate, 100);
  assert.equal(acc.misses.length, 0);
});

test('predictionAccuracy: empty table returns zeros', () => {
  const acc = predict.predictionAccuracy();
  assert.equal(acc.n, 0);
  assert.equal(acc.pending, 0);
  assert.equal(acc.hitRate, null);
});
