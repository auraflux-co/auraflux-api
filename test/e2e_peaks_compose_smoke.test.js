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
 * Optional STAGE_LOCAL=1 uploads that sample via POST /content-library/stage-local → R2.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.env.AURAFLUX_API_URL || '').replace(/\/$/, '');
const SECRET = process.env.E2E_AUTH_SECRET || '';
const ACCOUNT = process.env.E2E_ACCOUNT_ID || 'operate-test';
const enabled = !!(BASE && SECRET && ACCOUNT);
const createJob = process.env.CREATE_JOB === '1';
const stageLocal = process.env.STAGE_LOCAL === '1' || createJob;

const SAMPLE_MP4 = 'https://download.samplelib.com/mp4/sample-5s.mp4';

async function api(path, { method = 'GET', body, formData } = {}) {
  const headers = {
    Authorization: `Bearer ba_user_${ACCOUNT}`,
    'X-E2E-Secret': SECRET,
  };
  let payload;
  if (formData) {
    payload = formData;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function downloadSampleMp4() {
  const res = await fetch(SAMPLE_MP4);
  assert.equal(res.status, 200, `sample mp4 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 5000, `sample too small: ${buf.length}`);
  const tmp = path.join(os.tmpdir(), `peaks_e2e_${Date.now()}.mp4`);
  fs.writeFileSync(tmp, buf);
  return tmp;
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

test('analyze Most Replayed returns peak segments', { skip: !enabled }, async () => {
  const list = await api('/content-library/vods?handle=MrBeast&limit=3');
  assert.equal(list.status, 200, JSON.stringify(list.json || {}));
  const vod = (list.json?.vods || [])[0];
  assert.ok(vod?.vodId, 'need a VOD to analyze');
  const { status, json } = await api('/content-library/vod/analyze', {
    method: 'POST',
    body: {
      platform: vod.platform || 'youtube',
      vodId: vod.vodId,
      vodUrl: vod.url,
      title: vod.title,
      durationSec: vod.duration,
      streamer: vod.streamer || 'mrbeast',
      views: vod.views,
      maxPeaks: 5,
    },
  });
  assert.equal(status, 200, JSON.stringify(json || {}));
  assert.ok(json?.ok);
  assert.ok(Array.isArray(json.segments), 'expected segments array');
  console.log('analyze peaks', json.segments?.length || 0, 'session', json.sessionId);
});

test('stage-local rejects missing file', { skip: !enabled }, async () => {
  const form = new FormData();
  form.append('title', 'no-file');
  const { status, json } = await api('/content-library/stage-local', { method: 'POST', formData: form });
  assert.ok(status >= 400, `expected 4xx got ${status}`);
  assert.ok(json?.error || status === 400);
});

test('stage-local uploads sample mp4 to R2', { skip: !enabled || !stageLocal }, async () => {
  const tmp = await downloadSampleMp4();
  try {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(tmp)], { type: 'video/mp4' }), path.basename(tmp));
    form.append('title', 'E2E peaks stage-local');
    form.append('streamer', 'peaks_e2e');
    form.append('platform', 'youtube');
    form.append('startSec', '0');
    form.append('endSec', '5');
    form.append('force', '1');
    const { status, json } = await api('/content-library/stage-local', { method: 'POST', formData: form });
    assert.equal(status, 200, JSON.stringify(json || {}));
    assert.ok(json?.ok, JSON.stringify(json || {}));
    const url = json.mp4Url || json.r2Url || json.stagedUrl || json.playbackUrl;
    assert.ok(url && /^https?:\/\//.test(url), `expected staged URL: ${JSON.stringify(json)}`);
    console.log('staged', url);
    globalThis.__PEAKS_STAGED_URL = url;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
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
        sourceUrls: [globalThis.__PEAKS_STAGED_URL || SAMPLE_MP4],
        sourceLibrary: [{
          url: globalThis.__PEAKS_STAGED_URL || SAMPLE_MP4,
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
