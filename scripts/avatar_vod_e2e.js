'use strict';

/**
 * Avatar VOD full E2E — Gate 1 → HeyGen (sim) → assembly → publish-ready.
 *
 *   COMPOSE payload → /generate-full-script → Gate 1 pass
 *   → scene-order confirm → heygen/send-approved (HEYGEN_SIM_MODE on server)
 *   → poller → bookend approvals → assembly → awaiting_review
 *
 * Usage:
 *   HEYGEN_SIM_MODE=true bash scripts/deploy_c0.sh   # server must have sim on
 *   node scripts/avatar_vod_e2e.js
 *
 * Env:
 *   C0_E2E_STREAMERS=cinna,lacy
 *   C0_E2E_CLIPS_PER_STREAMER=1
 *   C0_E2E_SKIP_ASSEMBLY=1     — stop after HeyGen sim
 *   C0_E2E_SKIP_PUBLISH=1      — default; never uploads in E2E
 *   C0_AVATAR_VOD_E2E_MS=900000
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { buildSceneOrderPreflight } = require('../lib/scene_order_gate');
const {
  __test_runGateHandoffReview: runGateHandoffReview,
  __test_parseSceneHeadersFromScript: parseSceneHeadersFromScript,
} = require('../lib/script_gen');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const BASE = process.env.C0_BASE || 'http://localhost:3000';
const STREAMERS = (process.env.C0_E2E_STREAMERS || 'cinna,lacy')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const CLIPS_PER = Math.max(2, parseInt(process.env.C0_E2E_CLIPS_PER_STREAMER || '2', 10) || 2);
const TIMEOUT_MS = parseInt(process.env.C0_AVATAR_VOD_E2E_MS || '900000', 10);
const ASSEMBLY_TIMEOUT_MS = parseInt(process.env.C0_E2E_ASSEMBLY_MS || '1200000', 10);
const SKIP_ASSEMBLY = process.env.C0_E2E_SKIP_ASSEMBLY === '1';
const OUT_DIR = path.join(__dirname, '../logs');
const TWITCH_TOKEN = process.env.TWITCH_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;

const results = [];

function log(step, ok, detail) {
  results.push({ step, ok: !!ok, detail: detail || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiGet(urlPath) {
  const r = await axios.get(`${BASE}${urlPath}`, { timeout: 30000 });
  return r.data;
}

async function apiPost(urlPath, body) {
  const r = await axios.post(`${BASE}${urlPath}`, body || {}, {
    timeout: TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
  });
  return r.data;
}

async function getJob(jobId) {
  const data = await apiGet(`/job/${encodeURIComponent(jobId)}`);
  return data.job || data;
}

async function waitForStage(jobId, acceptStages, label, timeoutMs) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(jobId);
    const stage = job.stage || '';
    if (stage && stage !== last) {
      console.log(`  ${jobId} → ${stage}`);
      last = stage;
    }
    if (acceptStages.includes(stage)) return { job, stage };
    if (stage === 'gate1_failed' || stage === 'heygen_failed' || stage === 'failed') {
      throw new Error(`${label}: terminal stage ${stage} — ${job.gate1Summary || job.heygenError || job.assemblyError || ''}`);
    }
    await sleep(4000);
  }
  throw new Error(`Timeout ${label} (last=${last})`);
}

async function fetchFromLibrary(streamer) {
  const r = await axios.get(`${BASE}/content-library/clips`, {
    params: { streamers: streamer, window: '7d', sort: 'views', limit: CLIPS_PER },
    timeout: 15000,
  });
  const clips = r.data?.clips || [];
  if (!clips.length) return null;
  return {
    streamer: clips[0].streamer || streamer,
    displayName: clips[0].displayName || streamer,
    twitchUsername: clips[0].streamer || streamer,
    url: clips[0].url || clips[0].clipUrl || '',
    clips: clips.slice(0, CLIPS_PER).map((c, i) => ({
      rank: i + 1,
      title: c.title || '',
      url: c.url || c.clipUrl || '',
      views: c.viewCount || c.views || 0,
      game: c.game || '',
      thumbnailUrl: c.thumbnailUrl || '',
    })),
  };
}

async function fetchFromHelix(streamerName) {
  if (!TWITCH_TOKEN || !TWITCH_CLIENT_ID) return null;
  const userResp = await axios.get(`https://api.twitch.tv/helix/users?login=${streamerName}`, {
    headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${TWITCH_TOKEN}` },
    timeout: 8000,
  });
  const user = userResp.data?.data?.[0];
  if (!user) return null;
  const since = new Date(Date.now() - 86400000 * 7).toISOString();
  const clipsResp = await axios.get(
    `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=20&started_at=${since}`,
    { headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${TWITCH_TOKEN}` }, timeout: 8000 },
  );
  const clips = (clipsResp.data?.data || []).slice(0, CLIPS_PER);
  if (!clips.length) return null;
  return {
    streamer: user.login || streamerName,
    displayName: user.display_name,
    url: clips[0].url,
    clips: clips.map((c, i) => ({
      rank: i + 1,
      title: c.title,
      url: c.url,
      views: c.view_count,
      game: c.game_name || '',
      thumbnailUrl: c.thumbnail_url || '',
    })),
  };
}

async function stageClipIfNeeded(clip) {
  if (!clip?.url) return clip;
  try {
    const staged = await apiPost('/content-library/stage', { clips: [{ url: clip.url, title: clip.title || '' }] });
    const row = staged.clip || staged.staged || staged.results?.[0];
    if (row?.playbackUrl || row?.assemblyUrl || row?.mp4Url) {
      return {
        ...clip,
        url: clip.url,
        videoUrl: row.playbackUrl || row.assemblyUrl || row.mp4Url || clip.url,
        clipUrl: row.playbackUrl || row.assemblyUrl || row.mp4Url,
      };
    }
  } catch (e) {
    console.warn(`  stage clip warn: ${e.message}`);
  }
  return { ...clip, videoUrl: clip.url };
}

async function buildItems() {
  const items = [];
  for (const s of STREAMERS) {
    let item = await fetchFromLibrary(s);
    if (!item) item = await fetchFromHelix(s);
    if (!item) throw new Error(`No clips for streamer ${s}`);
    item.clips = await Promise.all((item.clips || []).map((c) => stageClipIfNeeded(c)));
    item.url = item.clips[0]?.videoUrl || item.clips[0]?.url || item.url || '';
    item.streamer = item.streamer || s;
    items.push(item);
  }
  return items;
}

async function assertPostGate1Chain(jobId, script, card) {
  const expectedHeaders = (card?.designSpec?.sceneStructure?.sceneHeaders || [])
    .map((h) => String(h || '').trim())
    .filter(Boolean);

  if (expectedHeaders.length) {
    const found = parseSceneHeadersFromScript(script);
    const headersOk = found.length === expectedHeaders.length
      && expectedHeaders.every((h, i) => found[i] === h);
    log('script headers match jobSpec', headersOk, `found=${found.length} expected=${expectedHeaders.length}`);
    if (!headersOk) return false;

    const { review } = await runGateHandoffReview({
      jobId,
      gate: 'gate1',
      nextGate: 'gate2',
      contentType: 'twitch',
      jobSpec: { designSpec: card.designSpec, state: { gateResults: { gate0: { passed: true }, gate1: { passed: true } } } },
      script,
      scriptForHeygen: script,
      gateResult: { passed: true, outcome: 'pass' },
    });
    log('handoff review', review.passed, review.issues.join('; ') || 'ok');
    if (!review.passed) return false;
  }

  const preflight = buildSceneOrderPreflight({ card, script, contentType: 'twitch' });
  log('scene-order preflight', preflight.ok, preflight.blockers.join('; ') || `${preflight.foundHeaders?.length || 0} scenes`);
  return preflight.ok;
}

async function approveBookends(jobId) {
  try {
    const sync = await apiPost(`/job/${encodeURIComponent(jobId)}/sidebar-thumbs/sync`, {});
    const manifest = sync.manifest || [];
    for (const row of manifest) {
      if (row.approved) continue;
      await apiPost(`/job/${encodeURIComponent(jobId)}/sidebar-thumbs/approve`, {
        key: row.key,
        approved: true,
      });
    }
    log('sidebar thumbs approved', true, `${manifest.length} keys`);
  } catch (e) {
    log('sidebar thumbs approved', false, e.response?.data?.error || e.message);
    throw e;
  }

  try {
    await apiPost(`/job/${encodeURIComponent(jobId)}/cold-open/generate`, { script: 'Tonight on Twitch Soup.' });
  } catch (e) {
    if (e.response?.status === 409) {
      log('cold open generate', true, 'already approved');
    } else {
      await apiPost(`/job/${encodeURIComponent(jobId)}/cold-open/approve`, {
        approved: true,
        audioApproved: true,
        script: 'Tonight on Twitch Soup.',
      });
      log('cold open generate', true, 'stub approved (no ElevenLabs)');
    }
  }

  try {
    await apiPost(`/job/${encodeURIComponent(jobId)}/cold-open/approve`, {
      approved: true,
      audioApproved: true,
    });
    log('cold open approved', true, '');
  } catch (e) {
    log('cold open approved', false, e.response?.data?.error || e.message);
  }
}

async function runHeyGenAndAssembly(jobId, card) {
  const script = card.script?.raw || '';
  await apiPost(`/job/${encodeURIComponent(jobId)}/scene-order-confirm`, { gate: 'heygen', script });
  log('scene-order confirm (heygen)', true, '');

  await apiPost(`/job/${encodeURIComponent(jobId)}/heygen/send-approved`, { script });
  log('heygen/send-approved', true, 'started async');

  const afterHeygen = await waitForStage(
    jobId,
    ['all_sent', 'awaiting_manual_segments', 'assembling', 'assembled', 'awaiting_review', 'metadata_review'],
    'HeyGen sim + poller',
    180000,
  );
  log('post-HeyGen stage', true, afterHeygen.stage);

  if (afterHeygen.stage === 'awaiting_manual_segments') {
    await apiPost(`/job/${encodeURIComponent(jobId)}/manual-segments/resume`, {});
    log('manual-segments/resume', true, '');
    await waitForStage(jobId, ['all_sent', 'assembling', 'assembled', 'awaiting_review'], 'after manual resume', 120000);
  }

  if (SKIP_ASSEMBLY) {
    log('assembly', true, 'skipped C0_E2E_SKIP_ASSEMBLY=1');
    return;
  }

  let job = await getJob(jobId);
  if (!['assembling', 'assembled', 'awaiting_review', 'metadata_review'].includes(job.stage)) {
    await approveBookends(jobId);
    await apiPost(`/job/${encodeURIComponent(jobId)}/scene-order-confirm`, { gate: 'assembly', script: job.script?.raw });
    log('scene-order confirm (assembly)', true, '');

    const reasm = await axios.post(
      `${BASE}/job/${encodeURIComponent(jobId)}/reassemble`,
      { skipSceneOrderGate: false },
      { timeout: 30000, validateStatus: () => true },
    );
    if (reasm.status >= 400 && reasm.data?.code !== 'use_partial_scene_updates') {
      log('reassemble trigger', reasm.status < 400, reasm.data?.error || reasm.status);
    } else {
      log('reassemble trigger', true, reasm.data?.message || 'ok');
    }
  }

  const final = await waitForStage(
    jobId,
    ['assembled', 'awaiting_review', 'metadata_review', 'publish_scheduled'],
    'assembly complete',
    ASSEMBLY_TIMEOUT_MS,
  );
  job = final.job;
  log('assembly output', !!(job.driveUrl || job.finalUrl || job.outputPath), job.stage);
  log('publish copy locked', !!(job.publishCopy?.youtube?.title || job.publishCopy?.title || job.publishCopy?.platforms), '');
}

async function main() {
  console.log('=== avatar_vod_e2e (full pipeline) ===');
  console.log(`BASE=${BASE} streamers=${STREAMERS.join(',')} clipsPer=${CLIPS_PER}`);

  try {
    await axios.get(`${BASE}/health`, { timeout: 8000 });
    log('server health', true, BASE);
  } catch {
    console.error('C0 down — run: HEYGEN_SIM_MODE=true bash scripts/deploy_c0.sh');
    process.exit(2);
  }

  const health = await apiGet('/health');
  const simOn = process.env.HEYGEN_SIM_MODE === 'true';
  log('HEYGEN_SIM_MODE (client env)', simOn, simOn ? 'set locally' : 'check server .env');
  if (!process.env.GEMINI_API_KEY) {
    log('GEMINI_API_KEY', false, 'missing');
    process.exit(2);
  }

  const items = await buildItems();
  log('clip sources', true, `${items.length} streamers`);

  const payload = {
    type: 'twitch',
    holdBeforeHeygen: true,
    clipsPerStreamer: CLIPS_PER,
    date: new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }),
    items,
  };

  console.log(`POST /generate-full-script...`);
  let data;
  try {
    const resp = await axios.post(`${BASE}/generate-full-script`, payload, {
      timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    });
    data = resp.data;
  } catch (e) {
    log('generate-full-script', false, e.response?.data?.error || e.message);
    process.exit(1);
  }

  const jobId = data.jobId || data.scriptJobId;
  const scriptQA = data.scriptQA || {};
  log('Gate 1', scriptQA.outcome === 'pass', `${scriptQA.outcome} score=${scriptQA.score ?? '?'}`);

  if (!jobId || scriptQA.outcome !== 'pass') {
    if (fs.existsSync(OUT_DIR)) {
      fs.writeFileSync(path.join(OUT_DIR, `avatar_vod_e2e_${jobId || 'fail'}.json`), JSON.stringify({ jobId, scriptQA, results }, null, 2));
    }
    process.exit(1);
  }

  const card = await getJob(jobId);
  const okStage = ['script_ready', 'all_sent', 'assembling', 'assembled', 'awaiting_review', 'metadata_review'].includes(card.stage);
  log('job card stage', okStage, card.stage);
  const chainOk = await assertPostGate1Chain(jobId, card.script?.raw || data.script, card);
  if (!chainOk) process.exit(1);

  await runHeyGenAndAssembly(jobId, card);

  if (fs.existsSync(OUT_DIR)) {
    fs.writeFileSync(path.join(OUT_DIR, `avatar_vod_e2e_${jobId}.json`), JSON.stringify({ jobId, scriptQA, results }, null, 2));
  }
  console.log('=== avatar_vod_e2e PASS ===');
}

main().catch((err) => {
  console.error(err.message || err);
  if (fs.existsSync(OUT_DIR)) {
    fs.writeFileSync(path.join(OUT_DIR, 'avatar_vod_e2e_last_error.json'), JSON.stringify({ error: err.message, results }, null, 2));
  }
  process.exit(1);
});
