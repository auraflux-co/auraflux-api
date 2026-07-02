'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_intelligence_routes.db');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(require('../lib/routes/intelligence'));
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

describe('intelligence routes (CPD-1193)', () => {
  let prevC0;
  let prevDb;

  before(() => {
    prevC0 = process.env.C0_LOCALHOST;
    prevDb = process.env.CWN_DB_PATH;
    process.env.C0_LOCALHOST = '1';
    process.env.CWN_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    require('../lib/db').initDb();
  });

  after(() => {
    require('../lib/db').closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (prevDb === undefined) delete process.env.CWN_DB_PATH;
    else process.env.CWN_DB_PATH = prevDb;
    if (prevC0 === undefined) delete process.env.C0_LOCALHOST;
    else process.env.C0_LOCALHOST = prevC0;
  });

  it('GET /intelligence/stats returns memory stats', async () => {
    const res = await request(buildApp(), 'GET', '/intelligence/stats');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.stats);
    assert.equal(typeof res.body.stats.total, 'number');
  });

  it('GET /intelligence/recommend-context returns learning hints', async () => {
    const res = await request(buildApp(), 'GET', '/intelligence/recommend-context?contentType=twitch');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.hints));
  });

  // CPD-1218 — model self-scoring endpoint
  it('GET /intelligence/prediction-accuracy returns summary shape', async () => {
    const res = await request(buildApp(), 'GET', '/intelligence/prediction-accuracy');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.n, 'number');
    assert.equal(typeof res.body.pending, 'number');
    assert.ok(Array.isArray(res.body.rows));
    assert.ok(Array.isArray(res.body.misses));
  });

  // CPD-1219 phase 2 — streamer search skips without API key
  it('POST /intelligence/competitors/search-streamers skips without YOUTUBE_API_KEY', async () => {
    const prevKey = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const res = await request(buildApp(), 'POST', '/intelligence/competitors/search-streamers', {});
      assert.equal(res.status, 200);
      assert.equal(res.body.skipped, true);
    } finally {
      if (prevKey !== undefined) process.env.YOUTUBE_API_KEY = prevKey;
    }
  });

  it('returns 404 when C0_LOCALHOST=0', async () => {
    process.env.C0_LOCALHOST = '0';
    const res = await request(buildApp(), 'GET', '/intelligence/stats');
    assert.equal(res.status, 404);
    process.env.C0_LOCALHOST = '1';
  });
});
