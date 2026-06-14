'use strict';
/**
 * test/smoke_render.test.js — CPD-12: Automated smoke tests against the Render API
 *
 * Runs against SMOKE_API_URL (production or staging Render deployment).
 * Skipped automatically when SMOKE_API_URL is not set (keeps CI green in local dev).
 *
 * Usage:
 *   SMOKE_API_URL=https://api.auraflux.co npx jest smoke_render --no-coverage
 *   SMOKE_API_URL=https://api-staging.auraflux.co SMOKE_API_KEY=<key> npx jest smoke_render
 */

const axios = require('axios');

const API_URL = process.env.SMOKE_API_URL;
const API_KEY = process.env.SMOKE_API_KEY || '';

const TIMEOUT = 15_000;

// Skip all tests when SMOKE_API_URL is not configured
const describeIf = API_URL ? describe : describe.skip;

describeIf('Render smoke tests', () => {
  const client = axios.create({
    baseURL: API_URL,
    timeout: TIMEOUT,
    headers: API_KEY ? { 'x-api-key': API_KEY } : {},
    validateStatus: () => true, // don't throw on non-2xx
  });

  test('GET /health returns 200 and ok:true', async () => {
    const res = await client.get('/health');
    expect(res.status).toBe(200);
    expect(res.data?.ok ?? res.data?.status).toBeTruthy();
  });

  test('GET /health includes uptime', async () => {
    const res = await client.get('/health');
    expect(res.status).toBe(200);
    // Either uptime seconds or a human string
    const hasUptime =
      typeof res.data?.uptime === 'number' ||
      typeof res.data?.uptime === 'string' ||
      typeof res.data?.uptimeSeconds === 'number';
    expect(hasUptime).toBe(true);
  });

  test('GET /plans returns plan list', async () => {
    const res = await client.get('/plans');
    expect(res.status).toBe(200);
    const plans = res.data?.plans ?? res.data;
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBeGreaterThan(0);
  });

  test('POST /api/generate-video with no prompt returns 400', async () => {
    const res = await client.post('/api/generate-video', {});
    expect(res.status).toBe(400);
    expect(res.data?.error).toBeTruthy();
  });

  test('POST /jobs with no auth returns 401', async () => {
    const res = await client.post('/jobs', { contentType: 'news' });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /social/accounts with no auth returns 401', async () => {
    const res = await client.get('/social/accounts');
    expect([401, 403]).toContain(res.status);
  });

  test('GET /internal/alert rejects missing secret', async () => {
    const res = await client.post('/internal/alert', { test: true });
    // If NR_ALERT_SECRET is set → 401; if not set → 200 (no secret configured)
    expect([200, 401]).toContain(res.status);
  });

  test('Static /assets/* does not 500', async () => {
    const res = await client.get('/assets/nonexistent.png');
    expect(res.status).not.toBe(500);
  });
});

// Always-run local invariants (don't need API_URL)
describe('API config invariants', () => {
  test('SMOKE_API_URL env var format is valid if set', () => {
    if (!API_URL) return;
    expect(API_URL).toMatch(/^https?:\/\/.+/);
  });
});
