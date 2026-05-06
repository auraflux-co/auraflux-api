'use strict';
/**
 * lib/ai/runpod.js
 *
 * RunPod API client for ComfyUI/SVD video generation.
 *
 * Feature gating: wan_t2v requires dwy+, wan_i2v requires dfy+.
 * Callers must pass planTier in opts and handle the { skipped: true } return.
 *
 * Two modes:
 *   1. Persistent pod  — connects to a running ComfyUI pod via proxy URL
 *      Base URL: https://{POD_ID}-8188.proxy.runpod.net
 *   2. Serverless endpoint — POST to RunPod serverless endpoint (production)
 *      Base URL: https://api.runpod.ai/v2/{ENDPOINT_ID}
 *
 * Env vars required:
 *   RUNPOD_API_KEY     — RunPod API key (never commit)
 *   RUNPOD_POD_ID      — Persistent pod ID (dev/test)
 *   RUNPOD_ENDPOINT_ID — Serverless endpoint ID (production, optional)
 */

const https = require('https');
const { isFeatureEnabled } = require('../services/feature_gate');

// Env vars read lazily (inside functions) so Jest can set them in beforeEach.
// Cached constants here would snapshot undefined if the module loads before the test sets them.
const getApiKey = () => process.env.RUNPOD_API_KEY;
const getPodId = () => process.env.RUNPOD_POD_ID;
const getEndpointId = () => process.env.RUNPOD_ENDPOINT_ID;
// ComfyUI account API key — required for WAN 2.7 Partner Nodes (CPD-79).
// Different from RUNPOD_API_KEY: this is a Comfy.org account token, not a RunPod credential.
const getComfyApiKey = () => process.env.COMFYUI_API_KEY;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generic HTTPS request helper.
 * `auth` — whether to include the RunPod Bearer token (true for RunPod REST
 *  API endpoints; false for ComfyUI pod proxy, which rejects the header).
 */
function _request(url, method, body, headers = {}, auth = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: `Bearer ${getApiKey()}` } : {}),
          ...headers,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Pod proxy URL (persistent pod mode) ─────────────────────────────────────

function _podComfyUrl(podId = getPodId()) {
  if (!podId) throw new Error('RUNPOD_POD_ID not set');
  return `https://${podId}-8188.proxy.runpod.net`;
}

// ── ComfyUI workflow submission (persistent pod) ─────────────────────────────

/**
 * Submit a ComfyUI workflow JSON to a persistent pod.
 * Returns the prompt_id for polling.
 *
 * @param {object} workflowJson
 * @param {string} [podId]
 * @param {object} [extraHeaders] — extra headers (e.g. ComfyUI auth for Partner Nodes)
 */
