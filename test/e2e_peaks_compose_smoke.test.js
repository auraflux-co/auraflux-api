'use strict';
/**
 * Prod Peaks → compose smoke (iss_exFgoTmmRwhP).
 *
 *   E2E_ACCOUNT_ID=operate-test \
 *   E2E_AUTH_SECRET=… \
 *   AURAFLUX_API_URL=https://auraflux-api.onrender.com \
 *   node --test test/e2e_peaks_compose_smoke.test.js
 *
 * Optional CREATE_JOB=1 creates a short_compile_clips job from a public sample MP4.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.AURAFLUX_API_URL || '').replace(/\/$/, '');
const SECRET = process.env.E2E_AUTH_SECRET || '';
const ACCOUNT = process.env.E2E_ACCOUNT_ID || '';
const enabled = !!(BASE && SECRET && ACCOUNT);
const createJob = process.env.CREATE_JOB === '1';

const SAMPLE_MP4 = 'https://download.samplelib.com/mp4/sample-5s.mp4';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ba_user_${ACCOUNT}`,
      'X-E2E-Secret': SECRET,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

test('health ok', { skip: !BASE }, async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
});

test('peaks compose presets include C9–C11', { skip: !enabled }, async () => {
  const { status, json } = await api('/content-library/presets');
  assert.equal(status, 200, JSON.stringify(json || {}));
  assert.ok(json?.ok);
  const keys = (json.presets || []).map((p) => p.key);
  assert.ok(keys.includes('fableflow_speed'), `missing C9 in ${keys.join(',')}`);
  assert.ok(keys.includes('reaction_short'));
  assert.ok(keys.includes('dual_source_stack'));
});

test('vod list returns longform candidates', { skip: !enabled }, async () => {
  const { status, json } = await api('/content-library/vods?handle=MrBeast&limit=5');
  assert.equal(status, 200, JSON.stringify(json || {}));
  assert.ok(json?.ok);
  assert.ok((json.vods || []).length >= 1, 'expected ≥1 VOD ≥180s');
});

test('create C9 short_compile job from sample mp4', { skip: !enabled || !createJob }, async () => {
  const { status, json } = await api('/jobs', {
    method: 'POST',
    body: {
      entry: 'fetch',
      entryType: 'fetch',
      contentType: 'clips',
      formFactor: 'short',
      format: 'short',
      productionPath: 'short_compile_clips',
      platforms: ['youtube'],
      topic: 'E2E peak',
      fetchSpec: {
        sourceUrls: [SAMPLE_MP4],
        sourceLibrary: [{
          url: SAMPLE_MP4,
          title: 'E2E sample',
          platform: 'youtube',
          contentType: 'vod_peak',
        }],
      },
      featureConfig: { compose: { preset: 'fableflow_speed', presetCode: 'C9' } },
      staging: true,
      createdVia: 'dashboard',
    },
  });
  assert.ok(status < 500, JSON.stringify(json || {}));
  const jobId = json?.jobId || json?.job?.jobId;
  assert.ok(jobId, `expected jobId: ${JSON.stringify(json)}`);
  console.log('created job', jobId);
});
