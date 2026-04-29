'use strict';
/**
 * test/jobs_c1.test.js — CPD-67
 * Unit tests for the C1+ POST /jobs entry endpoint.
 */

const express = require('express');
const request = require('supertest');

// Mock heavy deps before requiring the route
jest.mock('../lib/job_spec', () => ({
  createJobSpec: jest.fn(({ customerId, contentType, sourceType, templateId }) => ({
    jobId: `${customerId}_COMPACT_GEN_${contentType}_1234567890`,
    customerId,
    contentType,
    sourceType,
    templateId: templateId || 'long-form',
    portals: {
      portal0: { active: true, skippable: false, provider: 'gemini', reason: null },
      portal1: { active: true, skippable: true, provider: 'gemini', reason: null },
    },
    extensions: {},
    order: {},
    designSpec: {},
    state: {},
  })),
}));

jest.mock('../lib/db', () => ({
  seedJobSpecFromScript: jest.fn(),
  saveJob: jest.fn(),
}));

jest.mock('../lib/gate_policy_runner', () => ({
  runPortalSequence: jest.fn(),
}));

const router = require('../lib/routes/jobs_c1');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('POST /jobs — C1+ job entry endpoint (CPD-67)', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test('entry=fetch creates job with url_list sourceType', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'fetch',
      url: 'https://example.com/video.mp4',
      contentType: 'news',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.entry).toBe('fetch');
    expect(res.body.sourceType).toBe('url_list');
    expect(res.body.jobId).toBeTruthy();
  });

  test('entry=upload creates job with upload sourceType', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'upload',
      fileId: 'r2_asset_abc123',
      contentType: 'sports',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.entry).toBe('upload');
    expect(res.body.sourceType).toBe('upload');
  });

  test('entry=generate/text creates job with wan_gen sourceType', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'generate',
      type: 'text',
      prompt: 'A dramatic sports highlight video',
      contentType: 'clips',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(res.body.entry).toBe('generate');
    expect(res.body.sourceType).toBe('wan_gen');
  });

  test('entry=generate/image creates job with wan_gen sourceType', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'generate',
      type: 'image',
      imageId: 'r2_img_xyz',
      contentType: 'clips',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(202);
    expect(res.body.sourceType).toBe('wan_gen');
  });

  test('missing entry returns 400', async () => {
    const res = await request(app).post('/jobs').send({
      contentType: 'news',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors).toBeDefined();
  });

  test('invalid entry value returns 400', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'invalid_entry',
      contentType: 'news',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(400);
  });

  test('entry=fetch missing url returns 400', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'fetch',
      contentType: 'news',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(400);
  });

  test('entry=upload missing fileId returns 400', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'upload',
      contentType: 'sports',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(400);
  });

  test('seedJobSpecFromScript called on success', async () => {
    const { seedJobSpecFromScript } = require('../lib/db');

    await request(app).post('/jobs').send({
      entry: 'fetch',
      url: 'https://example.com/video.mp4',
      contentType: 'news',
      customerId: 'cust_test',
    });

    expect(seedJobSpecFromScript).toHaveBeenCalledTimes(1);
  });

  test('invalid contentType returns 400', async () => {
    const res = await request(app).post('/jobs').send({
      entry: 'fetch',
      url: 'https://example.com/video.mp4',
      contentType: 'not_a_valid_type',
      customerId: 'cust_test',
    });

    expect(res.status).toBe(400);
  });
});
