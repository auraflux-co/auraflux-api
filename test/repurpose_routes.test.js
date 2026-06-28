'use strict';

/**
 * Integration tests for Repurpose / post-live routes (CPD-1132).
 * Uses isolated VOD session store via env override pattern — backs up real store.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'post_live_vod_sessions.json');
const STORE_BAK = path.join(__dirname, '..', 'data', 'post_live_vod_sessions.testbak.json');

const PUBLISHED_CARD = {
  contentType: 'twitch',
  stage: 'published',
  title: 'Test Talk Soup Episode',
  customerId: 'c0',
  heygenShowKey: 'talkSoup',
  publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  postAssemblyRundown: {
    totalSec: 120,
    entries: [
      { segmentLabel: 'INTRO', startSec: 0, endSec: 15, durationSec: 15 },
      { segmentLabel: 'JASON_CLIP1', startSec: 15, endSec: 45, durationSec: 30 },
      { segmentLabel: 'OUTRO', startSec: 45, endSec: 60, durationSec: 15 },
    ],
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(require('../lib/routes/post_live'));
  return app;
}

async function request(app, method, url, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const opts = {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      };
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('repurpose routes', () => {
  let prevStore;
  let prevJobs;

  before(() => {
    if (fs.existsSync(STORE_PATH)) {
      prevStore = fs.readFileSync(STORE_PATH, 'utf8');
      fs.writeFileSync(STORE_BAK, prevStore);
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify({ version: 1, sessions: {} }, null, 2));
    prevJobs = global.persistedJobsRef;
    global.persistedJobsRef = {
      script_twitch_test_pub: PUBLISHED_CARD,
      script_twitch_awaiting: {
        contentType: 'twitch',
        stage: 'awaiting_review',
        publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=abc12345678' },
      },
    };
  });

  after(() => {
    global.persistedJobsRef = prevJobs;
    if (prevStore != null) fs.writeFileSync(STORE_PATH, prevStore);
    else if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    if (fs.existsSync(STORE_BAK)) fs.unlinkSync(STORE_BAK);
  });

  it('GET /post-live/published-jobs lists eligible long-form jobs', async () => {
    const app = buildApp();
    const res = await request(app, 'GET', '/post-live/published-jobs?limit=10');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.jobs.some((j) => j.jobId === 'script_twitch_test_pub'));
    const job = res.body.jobs.find((j) => j.jobId === 'script_twitch_test_pub');
    assert.equal(job.repurposeMode, 'scene');
    assert.equal(job.showLabel, 'Talk Soup');
  });

  it('POST register-from-job seeds scene_ready session', async () => {
    const app = buildApp();
    const res = await request(app, 'POST', '/post-live/sessions/register-from-job', {
      jobId: 'script_twitch_test_pub',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.videoId, 'dQw4w9WgXcQ');
    assert.ok(res.body.sceneCount >= 1);
    assert.equal(res.body.session.sessionKind, 'published_long_form');
    assert.equal(res.body.session.repurposeMode, 'scene');
  });

  it('POST register-from-job rejects non-published job', async () => {
    const app = buildApp();
    const res = await request(app, 'POST', '/post-live/sessions/register-from-job', {
      jobId: 'script_twitch_awaiting',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
  });

  it('POST manual-clips adds timestamp windows to live session', async () => {
    const app = buildApp();
    const reg = await request(app, 'POST', '/post-live/vods/register', {
      videoId: 'liveTestVid01',
      title: 'Test Live VOD',
      url: 'https://www.youtube.com/watch?v=liveTestVid01',
      durationSec: 3600,
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.session.repurposeMode, 'timestamp');

    const add = await request(app, 'POST', '/post-live/sessions/liveTestVid01/manual-clips', {
      start_s: '1:00',
      end_s: '1:30',
      title: 'Highlight',
    });
    assert.equal(add.status, 200);
    assert.equal(add.body.ok, true);
    assert.equal(add.body.added, 1);
    assert.equal(add.body.sceneCount, 1);
    assert.equal(add.body.session.analyzeStatus, 'scene_ready');
    assert.equal(add.body.session.sceneCandidates[0].source, 'manual_timestamp');
  });
});

describe('scene-order-preflight contract', () => {
  it('buildSceneOrderPreflight includes heygen show fields when card present', () => {
    const { buildSceneOrderPreflight } = require('../lib/scene_order_gate');
    const script = '=== INTRO ===\nHi\n\n=== OUTRO ===\nBye';
    const card = {
      contentType: 'twitch',
      customerId: 'c0',
      postAssemblyRundown: {
        entries: [
          { segmentLabel: 'INTRO', startSec: 0, endSec: 10, durationSec: 10 },
        ],
      },
    };
    const pre = buildSceneOrderPreflight({ card, script });
    assert.equal(pre.ok, true);
    assert.ok(pre.totalDurationSec >= 10);
    assert.equal(pre.rows[0].durationSec, 10);
  });
});
