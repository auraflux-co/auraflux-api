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
});

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
