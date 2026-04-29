'use strict';
/**
 * lib/ai/runpod.js
 *
 * RunPod API client for ComfyUI/SVD video generation.
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

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_POD_ID = process.env.RUNPOD_POD_ID;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;

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
          ...(auth ? { Authorization: `Bearer ${RUNPOD_API_KEY}` } : {}),
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

function _podComfyUrl(podId = RUNPOD_POD_ID) {
  if (!podId) throw new Error('RUNPOD_POD_ID not set');
  return `https://${podId}-8188.proxy.runpod.net`;
}

// ── ComfyUI workflow submission (persistent pod) ─────────────────────────────

/**
 * Submit a ComfyUI workflow JSON to a persistent pod.
 * Returns the prompt_id for polling.
 */
async function submitComfyWorkflow(workflowJson, podId = RUNPOD_POD_ID) {
  const url = `${_podComfyUrl(podId)}/prompt`;
  const res = await _request(url, 'POST', { prompt: workflowJson });
  if (res.status !== 200) {
    throw new Error(`ComfyUI submit failed: ${res.status} — ${JSON.stringify(res.body)}`);
  }
  return res.body.prompt_id;
}

/**
 * Poll ComfyUI history until the prompt_id appears (job complete).
 * Returns the output filenames array.
 */
async function pollComfyResult(promptId, podId = RUNPOD_POD_ID, opts = {}) {
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
async function downloadComfyOutput(filename, subfolder = '', podId = RUNPOD_POD_ID) {
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
async function submitServerlessJob(input, endpointId = RUNPOD_ENDPOINT_ID) {
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
async function pollServerlessJob(jobId, endpointId = RUNPOD_ENDPOINT_ID, opts = {}) {
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
async function pingPod(podId = RUNPOD_POD_ID) {
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
 * Build and submit a WAN 2.2 T2V workflow from a text prompt. (CPD-78: upgraded from WAN 2.1)
 * Model: Wan-AI/Wan2.2-T2V-A14B (FP8). Requires wan2.2_vae.safetensors on the RunPod pod.
 * Returns the prompt_id for polling via pollComfyResult().
 *
 * @param {object} opts
 * @param {string} opts.positivePrompt
 * @param {string} [opts.negativePrompt]
 * @param {number} [opts.width=832]
 * @param {number} [opts.height=480]
 * @param {number} [opts.numFrames=25]
 * @param {number} [opts.seed]
 * @param {string} [opts.outputPrefix]
 * @param {string} [opts.podId]
 */
async function generateWanVideo(opts = {}) {
  const {
    positivePrompt,
    negativePrompt = 'blurry, low quality, distorted, watermark, text, logo',
    width = 832,
    height = 480,
    numFrames = 25,
    seed = Math.floor(Math.random() * 2 ** 32),
    outputPrefix = `wan_${Date.now()}`,
    podId = RUNPOD_POD_ID,
  } = opts;

  if (!positivePrompt) throw new Error('positivePrompt is required');

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

module.exports = {
  submitComfyWorkflow,
  pollComfyResult,
  downloadComfyOutput,
  submitServerlessJob,
  pollServerlessJob,
  pingPod,
  generateWanVideo,
};
