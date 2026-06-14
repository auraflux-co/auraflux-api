'use strict';
/**
 * On-demand RunPod GPU pod lifecycle for EchoMimic (CPD-991).
 *
 * Pod runs only while avatar work is in flight — wake before renders, stop after.
 * Env:
 *   ECHOMIMIC_POD_ID           existing pod (preferred — fast restart vs recreate)
 *   ECHOMIMIC_POD_AUTO_STOP    default on — stop GPU after job batch
 *   RUNPOD_API_KEY
 */

const axios = require('axios');

const RUNPOD_BASE = 'https://rest.runpod.io/v1';

function runpodKey() {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error('RUNPOD_API_KEY not set');
  return k;
}

function headers() {
  return { Authorization: `Bearer ${runpodKey()}`, 'Content-Type': 'application/json' };
}

function podId() {
  return process.env.ECHOMIMIC_POD_ID || null;
}

function podProxyBase(id) {
  return `https://${id}-8000.proxy.runpod.net`;
}

function autoStopEnabled() {
  return String(process.env.ECHOMIMIC_POD_AUTO_STOP || 'on').toLowerCase() !== 'off';
}

async function getPod(id = podId()) {
  if (!id) return null;
  try {
    const resp = await axios.get(`${RUNPOD_BASE}/pods/${id}`, { headers: headers(), timeout: 15000 });
    return resp.data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function waitForHealth(id, { maxWaitMs = 300000, intervalMs = 10000 } = {}) {
  const base = podProxyBase(id);
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const resp = await axios.get(`${base}/health`, { timeout: 8000 });
      if (resp.data?.ok) return true;
    } catch (e) {
      // 404 while container boots
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`[echomimic-pod] health check timed out for pod ${id}`);
}

async function bootstrapStartCmd() {
  const { presignR2 } = require('../storage');
  const h = await presignR2('build/echomimic/handler.py', { method: 'GET', expiresIn: 604800 });
  const s = await presignR2('build/echomimic/http_server.py', { method: 'GET', expiresIn: 604800 });
  return `curl -sf '${h}' -o /workspace/handler.py && curl -sf '${s}' -o /workspace/http_server.py && MODELS_DIR=/runpod-volume/models ECHOMIMIC_HTTP_PORT=8000 python -u /workspace/http_server.py`;
}

async function createPod() {
  const start = await bootstrapStartCmd();
  const body = {
    name: 'echomimic-prod-worker',
    imageName: process.env.ECHOMIMIC_IMAGE || 'ghcr.io/auraflux-dev/cwn-echomimic-worker:20260613',
    containerRegistryAuthId: process.env.RUNPOD_REGISTRY_AUTH_ID || 'cmqbmaacd0087ydrg4vz947hv',
    gpuTypeIds: (process.env.ECHOMIMIC_GPU_TYPES || 'NVIDIA GeForce RTX 4090,NVIDIA L40S,NVIDIA A40,NVIDIA GeForce RTX 5090').split(',').map((s) => s.trim()),
    gpuCount: 1,
    dataCenterIds: [(process.env.ECHOMIMIC_DATACENTER || 'EU-RO-1')],
    networkVolumeId: process.env.ECHOMIMIC_VOLUME_ID || 'wyb80tdj30',
    containerDiskInGb: 40,
    volumeMountPath: '/runpod-volume',
    ports: ['8000/http', '22/tcp'],
    env: { MODELS_DIR: '/runpod-volume/models', ECHOMIMIC_HTTP_PORT: '8000' },
    dockerStartCmd: ['bash', '-c', start]
  };
  const resp = await axios.post(`${RUNPOD_BASE}/pods`, body, { headers: headers(), timeout: 60000 });
  const id = resp.data?.id;
  if (!id) throw new Error(`[echomimic-pod] create failed: ${JSON.stringify(resp.data).slice(0, 300)}`);
  console.log(`[echomimic-pod] created pod ${id} (${resp.data?.machine?.gpuTypeId || 'gpu'})`);
  process.env.ECHOMIMIC_POD_ID = id;
  return id;
}

/** Start stopped pod or create if missing; wait until HTTP health OK. */
async function wakePod() {
  let id = podId();
  let pod = id ? await getPod(id) : null;

  if (!pod) {
    console.log('[echomimic-pod] no running pod — creating');
    id = await createPod();
  } else if (pod.desiredStatus === 'EXITED' || pod.desiredStatus === 'STOPPED') {
    console.log(`[echomimic-pod] starting stopped pod ${id}`);
    try {
      await axios.post(`${RUNPOD_BASE}/pods/${id}/start`, {}, { headers: headers(), timeout: 30000 });
    } catch (e) {
      const msg = e.response?.data?.error || e.message;
      console.warn(`[echomimic-pod] start failed (${msg}) — provisioning fresh pod`);
      id = await createPod();
    }
  } else {
    console.log(`[echomimic-pod] pod ${id} already ${pod.desiredStatus || 'active'}`);
  }

  await waitForHealth(id);
  console.log(`[echomimic-pod] pod ${id} ready`);
  return id;
}

/** Stop GPU billing; pod config + volume are preserved for fast restart. */
async function stopPod({ force = false } = {}) {
  if (!force && !autoStopEnabled()) {
    console.log('[echomimic-pod] auto-stop disabled — leaving pod running');
    return;
  }
  const id = podId();
  if (!id) return;
  const pod = await getPod(id);
  if (!pod || pod.desiredStatus === 'EXITED') {
    console.log(`[echomimic-pod] pod ${id} already stopped`);
    return;
  }
  await axios.post(`${RUNPOD_BASE}/pods/${id}/stop`, {}, { headers: headers(), timeout: 30000 });
  console.log(`[echomimic-pod] stopped pod ${id} (GPU off)`);
}

module.exports = { wakePod, stopPod, getPod, waitForHealth, autoStopEnabled, podProxyBase };
