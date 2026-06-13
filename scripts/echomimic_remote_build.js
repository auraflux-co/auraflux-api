#!/usr/bin/env node
'use strict';
/**
 * CPD-990 — remote build orchestrator (no local CPU/disk/uplink usage,
 * safe to run while a broadcast is live).
 *
 * Phases (run one at a time, watch with `status`):
 *   node scripts/echomimic_remote_build.js populate   # CPU pod fills the network volume with weights
 *   node scripts/echomimic_remote_build.js build      # kaniko CPU pod builds worker image -> GHCR
 *   node scripts/echomimic_remote_build.js deploy     # template + serverless endpoint (volume attached)
 *   node scripts/echomimic_remote_build.js status     # tail remote logs from R2
 *   node scripts/echomimic_remote_build.js cleanup    # terminate any pods this script created
 *
 * Env (from .env): RUNPOD_API_KEY, R2_*, plus for `build`:
 *   GHCR_USER / GHCR_TOKEN  (token needs write:packages — `gh auth token` works
 *                            if the gh login has that scope)
 *
 * State (pod ids, poll URLs) is kept in tmp/echomimic_remote_build.json.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { uploadToR2, presignR2 } = require('../lib/storage');

const RUNPOD_BASE = 'https://rest.runpod.io/v1';
const VOLUME_ID = process.env.ECHOMIMIC_VOLUME_ID || 'wyb80tdj30'; // echomimic-models, EU-RO-1, 60GB
const DATACENTER = 'EU-RO-1'; // must match the volume's datacenter
const PREFIX = 'build/echomimic';
const STATE_PATH = path.join(__dirname, '..', 'tmp', 'echomimic_remote_build.json');
const WORKER_DIR = path.join(__dirname, '..', 'worker', 'echomimic');

const IMAGE = () => `ghcr.io/${requiredEnv('GHCR_USER').toLowerCase()}/cwn-echomimic-worker:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`missing env: ${name}`); process.exit(1); }
  return v;
}

function rp() {
  return axios.create({
    baseURL: RUNPOD_BASE,
    headers: { Authorization: `Bearer ${requiredEnv('RUNPOD_API_KEY')}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

async function presignPair(key) {
  return {
    get: await presignR2(key, { method: 'GET', expiresIn: 172800 }),
    put: await presignR2(key, { method: 'PUT', expiresIn: 172800, contentType: 'text/plain' })
  };
}

// ── populate: CPU pod + network volume, downloads weights from HF ──
async function populate() {
  const state = loadState();

  await uploadToR2(path.join(WORKER_DIR, 'remote_populate.py'), 'remote_populate.py', { key: `${PREFIX}/remote_populate.py` });
  const script = await presignR2(`${PREFIX}/remote_populate.py`, { method: 'GET', expiresIn: 172800 });
  const log = await presignPair(`${PREFIX}/populate_log.txt`);
  const done = await presignPair(`${PREFIX}/populate_done.txt`);

  const cmd =
    'pip install -q "huggingface_hub[hf_transfer]" safetensors && ' +
    'python -c "import os,urllib.request; urllib.request.urlretrieve(os.environ[\'SCRIPT_URL\'], \'/tmp/populate.py\')" && ' +
    'python /tmp/populate.py; ' +
    'sleep 300'; // grace window to pull final logs before auto-kill

  const resp = await rp().post('/pods', {
    name: 'echomimic-populate',
    computeType: 'CPU',
    cpuFlavorIds: ['cpu5c', 'cpu3c'],
    vcpuCount: 4,
    containerDiskInGb: 20,
    networkVolumeId: VOLUME_ID,
    dataCenterIds: [DATACENTER],
    imageName: 'pytorch/pytorch:2.4.1-cuda12.4-cudnn9-runtime',
    env: { SCRIPT_URL: script, LOG_PUT: log.put, DONE_PUT: done.put },
    dockerStartCmd: ['bash', '-c', cmd]
  });

  state.populatePod = resp.data.id;
  state.populateLog = log.get;
  state.populateDone = done.get;
  saveState(state);
  console.log(`populate pod created: ${resp.data.id}`);
  console.log('watch: node scripts/echomimic_remote_build.js status');
}

// ── build: kaniko on a CPU pod -> GHCR ──
async function buildImage() {
  const state = loadState();
  const ghcrUser = requiredEnv('GHCR_USER');
  const ghcrToken = requiredEnv('GHCR_TOKEN');
  const image = IMAGE();

  // build context = worker dir tar (Dockerfile + constraints + handler)
  const { execFileSync } = require('child_process');
  const ctxLocal = path.join(__dirname, '..', 'tmp', 'echomimic_ctx.tar.gz');
  fs.mkdirSync(path.dirname(ctxLocal), { recursive: true });
  execFileSync('tar', ['-czf', ctxLocal, '-C', WORKER_DIR, 'Dockerfile', 'constraints.txt', 'handler.py']);
  await uploadToR2(ctxLocal, 'ctx.tar.gz', { key: `${PREFIX}/ctx.tar.gz` });
  fs.unlinkSync(ctxLocal);

  const ctx = await presignR2(`${PREFIX}/ctx.tar.gz`, { method: 'GET', expiresIn: 172800 });
  const log = await presignPair(`${PREFIX}/build_log.txt`);
  const done = await presignPair(`${PREFIX}/build_done.txt`);

  const auth = Buffer.from(`${ghcrUser}:${ghcrToken}`).toString('base64');
  // kaniko:debug only has busybox (wget = GET-only, no curl) — grab a static
  // curl first so the R2 log/done PUT pushes work.
  const cmd =
    'set -e; mkdir -p /kaniko/.docker /workspace/ctx /tmp; ' +
    'wget -q -O /tmp/curl https://github.com/moparisthebest/static-curl/releases/download/v8.11.0/curl-amd64 && chmod +x /tmp/curl; ' +
    'printf \'{"auths":{"ghcr.io":{"auth":"%s"}}}\' "$GHCR_AUTH" > /kaniko/.docker/config.json; ' +
    'wget -q -O /tmp/ctx.tar.gz "$CTX_URL"; tar -xzf /tmp/ctx.tar.gz -C /workspace/ctx; ' +
    '( /kaniko/executor --context dir:///workspace/ctx --dockerfile /workspace/ctx/Dockerfile ' +
    `--destination ${image} --compressed-caching=false --snapshot-mode=redo > /tmp/build.log 2>&1; ` +
    'echo "EXIT:$?" >> /tmp/build.log; /tmp/curl -sf -X PUT -H "Content-Type: text/plain" -T /tmp/build.log "$LOG_PUT" || true; ' +
    'grep -q "EXIT:0" /tmp/build.log && printf ok | /tmp/curl -sf -X PUT -H "Content-Type: text/plain" -T - "$DONE_PUT" || true ) & ' +
    'BUILD_PID=$!; while kill -0 $BUILD_PID 2>/dev/null; do sleep 30; ' +
    '/tmp/curl -sf -X PUT -H "Content-Type: text/plain" -T /tmp/build.log "$LOG_PUT" || true; done; sleep 300';

  const resp = await rp().post('/pods', {
    name: 'echomimic-kaniko-build',
    computeType: 'CPU',
    // Memory-optimized (8GB/vCPU): the 'c' flavors (2GB/vCPU) OOM'd twice at
    // the stringzilla source build — container crash-looped, build restarted
    // from scratch. 8 vCPU also caps gcc parallelism.
    cpuFlavorIds: ['cpu5m', 'cpu3m'],
    vcpuCount: 8,
    containerDiskInGb: 80,
    dataCenterIds: [DATACENTER],
    imageName: 'gcr.io/kaniko-project/executor:debug',
    env: { CTX_URL: ctx, LOG_PUT: log.put, DONE_PUT: done.put, GHCR_AUTH: auth },
    // executor:debug ENTRYPOINT is /busybox/sh — without this override the
    // start cmd becomes `/busybox/sh sh -c <script>` and busybox tries to
    // open a script file literally named "sh" (silent crash loop).
    dockerEntrypoint: ['/busybox/sh', '-c'],
    dockerStartCmd: [cmd]
  });

  state.buildPod = resp.data.id;
  state.buildLog = log.get;
  state.buildDone = done.get;
  state.image = image;
  saveState(state);
  console.log(`kaniko build pod created: ${resp.data.id}`);
  console.log(`image will land at: ${image}`);
  console.log('watch: node scripts/echomimic_remote_build.js status');
}

// ── deploy: template + serverless endpoint with the network volume ──
async function deploy() {
  const state = loadState();
  if (!state.image) { console.error('no image in state — run build first'); process.exit(1); }
  const REGISTRY_AUTH_ID = process.env.RUNPOD_REGISTRY_AUTH_ID || 'cmqbmaacd0087ydrg4vz947hv'; // ghcr-auraflux

  const tpl = await rp().post('/templates', {
    name: 'echomimic-worker',
    imageName: state.image,
    containerRegistryAuthId: REGISTRY_AUTH_ID,
    containerDiskInGb: 40,
    isServerless: true,
    env: { MODELS_DIR: '/runpod-volume/models' }
  });
  state.templateId = tpl.data.id;
  saveState(state);
  console.log(`template created: ${tpl.data.id}`);

  const ep = await rp().post('/endpoints', {
    name: 'echomimic-v3-flash',
    templateId: state.templateId,
    gpuTypeIds: ['NVIDIA A40', 'NVIDIA L40S', 'NVIDIA RTX 6000 Ada Generation'],
    gpuCount: 1,
    workersMin: 0,
    workersMax: 2,
    idleTimeout: 120, // keeps the worker warm between scenes of one job
    executionTimeoutMs: 1800000,
    networkVolumeId: VOLUME_ID,
    dataCenterIds: [DATACENTER],
    flashboot: true
  });
  state.endpointId = ep.data.id;
  saveState(state);
  console.log(`endpoint created: ${ep.data.id}`);
  console.log(`set in .env: ECHOMIMIC_ENDPOINT_ID=${ep.data.id}`);
}

async function status() {
  const state = loadState();
  for (const phase of ['populate', 'build']) {
    const logUrl = state[`${phase}Log`];
    if (!logUrl) continue;
    console.log(`\n===== ${phase} =====`);
    const podId = state[`${phase}Pod`];
    if (podId) {
      try {
        const p = await rp().get(`/pods/${podId}`);
        console.log(`pod ${podId}: ${p.data.desiredStatus || p.data.status || JSON.stringify(p.data).slice(0, 120)}`);
      } catch (e) {
        console.log(`pod ${podId}: ${e.response?.status === 404 ? 'terminated' : e.message}`);
      }
    }
    try {
      const done = await axios.get(state[`${phase}Done`], { timeout: 10000, validateStatus: null });
      console.log(`done marker: ${done.status === 200 ? 'YES — phase complete' : 'not yet'}`);
    } catch (e) { console.log('done marker: unreachable'); }
    try {
      const log = await axios.get(logUrl, { timeout: 15000, validateStatus: null });
      if (log.status === 200) {
        const tail = String(log.data).split('\n').slice(-25).join('\n');
        console.log(`--- log tail ---\n${tail}`);
      } else {
        console.log('log: not yet written');
      }
    } catch (e) { console.log(`log fetch failed: ${e.message}`); }
  }
}

async function cleanup() {
  const state = loadState();
  for (const k of ['populatePod', 'buildPod']) {
    if (!state[k]) continue;
    try {
      await rp().delete(`/pods/${state[k]}`);
      console.log(`terminated ${k}: ${state[k]}`);
    } catch (e) {
      console.log(`${k} ${state[k]}: ${e.response?.status === 404 ? 'already gone' : e.message}`);
    }
    delete state[k];
  }
  saveState(state);
}

const cmd = process.argv[2];
const actions = { populate, build: buildImage, deploy, status, cleanup };
if (!actions[cmd]) {
  console.log('usage: node scripts/echomimic_remote_build.js <populate|build|deploy|status|cleanup>');
  process.exit(1);
}
actions[cmd]().catch((e) => {
  console.error(e.response?.data ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