async function submitComfyWorkflow(workflowJson, podId = getPodId(), extraHeaders = {}) {
  const url = `${_podComfyUrl(podId)}/prompt`;
  const res = await _request(url, 'POST', { prompt: workflowJson }, extraHeaders);
  if (res.status !== 200) {
    throw new Error(`ComfyUI submit failed: ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return res.body.prompt_id;
}

/**
 * Poll ComfyUI history until the prompt_id appears (job complete).
 * Returns the output filenames array.
 */
async function pollComfyResult(promptId, podId = getPodId(), opts = {}) {
  const { maxWaitMs = 300_000, intervalMs = 5_000 } = opts;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const url = `${_podComfyUrl(podId)}/history/${promptId}`;
    const res = await _request(url, 'GET', null);
    if (res.status === 200 && res.body[promptId]) {
      const outputs = res.body[promptId].outputs;
      return outputs;
    }
  }
  throw new Error(`ComfyUI job ${promptId} timed out after ${maxWaitMs}ms`);
}

/**
 * Download a file from the ComfyUI pod output.
 * Returns a Buffer.
 */
async function downloadComfyOutput(filename, subfolder = '', podId = getPodId()) {
  const url =
    `${_podComfyUrl(podId)}/view?filename=${encodeURIComponent(filename)}` +
    (subfolder ? `&subfolder=${encodeURIComponent(subfolder)}` : '');
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https
      .get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      )
      .on('error', reject);
  });
}

// ── Serverless endpoint (production) ────────────────────────────────────────

/**
 * Submit a job to a RunPod serverless endpoint.
 * Returns { id } — the job ID for polling.
 */
async function submitServerlessJob(input, endpointId = getEndpointId()) {
  if (!endpointId) throw new Error('RUNPOD_ENDPOINT_ID not set');
  const url = `https://api.runpod.ai/v2/${endpointId}/run`;
  const res = await _request(url, 'POST', { input }, {}, true);
  if (res.status !== 200) {
    throw new Error(`RunPod serverless submit failed: ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/**
 * Poll a serverless job until complete.
 * Returns the output object.
 */
async function pollServerlessJob(jobId, endpointId = getEndpointId(), opts = {}) {
  const { maxWaitMs = 300_000, intervalMs = 5_000 } = opts;
  if (!endpointId) throw new Error('RUNPOD_ENDPOINT_ID not set');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const url = `https://api.runpod.ai/v2/${endpointId}/status/${jobId}`;
    const res = await _request(url, 'GET', null, {}, true);
    if (res.status === 200) {
      const { status, output, error } = res.body;
      if (status === 'COMPLETED') return output;
      if (status === 'FAILED') throw new Error(`RunPod job failed: ${error}`);
    }
  }
  throw new Error(`RunPod job ${jobId} timed out after ${maxWaitMs}ms`);
}

// ── Health check ─────────────────────────────────────────────────────────────

/**
 * Ping the ComfyUI pod to confirm it's reachable.
 * Returns { ok, url }.
 */
async function pingPod(podId = getPodId()) {
  if (!podId) return { ok: false, error: 'RUNPOD_POD_ID not set' };
  try {
    const url = `${_podComfyUrl(podId)}/system_stats`;
    const res = await _request(url, 'GET', null);
    return { ok: res.status === 200, url: _podComfyUrl(podId), stats: res.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── High-level helpers ────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

/**
 * Generate video via WAN on RunPod ComfyUI.
 *
 * Supports WAN 2.2 (self-hosted weights) and WAN 2.7 (ComfyUI Partner Nodes).
 * Feature gates: video.wan_t2v requires dwy+, video.wan_i2v requires dfy+.
 *
 * WAN 2.2 parameters:
 *   width, height (pixels), numFrames — maps to wan_t2v_workflow.json
 *
 * WAN 2.7 parameters (CPD-79 — Partner Nodes):
 *   resolution ('720P'|'1080P'), ratio ('16:9' etc), durationSecs (2–15)
 *   Maps to wan_t2v_2.7_workflow.json or wan_i2v_2.7_workflow.json.
 *   Requires COMFYUI_API_KEY in env and ComfyUI pod on 0.18.5+.
 *   For i2v mode, imageFilename must already be uploaded to the pod.
 *
 * Returns the ComfyUI prompt_id for polling via pollComfyResult().
 * Returns { skipped: true } if the feature is not available on the given plan tier.
 *
 * @param {object}  opts
 * @param {string}  opts.positivePrompt
 * @param {string}  [opts.negativePrompt]
 * @param {string}  [opts.modelVersion='2.2']  '2.2' | '2.7'
 * @param {string}  [opts.mode='t2v']           't2v' | 'i2v'
 * @param {string}  [opts.planTier='diy']
 * @param {string}  [opts.podId]
 * @param {number}  [opts.seed]
 * @param {string}  [opts.outputPrefix]
 * -- WAN 2.2 only --
 * @param {number}  [opts.width=832]
 * @param {number}  [opts.height=480]
 * @param {number}  [opts.numFrames=25]
 * -- WAN 2.7 only --
 * @param {string}  [opts.resolution='720P']  '720P' | '1080P'
 * @param {string}  [opts.ratio='16:9']        '16:9'|'9:16'|'1:1'|'4:3'|'3:4'
 * @param {number}  [opts.durationSecs=5]       2–15
 * @param {boolean} [opts.promptExtend=true]
 * @param {string}  [opts.imageFilename]        i2v only — filename on the pod
 */
/**
 * Generate video from text prompt (T2V) via WAN 2.2 on RunPod ComfyUI.
 * Requires plan tier dwy+ (video.wan_t2v feature).
 *
 * @param {Object} opts
 * @param {string} opts.planTier      — job plan tier ('diy'|'dwy'|'dfy'|'custom')
 * @param {string} opts.mode          — 't2v' (default) | 'i2v'
 * @param {string} opts.positivePrompt
 */
async function generateWanVideo(opts = {}) {
  const {
    positivePrompt,
    negativePrompt = 'blurry, low quality, distorted, watermark, text, logo',
    modelVersion = '2.2',
    mode = 't2v',
    planTier = 'diy',
    podId = getPodId(),
    seed = Math.floor(Math.random() * 2 ** 32),
    outputPrefix = `wan_${Date.now()}`,
    // 2.2 params
    width = 832,
    height = 480,
    numFrames = 25,
    // 2.7 params
    resolution = '720P',
    ratio = '16:9',
    durationSecs = 5,
    promptExtend = true,
    imageFilename,
  } = opts;

  const featureKey = mode === 'i2v' ? 'video.wan_i2v' : 'video.wan_t2v';
  if (!isFeatureEnabled(featureKey, planTier)) {
    return { skipped: true, reason: `${featureKey} not available on plan tier: ${planTier}` };
  }

  if (!positivePrompt) throw new Error('positivePrompt is required');

  if (modelVersion === '2.7') {
    return _generateWan27(
      { positivePrompt, negativePrompt, mode, resolution, ratio, durationSecs,
        promptExtend, seed, outputPrefix, imageFilename },
      podId
    );
  }

  // ── WAN 2.2 (self-hosted) ────────────────────────────────────────────────
  const workflowPath = path.join(__dirname, 'wan_t2v_workflow.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  workflow['3'].inputs.positive_prompt = positivePrompt;
  workflow['3'].inputs.negative_prompt = negativePrompt;
  workflow['4'].inputs.width = width;
  workflow['4'].inputs.height = height;
  workflow['4'].inputs.num_frames = numFrames;
  workflow['5'].inputs.seed = seed;
  workflow['8'].inputs.filename_prefix = outputPrefix;

  return submitComfyWorkflow(workflow, podId);
}

/**
 * Internal: submit a WAN 2.7 Partner Node workflow (T2V or I2V).
 * Passes COMFYUI_API_KEY as Authorization header for Comfy account auth.
 *
 * SCAFFOLD (CPD-79): node field names validated against ComfyUI 0.18.5+ Partner Node
 * schema from Comfy-Org/ComfyUI commit 5de94e7. Confirm on live pod before production.
 */
async function _generateWan27(params, podId) {
  const {
    positivePrompt, negativePrompt, mode, resolution, ratio,
    durationSecs, promptExtend, seed, outputPrefix, imageFilename,
  } = params;

  const workflowFile = mode === 'i2v' ? 'wan_i2v_2.7_workflow.json' : 'wan_t2v_2.7_workflow.json';
  const workflowPath = path.join(__dirname, workflowFile);
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

  if (mode === 'i2v') {
    if (!imageFilename) throw new Error('imageFilename is required for WAN 2.7 I2V mode');
    workflow['1'].inputs.image = imageFilename;
    workflow['2'].inputs.prompt = positivePrompt;
    workflow['2'].inputs.negative_prompt = negativePrompt;
    workflow['2'].inputs.resolution = resolution;
    workflow['2'].inputs.ratio = ratio;
    workflow['2'].inputs.duration = durationSecs;
    workflow['2'].inputs.seed = seed;
    workflow['2'].inputs.prompt_extend = promptExtend;
    workflow['3'].inputs.filename_prefix = outputPrefix;
  } else {
    workflow['1'].inputs.prompt = positivePrompt;
    workflow['1'].inputs.negative_prompt = negativePrompt;
    workflow['1'].inputs.resolution = resolution;
    workflow['1'].inputs.ratio = ratio;
    workflow['1'].inputs.duration = durationSecs;
    workflow['1'].inputs.seed = seed;
    workflow['1'].inputs.prompt_extend = promptExtend;
    workflow['2'].inputs.filename_prefix = outputPrefix;
  }

  // Partner Nodes require the ComfyUI pod to be authenticated with a Comfy account.
  // Pass the account API key so the pod can make external API calls to the Wan 2.7 service.
  const comfyKey = getComfyApiKey();
  const authHeaders = comfyKey ? { Authorization: `Bearer ${comfyKey}` } : {};

  return submitComfyWorkflow(workflow, podId, authHeaders);
}

// ── Pod auto-start ────────────────────────────────────────────────────────────

// Module-level lock: only one ensurePodRunning() executes at a time.
// Concurrent callers queue behind the in-flight promise and share the result.
let _ensurePodLock = null;

/**
 * Ensure the ComfyUI pod is running, starting it if needed.
 *
 * Strategy (CPD-147 — fixed orphan pod creation):
 *  1. Acquire module-level lock so concurrent callers share one execution.
 *  2. Check the tracked pod's desiredStatus via GraphQL.
 *  3. If RUNNING — confirm ComfyUI is reachable; return pod ID.
 *  4. If EXITED — call podResume (same host); wait up to 5 min.
 *  5. If resume fails (GPU shortage) OR ComfyUI never responds:
 *     a. Pre-flight: scan account for any existing auraflux-comfyui-auto pod
 *        that is RUNNING — adopt it instead of creating a duplicate.
 *     b. Only if no adoptable pod exists: call podFindAndDeployOnDemand.
 *     c. Terminate the old EXITED pod after the replacement is confirmed ready.
 *  6. Persist the active pod ID to Render and in-process env.
 *
 * @returns {Promise<string>} the pod ID that is now running
 */
async function ensurePodRunning() {
  if (_ensurePodLock) {
    console.log('[runpod] ensurePodRunning already in progress — waiting for result');
    return _ensurePodLock;
  }
  _ensurePodLock = _ensurePodRunningImpl().finally(() => { _ensurePodLock = null; });
  return _ensurePodLock;
}

async function _ensurePodRunningImpl() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('RUNPOD_API_KEY not set');

  let podId = getPodId();
  if (!podId) throw new Error('RUNPOD_POD_ID not set');

  // ── 1. Check current status ────────────────────────────────────────────────
  const statusResult = await _graphql(apiKey, `{
    pod(input: { podId: "${podId}" }) {
      id desiredStatus imageName gpuCount containerDiskInGb volumeInGb
      ports templateId
      machine { gpuTypeId }
    }
  }`);

  const pod = statusResult?.data?.pod;
  if (!pod) throw new Error(`Pod ${podId} not found in RunPod account`);

  const podConfig = pod;

  if (pod.desiredStatus === 'RUNNING') {
    const ready = await _waitForComfyUI(podId, 60_000);
    if (ready) return podId;
    // Pod is desired RUNNING but ComfyUI not responding — fall through to resume
  }

  // ── 2. Try podResume (same host) ──────────────────────────────────────────
  console.log(`[runpod] Pod ${podId} is ${pod.desiredStatus} — attempting resume`);
  const resumeResult = await _graphql(apiKey, `
    mutation { podResume(input: { podId: "${podId}", gpuCount: 1 }) { id desiredStatus } }
  `);

  const gpuError = (resumeResult?.errors || []).some(
    (e) => e.message && e.message.toLowerCase().includes('not enough free gpu')
  );

  if (!gpuError && resumeResult?.data?.podResume?.id) {
    console.log(`[runpod] podResume succeeded — waiting for ComfyUI`);
    const ready = await _waitForComfyUI(podId, 300_000);
    if (ready) return podId;
    console.log(`[runpod] podResume: pod started but ComfyUI did not respond — will seek replacement`);
  }

  // ── 3. Pre-flight: scan for an existing adoptable pod ────────────────────
  // Before spinning up a new pod, check whether one already exists in the
  // account (e.g. left from a previous run) that we can adopt. This prevents
  // duplicate pod accumulation when multiple callers or retries hit this path.
  console.log(`[runpod] Scanning account for existing auraflux-comfyui-auto pods`);
  const allPodsResult = await _graphql(apiKey, `{
    myself { pods { id name desiredStatus imageName gpuCount containerDiskInGb volumeInGb ports machine { gpuTypeId } } }
  }`);

  const allPods = allPodsResult?.data?.myself?.pods || [];
  const adoptable = allPods.find(
    (p) => p.name === 'auraflux-comfyui-auto' && p.id !== podId && p.desiredStatus === 'RUNNING'
  );

  if (adoptable) {
    console.log(`[runpod] Adopting existing pod ${adoptable.id} instead of creating new`);
    const ready = await _waitForComfyUI(adoptable.id, 300_000);
    if (ready) {
      await _registerNewPod(adoptable.id, podId);
      return adoptable.id;
    }
    console.log(`[runpod] Adoptable pod ${adoptable.id} did not respond — will deploy fresh`);
  }

  // ── 4. Deploy a new pod ───────────────────────────────────────────────────
  console.log(`[runpod] Deploying new pod`);
  const gpuType = podConfig.machine?.gpuTypeId || 'NVIDIA GeForce RTX 3090';
  const deployResult = await _graphql(apiKey, `
    mutation {
      podFindAndDeployOnDemand(input: {
        name:              "auraflux-comfyui-auto"
        imageName:         "${podConfig.imageName || 'runpod/comfyui:latest'}"
        gpuTypeId:         "${gpuType}"
        gpuCount:          ${podConfig.gpuCount || 1}
        containerDiskInGb: ${podConfig.containerDiskInGb || 50}
        volumeInGb:        ${podConfig.volumeInGb || 50}
        ports:             "${podConfig.ports || '8188/http,22/tcp'}"
        startJupyter:      false
        startSsh:          true
      }) { id name desiredStatus }
    }
  `);

  const newPod = deployResult?.data?.podFindAndDeployOnDemand;
  if (!newPod?.id) {
    const err = (deployResult?.errors || []).map((e) => e.message).join('; ');
    throw new Error(`podFindAndDeployOnDemand failed: ${err}`);
  }

  console.log(`[runpod] New pod created: ${newPod.id} — waiting for ComfyUI (up to 10 min)`);
  const ready = await _waitForComfyUI(newPod.id, 600_000);
  if (!ready) throw new Error(`ComfyUI on new pod ${newPod.id} did not become ready in 10 min`);

  await _registerNewPod(newPod.id, podId);
  return newPod.id;
}

/**
 * Register a new pod as the active one: update in-process env, persist to
 * Render, and terminate the old EXITED pod to avoid orphan accumulation.
 */
async function _registerNewPod(newPodId, oldPodId) {
  process.env.RUNPOD_POD_ID = newPodId;

  _updateRenderPodId(newPodId).catch((e) =>
    console.warn(`[runpod] Failed to update RUNPOD_POD_ID in Render: ${e.message}`)
  );

  // Terminate old pod to prevent orphan accumulation — fire and forget
  if (oldPodId && oldPodId !== newPodId) {
    const apiKey = getApiKey();
    _graphql(apiKey, `mutation { podTerminate(input: { podId: "${oldPodId}" }) }`)
      .then(() => console.log(`[runpod] Terminated old pod ${oldPodId}`))
      .catch((e) => console.warn(`[runpod] Could not terminate old pod ${oldPodId}: ${e.message}`));
  }
}

/** GraphQL helper — returns parsed JSON body. */
async function _graphql(apiKey, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const options = {
      hostname: 'api.runpod.io',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${apiKey}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Poll ComfyUI /system_stats until it returns 200 or timeout. */
async function _waitForComfyUI(podId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `https://${podId}-8188.proxy.runpod.net/system_stats`;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) {
        console.log(`[runpod] ComfyUI ready on pod ${podId}`);
        return true;
      }
    } catch (_e) { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

/**
 * Push a single env var update to Render without touching any other vars.
 *
 * Render's PUT /v1/services/:id/env-vars is a FULL REPLACEMENT — sending only
 * one key wipes everything else. This function:
 *   1. GETs the current env var list (handles pagination)
 *   2. Merges the new key/value into the existing list
 *   3. PUTs the merged list back
 *
 * Never call the Render env-vars PUT endpoint with a partial list anywhere in
 * this codebase — always go through this helper.
 */
async function _updateRenderEnvVar(key, value) {
  const renderKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!renderKey || !serviceId) {
    console.warn('[runpod] RENDER_API_KEY or RENDER_SERVICE_ID not set — skipping env update');
    return;
  }

  // ── 1. Fetch all existing env vars (paginated) ──────────────────────────
  const existing = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/env-vars?limit=100`,
      method: 'GET',
      headers: { Authorization: `Bearer ${renderKey}` },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const items = Array.isArray(parsed) ? parsed : [];
          // Render wraps each item as { envVar: { key, value } }
          const flat = items.map((item) => {
            const ev = item.envVar || item;
            return { key: ev.key, value: ev.value };
          });
          resolve(flat);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  // ── 2. Merge: update existing key or append ──────────────────────────────
  const merged = existing.filter((v) => v.key !== key);
  merged.push({ key, value });

  // ── 3. PUT the complete merged list ─────────────────────────────────────
  const body = JSON.stringify(merged);
  const status = await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/env-vars`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${renderKey}`,
      },
    };
    const req = https.request(opts, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (status < 200 || status >= 300) {
    throw new Error(`Render env-var update failed with HTTP ${status}`);
  }
  console.log(`[runpod] Updated ${key}=${value} in Render service ${serviceId} (${merged.length} vars total)`);
}

/** Push new RUNPOD_POD_ID to Render service environment vars (safe merge). */
async function _updateRenderPodId(newPodId) {
  return _updateRenderEnvVar('RUNPOD_POD_ID', newPodId);
}

module.exports = {
  submitComfyWorkflow,
  pollComfyResult,
  downloadComfyOutput,
  submitServerlessJob,
  pollServerlessJob,
  pingPod,
  generateWanVideo,
  ensurePodRunning,
  // Exported for targeted testing of the 2.7 path only; callers should use generateWanVideo.
  _generateWan27,
};
