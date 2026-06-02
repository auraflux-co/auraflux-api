'use strict';
const assert  = require('assert');
const express = require('express');
const request = require('supertest');

// Stub auth middleware
jest.mock('../lib/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'test-superadmin' }; next(); },
  requireRole: () => (req, _res, next) => next(),
  ROLES: { CUSTOMER: 1, SUPERADMIN: 100 },
}));

// Stub postgres query
const rows = [];
jest.mock('../lib/db/postgres', () => ({
  query: jest.fn(async (sql, params) => {
    if (sql.startsWith('SELECT page_key')) {
      return { rows };
    }
    if (sql.startsWith('SELECT key')) {
      return { rows: rows.filter(r => r.page_key === params[0]).map(r => ({ ...r })) };
    }
    if (sql.startsWith('INSERT')) {
      const existing = rows.findIndex(r => r.page_key === params[0] && r.key === params[1]);
      const row = { page_key: params[0], key: params[1], value: params[2], updated_by: params[3], updated_at: new Date().toISOString() };
      if (existing >= 0) rows[existing] = row; else rows.push(row);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE')) {
      const idx = rows.findIndex(r => r.page_key === params[0] && r.key === params[1]);
      if (idx >= 0) rows.splice(idx, 1);
      return { rows: [] };
    }
    return { rows: [] };
  }),
}));

const router = require('../lib/routes/app_content');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('app_content routes', () => {
  const app = buildApp();

  it('GET /api/admin/app-content returns empty content map', async () => {
    const res = await request(app).get('/api/admin/app-content');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.content, {});
  });

  it('POST /api/admin/app-content upserts an override', async () => {
    const res = await request(app)
      .post('/api/admin/app-content')
      .send({ page_key: 'myjobs', key: 'empty_state_title', value: 'Nothing here yet' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.key, 'empty_state_title');
  });

  it('GET /api/admin/app-content/:page returns page overrides', async () => {
    const res = await request(app).get('/api/admin/app-content/myjobs');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.overrides.length, 1);
    assert.strictEqual(res.body.overrides[0].key, 'empty_state_title');
  });

  it('DELETE /api/admin/app-content/:page/:key removes the override', async () => {
    const res = await request(app).delete('/api/admin/app-content/myjobs/empty_state_title');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.reset, true);
  });

  it('POST requires page_key, key, value', async () => {
    const res = await request(app).post('/api/admin/app-content').send({ key: 'x' });
    assert.strictEqual(res.status, 400);
  });
});
