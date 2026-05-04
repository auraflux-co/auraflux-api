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
    expect(listJobsByCustomer).toHaveBeenCalledWith('cust_a', 50);
    expect(listAllJobRows).not.toHaveBeenCalled();
    expect(res.body.jobs[0].jobId).toBe('job_one');
  });

  test('operator without all=true uses listJobsByCustomer', async () => {
    authState.user = { id: 'op_1', role: 'operator', planTier: 'diy' };

    const res = await request(app).get('/jobs');

    expect(res.status).toBe(200);
    expect(listJobsByCustomer).toHaveBeenCalledWith('op_1', 50);
    expect(listAllJobRows).not.toHaveBeenCalled();
  });

  test('operator with all=true uses listAllJobRows(100)', async () => {
    authState.user = { id: 'op_1', role: 'operator', planTier: 'diy' };

    const res = await request(app).get('/jobs').query({ all: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(listAllJobRows).toHaveBeenCalledWith(100);
    expect(listJobsByCustomer).not.toHaveBeenCalled();
    expect(res.body.jobs[0].jobId).toBe('job_all');
  });

  test('admin with all=true uses listAllJobRows', async () => {
    authState.user = { id: 'adm_1', role: 'admin', planTier: 'custom' };

    const res = await request(app).get('/jobs').query({ all: 'true' });

    expect(res.status).toBe(200);
    expect(listAllJobRows).toHaveBeenCalledWith(100);
    expect(listJobsByCustomer).not.toHaveBeenCalled();
  });
});
