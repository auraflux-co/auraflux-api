'use strict';
/**
 * test/jobs_c1_list_get.test.js — GET /jobs list + operator ?all=true (CPD-132)
 */

const express = require('express');
const request = require('supertest');

jest.mock('../lib/job_spec', () => ({
  createJobSpec: jest.fn(),
}));

jest.mock('../lib/db', () => ({
  seedJobSpecFromScript: jest.fn(),
  saveJob: jest.fn(),
  listJobsByCustomer: jest.fn(),
  listAllJobRows: jest.fn(),
}));

jest.mock('../lib/portal_policy_runner', () => ({
  runPortalSequence: jest.fn(),
}));

const authState = {
  user: { id: 'cust_a', role: 'customer', planTier: 'diy' },
};

jest.mock('../lib/auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { ...authState.user };
    next();
  },
  requireRole: () => (req, res, next) => next(),
  ROLES: {
    CUSTOMER: 'customer',
    OPERATOR: 'operator',
    ADMIN:    'admin',
  },
}));

jest.mock('../lib/auth/brand_access', () => ({
  resolveBrandContext: (req, res, next) => next(),
}));

const { listJobsByCustomer, listAllJobRows } = require('../lib/db');
const router = require('../lib/routes/jobs_c1');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('GET /jobs — customer vs operator all=true (CPD-132)', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    authState.user = { id: 'cust_a', role: 'customer', planTier: 'diy' };
    listJobsByCustomer.mockResolvedValue([
      {
        id:               'job_one',
        customer_id:      'cust_a',
        job_spec:         JSON.stringify({ contentType: 'news', status: 'queued', planTier: 'diy' }),
        created_at:       '1700000000000',
        updated_at:       '1700000001000',
      },
    ]);
    listAllJobRows.mockResolvedValue([
      {
        id:               'job_all',
        customer_id:      'cust_other',
        job_spec:         JSON.stringify({ contentType: 'clips', status: 'queued', planTier: 'dwy' }),
        created_at:       '1700000000000',
        updated_at:       '1700000001000',
      },
    ]);
  });

  test('customer uses listJobsByCustomer (ignores all=true)', async () => {
    const res = await request(app).get('/jobs').query({ all: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(listJobsByCustomer).toHaveBeenCalledWith('cust_a', 50, null);
    expect(listAllJobRows).not.toHaveBeenCalled();
    expect(res.body.jobs[0].jobId).toBe('job_one');
  });

  test('operator without all=true uses listJobsByCustomer', async () => {
    authState.user = { id: 'op_1', role: 'superadmin', planTier: 'diy' };

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
    expect(listJobsByCustomer).toHaveBeenCalledWith('op_1', 50, null);
    expect(listAllJobRows).not.toHaveBeenCalled();
  });

  test('operator with all=true uses listAllJobRows(100)', async () => {
    authState.user = { id: 'op_1', role: 'superadmin', planTier: 'diy' };

    const res = await request(app).get('/jobs').query({ all: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(listAllJobRows).toHaveBeenCalledWith(100);
    expect(listJobsByCustomer).not.toHaveBeenCalled();
    expect(res.body.jobs[0].jobId).toBe('job_all');
  });

  test('admin with all=true uses listAllJobRows', async () => {
    authState.user = { id: 'adm_1', role: 'superadmin', planTier: 'custom' };

    const res = await request(app).get('/jobs').query({ all: 'true' });

    expect(res.status).toBe(200);
    expect(listAllJobRows).toHaveBeenCalledWith(100);
    expect(listJobsByCustomer).not.toHaveBeenCalled();
  });
});

describe('GET /jobs — customer job status resolution (CPD-869)', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    authState.user = { id: 'cust_a', role: 'customer', planTier: 'guided' };
  });

  test('prefers spec.status over portal-policy leak in jobs.status column', async () => {
    listJobsByCustomer.mockResolvedValue([{
      id:          'job_review',
      customer_id: 'cust_a',
      status:      'passed',
      job_spec:    JSON.stringify({
        contentType: 'clips',
        status:      'operator_review',
        state:       { savedOutputs: { r2VideoUrl: 'https://assets.example/v.mp4' } },
      }),
      created_at: '1700000000000',
      updated_at: '1700000001000',
    }]);

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].status).toBe('processing');
  });

  test('surfaces failed when spec says failed but row still running', async () => {
    listJobsByCustomer.mockResolvedValue([{
      id:          'job_zombie',
      customer_id: 'cust_a',
      status:      'running',
      job_spec:    JSON.stringify({ contentType: 'clips', status: 'failed' }),
      created_at:  '1700000000000',
      updated_at:  '1700000001000',
    }]);

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].status).toBe('failed');
  });

  test('infers review-ready when output exists but spec stuck queued', async () => {
    listJobsByCustomer.mockResolvedValue([{
      id:          'job_orphan',
      customer_id: 'cust_a',
      status:      'sendback',
      job_spec:    JSON.stringify({
        contentType: 'clips',
        status:      'queued',
        state:       { savedOutputs: { r2VideoUrl: 'https://assets.example/v.mp4' } },
      }),
      created_at: '1700000000000',
      updated_at: '1700000001000',
    }]);

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
    expect(res.body.jobs[0].status).toBe('processing');
  });
});

describe('jobs_c1 order review helpers', () => {
  const {
    _resolveCreatedBy,
    _buildOrderSourceSummary,
  } = require('../lib/routes/jobs_c1');

  test('_resolveCreatedBy tags dashboard vs e2e vs api', () => {
    expect(_resolveCreatedBy({ headers: {}, body: { entryType: 'fetch' } })).toBe('dashboard');
    expect(_resolveCreatedBy({ headers: { 'x-e2e-secret': 's' }, body: { entryType: 'fetch' } })).toBe('e2e_script');
    expect(_resolveCreatedBy({ headers: {}, body: { entry: 'fetch', url: 'https://x' } })).toBe('api');
  });

  test('_buildOrderSourceSummary returns candidates and selected clip', () => {
    const spec = {
      addOns: { clipSourcing: { active: true } },
      order: {
        inputs: {
          sourceLibrary: [
            { url: 'https://clips.twitch.tv/a', title: 'Clip A' },
            { url: 'https://clips.twitch.tv/b', title: 'Clip B' },
          ],
        },
      },
      state: {
        clipManifest: {
          source: 'gemini_metadata_rank',
          clips: [{ url: 'https://clips.twitch.tv/b', label: 'Clip B', duration: 42, confidence: 0.91 }],
        },
      },
    };
    const summary = _buildOrderSourceSummary(spec);
    expect(summary.candidates).toHaveLength(2);
    expect(summary.selected?.url).toBe('https://clips.twitch.tv/b');
    expect(summary.selectionSource).toBe('gemini_metadata_rank');
    expect(summary.clipSourcing).toBe(true);
  });
});
