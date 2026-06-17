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
const metrics = require('./echomimic_metrics');

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
  const keys = ['handler.py', 'http_server.py', 'apply_ip_mask_patches.py', 'face_detect_subprocess.py'];
  const curls = await Promise.all(keys.map(async (name) => {
    const url = await presignR2(`build/echomimic/${name}`, { method: 'GET', expiresIn: 604800 });
    return `curl -sf '${url}' -o /workspace/${name}`;
  }));
  return `${curls.join(' && ')} && MODELS_DIR=/runpod-volume/models ECHOMIMIC_HTTP_PORT=8000 python -u /workspace/http_server.py`;
}

function gpuTypeFallbackList() {
  return (process.env.ECHOMIMIC_GPU_TYPES
    || 'NVIDIA GeForce RTX 4090,NVIDIA L40S,NVIDIA A40,NVIDIA L4,NVIDIA RTX A6000,NVIDIA RTX 4000 Ada Generation')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createPod(dataCenter, gpuTypeId) {
  const dc = dataCenter || process.env.ECHOMIMIC_DATACENTER || 'EU-RO-1';
  const start = await bootstrapStartCmd();
  const gpuTypeIds = gpuTypeId
    ? [gpuTypeId]
    : gpuTypeFallbackList();
  const body = {
    name: 'echomimic-prod-worker',
    imageName: process.env.ECHOMIMIC_IMAGE || 'ghcr.io/auraflux-dev/cwn-echomimic-worker:20260613',
    containerRegistryAuthId: process.env.RUNPOD_REGISTRY_AUTH_ID || 'cmqbmaacd0087ydrg4vz947hv',
    gpuTypeIds,
    gpuCount: 1,
    dataCenterIds: [dc],
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
  console.log(`[echomimic-pod] created pod ${id} in ${dc} (${resp.data?.machine?.gpuTypeId || gpuTypeIds[0] || 'gpu'})`);
  process.env.ECHOMIMIC_POD_ID = id;
  process.env.ECHOMIMIC_DATACENTER = dc;
  metrics.record('pod_create', {
    podId: id,
    gpuType: resp.data?.machine?.gpuTypeId || null,
    dataCenter: dc
  });
  return id;
}

function datacenterFallbackList() {
  const primary = process.env.ECHOMIMIC_DATACENTER || 'EU-RO-1';
  // Network volumes are region-locked — do not hop datacenters when volume attached.
  if (process.env.ECHOMIMIC_VOLUME_ID) return [primary];
  const extras = (process.env.ECHOMIMIC_DATACENTER_FALLBACK || 'US-TX-3,US-KS-2,US-GA-2')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([primary, ...extras])];
}

function isGpuCapacityError(msg) {
  return /no instances|not enough free gpus|could not find any pods|balance too low/i.test(msg);
}

/** Try GPU types one-at-a-time, then datacenter fallbacks when EU pool is exhausted. */
async function createPodWithFallback() {
  let lastErr;
  for (const dc of datacenterFallbackList()) {
    for (const gpu of gpuTypeFallbackList()) {
      try {
        return await createPod(dc, gpu);
      } catch (e) {
        lastErr = e;
        const msg = String(e.response?.data?.error || e.message);
        console.warn(`[echomimic-pod] create ${gpu} in ${dc} failed: ${msg}`);
        if (!isGpuCapacityError(msg)) throw e;
      }
    }
  }
  throw lastErr || new Error('[echomimic-pod] create failed — no GPU capacity in any datacenter/type');
}

/** Start stopped pod or create if missing; wait until HTTP health OK. */
async function wakePod() {
  const elapsed = metrics.startTimer();
  metrics.record('pod_wake_start', { podId: podId() });
  let id = podId();
  let pod = id ? await getPod(id) : null;
  let startFailed = false;

  try {
  if (!pod) {
    console.log('[echomimic-pod] no running pod — creating');
    id = await createPodWithFallback();
  } else if (pod.desiredStatus === 'EXITED' || pod.desiredStatus === 'STOPPED') {
      console.log(`[echomimic-pod] starting stopped pod ${id}`);
      try {
        await axios.post(`${RUNPOD_BASE}/pods/${id}/start`, {}, { headers: headers(), timeout: 30000 });
      } catch (e) {
        const msg = e.response?.data?.error || e.message;
        startFailed = true;
        metrics.record('pod_start_failed', { podId: id, error: String(msg).slice(0, 500) });
        console.warn(`[echomimic-pod] start failed (${msg}) — provisioning fresh pod`);
        id = await createPodWithFallback();
      }
    } else {
      console.log(`[echomimic-pod] pod ${id} already ${pod.desiredStatus || 'active'}`);
    }

    await waitForHealth(id);
    console.log(`[echomimic-pod] pod ${id} ready`);
    const podNow = await getPod(id);
    const gpuType = podNow?.machine?.gpuTypeId || null;
    process.env.ECHOMIMIC_LAST_GPU_TYPE = gpuType || '';
    metrics.record('pod_wake_ok', {
      podId: id,
      durationMs: elapsed(),
      hadStartFailure: startFailed,
      gpuType
    });
    return id;
  } catch (e) {
    metrics.record('pod_wake_fail', {
      podId: id,
      durationMs: elapsed(),
      error: String(e.message).slice(0, 500),
      hadStartFailure: startFailed
    });
    throw e;
  }
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
  metrics.record('pod_stop', { podId: id });
}

module.exports = { wakePod, stopPod, getPod, waitForHealth, autoStopEnabled, podProxyBase };
