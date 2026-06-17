#!/usr/bin/env node
'use strict';
/** Gate2 line C with ip_mask + heygen_frame + spike8. Run after pod is healthy. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { presignR2, uploadToR2 } = require('../lib/storage');
const echomimic = require('../lib/avatar/adapters/echomimic');
const { GATE2_LINES, SPIKE_INFERENCE, SPIKE_STEPS, SPIKE_MAX_FRAMES } = require('../lib/avatar/echomimic_spike');

const OUT = path.join(__dirname, '..', 'output', 'avatar_gate2');
const LINE = 'C_emotional_read';
const PORTRAIT = 'spike/cpd881/inputs/bobbyg_heygen_frame.png';
const DEST = 'C_emotional_read_ip_mask.mp4';
const CDN_KEY = 'qa/gate/gate2_C_ip_mask.mp4';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.ECHOMIMIC_PROFILE = 'spike';
  process.env.ECHOMIMIC_CHUNK = 'off';
  process.env.ECHOMIMIC_USE_IP_MASK = 'on';

  const { wakePod } = require('../lib/avatar/echomimic_pod');
  await wakePod();

  const lineDef = GATE2_LINES[LINE];
  const sampleSize = echomimic.resolveSampleSizePx();
  const folder = `avatar/echomimic/gate2_${Date.now().toString(36)}_${LINE}_ip_mask`;
  const outputKey = `${folder}/render.mp4`;

  const [imageGet, audioGet, outputPut] = await Promise.all([
    presignR2(PORTRAIT, { method: 'GET' }),
    presignR2(lineDef.audioKey, { method: 'GET' }),
    presignR2(outputKey, { method: 'PUT', contentType: 'video/mp4' })
  ]);

  const config = {
    steps: SPIKE_STEPS,
    sampleSize: [sampleSize, sampleSize],
    avatarId: PORTRAIT,
    inference: { ...SPIKE_INFERENCE },
    useIpMask: true
  };

  const jobInput = echomimic.buildRenderJobInput({
    config,
    videoLength: SPIKE_MAX_FRAMES,
    imageGet,
    audioGet,
    outputPut
  });
  const podId = process.env.ECHOMIMIC_POD_ID;
  const base = `https://${podId}-8000.proxy.runpod.net`;
  console.log(`[ip_mask] ${LINE} portrait=${PORTRAIT} → pod ${podId}`);

  const t0 = Date.now();
  const enqueue = await axios.post(`${base}/run`, { input: jobInput }, { timeout: 120000 });
  const jobId = enqueue.data?.job_id;
  if (!jobId) throw new Error(`enqueue failed: ${JSON.stringify(enqueue.data).slice(0, 200)}`);

  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    const st = await axios.get(`${base}/status/${jobId}`, { timeout: 30000 });
    if (st.data?.status === 'completed') {
      const res = st.data?.result || {};
      if (!res.ok) throw new Error(res.error || res.log_tail || 'render failed');
      console.log('[ip_mask] result:', JSON.stringify(res, null, 2));
      break;
    }
    if (st.data?.status === 'failed') throw new Error(st.data?.result?.error || 'render failed');
    await new Promise((r) => setTimeout(r, 15000));
  }

  const local = path.join(OUT, DEST);
  const url = await presignR2(outputKey, { method: 'GET' });
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(local, Buffer.from(resp.data));

  const cdn = await uploadToR2(local, DEST, {
    key: CDN_KEY,
    contentType: 'video/mp4',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[ip_mask] done (${sec}s)`);
  console.log(`CDN: ${cdn}`);
  console.log(`Local: ${local}`);
}

main().catch((e) => {
  console.error(`[ip_mask] ❌ ${e.message}`);
  process.exit(1);
});
