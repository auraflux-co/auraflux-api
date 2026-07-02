#!/usr/bin/env node
'use strict';
/**
 * Surgical reassemble for script_twitch_1782857743249 (Episode 4).
 * Only fix-related segments change: Yonna clip swap, phonetics, scene holds, cold open.
 *
 * Usage:
 *   node scripts/surgical_fix_ep4_twitch.js prepare   # patch job card in Postgres
 *   bash scripts/deploy_c0.sh                         # reload in-memory jobs
 *   node scripts/surgical_fix_ep4_twitch.js run       # HeyGen delta + reassemble
 *   node scripts/surgical_fix_ep4_twitch.js all       # prepare + deploy + run
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync } = require('child_process');
const path = require('path');
const axios = require('axios');

const JOB_ID = 'script_twitch_1782857743249';
const BASE = process.env.C0_BASE_URL || 'http://localhost:3000';
const STREAMER_SWAP = 'yonnajay';
const FORCE_HEYGEN_SCENES = [
  'CINNA_INTRO',
  'EXTRAEMILY_INTRO',
  'EMIRU_INTRO',
  'EMIRU_CLIP1_REACTION',
  'EMIRU_CLIP2_REACTION',
  'YONNAJAY_INTRO',
  'YONNAJAY_CLIP1_REACTION',
  'YONNAJAY_CLIP2_REACTION',
  'OUTRO',
];

function ensureYonnaClipSwap(card) {
  const { swapStreamerClipPairOnCard } = require('../lib/twitch_clip_script_align');
  const clips = card.orderedClipUrls || [];
  const yonnaIdx = [];
  for (let i = 0; i < clips.length; i++) {
    const ck = String(clips[i]?.streamer || clips[i]?.displayName || '').toLowerCase();
    if (ck.includes('yonna')) yonnaIdx.push(i);
  }
  if (yonnaIdx.length !== 2) {
    return { ok: false, reason: `expected 2 Yonna clips, found ${yonnaIdx.length}` };
  }
  const firstTitle = String(clips[yonnaIdx[0]]?.title || '');
  if (firstTitle === 'COME TO GREECE') {
    return swapStreamerClipPairOnCard(card, STREAMER_SWAP);
  }
  return { ok: true, skipped: true, indices: yonnaIdx };
}

function norm(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function buildHeygenMergedScenes(scriptRaw, contentType = 'twitch') {
  const { parseScriptIntoScenes } = require('../lib/qa');
  const { mergeStreamerBlockHeyGenScenes } = require('../lib/soup_intro_clip1_merge');
  const { injectStudioLaughPausesInScript } = require('../lib/studio_laughter');
  const { injectSceneResetHoldsInScript } = require('../lib/soup_scene_reset_holds');

  let script = String(scriptRaw || '')
    .replace(/^HOOK:\s*/mg, '')
    .replace(/^REACTION:\s*/mg, '')
    .replace(/^CAPTION:\s*.+$/mg, '')
    .replace(/\[(?:pause|beat)[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  script = injectStudioLaughPausesInScript(script);
  script = injectSceneResetHoldsInScript(script);

  let scenes = parseScriptIntoScenes(script, { contentType });
  scenes = mergeStreamerBlockHeyGenScenes(scenes, { contentType });
  return scenes.filter((s) => s.type !== 'source_clip');
}

function scenesToRerender(card) {
  const oldMap = card.heygen?.sceneTextMap || {};
  const merged = buildHeygenMergedScenes(card.script?.raw, card.contentType || 'twitch');
  const changed = [];
  for (const sc of merged) {
    const oldText = norm(oldMap[sc.name]?.text);
    const newText = norm(sc.text);
    if (oldText !== newText) changed.push(sc.name);
  }
  return changed;
}

function rebuildScriptScenes(card) {
  const { parseScriptIntoScenes } = require('../lib/qa');
  const contentType = card.contentType || 'twitch';
  card.script.scenes = parseScriptIntoScenes(card.script.raw, { contentType });
}

async function loadCardFromDb() {
  const db = require('../lib/db');
  await db.initDb();
  const cards = await db.loadAllJobs();
  const card = cards.find((c) => c.jobId === JOB_ID);
  if (!card) throw new Error(`Job not found in DB: ${JOB_ID}`);
  return card;
}

async function saveCard(card) {
  card.savedAt = new Date().toISOString();
  const { saveJobCard } = require('../lib/job_card');
  saveJobCard(JOB_ID, card);
  syncCardToJobsJson(card);
}

function syncCardToJobsJson(card) {
  const jobsPath = path.join(__dirname, '..', 'data', 'jobs.json');
  let all = {};
  try {
    all = JSON.parse(require('fs').readFileSync(jobsPath, 'utf8'));
  } catch (_) {
    all = {};
  }
  all[JOB_ID] = card;
  require('fs').writeFileSync(jobsPath, JSON.stringify(all, null, 2));
  console.log('[sync] Updated data/jobs.json for', JOB_ID);
}

function invalidateHeygenScenes(card, sceneNames) {
  const set = new Set(sceneNames);
  const jobs = card.heygen?.videoJobs || [];
  for (const vj of jobs) {
    if (!set.has(vj.sceneName)) continue;
    delete vj.video_id;
    delete vj.video_url;
    delete vj._url;
    vj.status = 'pending';
  }
  card.heygen = { ...(card.heygen || {}), videoJobs: jobs };
}

async function prepareCard() {
  console.log(`[prepare] Loading ${JOB_ID} from Postgres…`);
  const card = await loadCardFromDb();
  const preserve = {
    episodeNumber: card.episodeNumber || card.publishedEpisodeNumber || 4,
    publishedEpisodeNumber: card.publishedEpisodeNumber || 4,
    publishCopy: card.publishCopy,
    designSpec: card.designSpec,
    sceneOrderHeygenConfirmedAt: card.sceneOrderHeygenConfirmedAt,
    thumbnail: card.thumbnail,
    title: card.title,
  };

  // Clear publish state; stay on all_sent for partial HeyGen rerender + reassemble
  delete card.publishRecord;
  delete card._gate3Approved;
  delete card.publishedAt;
  card.stage = 'all_sent';

  const swap = ensureYonnaClipSwap(card);
  console.log(
    `[prepare] Yonna clip swap: ${swap.ok ? (swap.skipped ? 'already correct' : 'swapped') : swap.reason || 'failed'}`,
    swap.indices || ''
  );

  const { sanitizeScriptForHeyGen } = require('../lib/heygen_spoken_sanitize');
  card.script.raw = sanitizeScriptForHeyGen(card.script.raw, { contentType: card.contentType || 'twitch' });
  rebuildScriptScenes(card);

  const diffChanged = scenesToRerender(card);
  const changed = [...new Set([...FORCE_HEYGEN_SCENES, ...diffChanged])];
  if (!swap.skipped && swap.ok) {
    for (const name of ['YONNAJAY_INTRO', 'YONNAJAY_CLIP1_REACTION', 'YONNAJAY_CLIP2_REACTION']) {
      if (!changed.includes(name)) changed.push(name);
    }
  }
  console.log(`[prepare] HeyGen scenes to re-render (${changed.length}):`, changed.join(', '));

  invalidateHeygenScenes(card, changed);
  card.stage = 'all_sent';
  card.surgicalFix = {
    at: new Date().toISOString(),
    changedScenes: changed,
    yonnaSwapped: !!swap.ok,
  };

  // Cold open — draft script only; VO generated after deploy via API
  const { buildColdOpenScriptDraft } = require('../lib/twitch_bookends');
  const coldScript = buildColdOpenScriptDraft(card);
  card.coldOpen = {
    ...(card.coldOpen || {}),
    script: coldScript,
    approved: false,
    audioApproved: false,
    beats: require('../lib/twitch_bookends').collectColdOpenClipBeats(card),
  };

  Object.assign(card, preserve);
  card.episodeNumber = preserve.episodeNumber;
  card.episodeCounterIncremented = true; // do not bump on republish

  await saveCard(card);
  console.log('[prepare] ✅ Card saved to Postgres');
  console.log('[prepare] New cold open script:', coldScript.slice(0, 120) + '…');
  return { changed, coldScript };
}

function deployC0() {
  console.log('[deploy] Reloading auraflux from Postgres…');
  execSync('bash scripts/deploy_c0.sh', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
}

async function apiPost(route, body = {}) {
  const res = await axios.post(`${BASE}${route}`, body, {
    timeout: 120000,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`${route} → ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function getJob() {
  const res = await axios.get(`${BASE}/job/${encodeURIComponent(JOB_ID)}`, { timeout: 30000 });
  if (res.status >= 400) throw new Error(`GET job failed: ${res.status}`);
  return res.data.job;
}

async function waitForHeyGenComplete(timeoutMs = 900000) {
  const start = Date.now();
  const changed = new Set((await getJob()).surgicalFix?.changedScenes || []);
  while (Date.now() - start < timeoutMs) {
    const job = await getJob();
    const vjs = job.heygen?.videoJobs || [];
    const avatarJobs = vjs.filter((v) => v.sceneName && v.sceneName !== 'source_clip');
    const pendingChanged = avatarJobs.filter(
      (v) => changed.has(v.sceneName) && (v.status !== 'completed' || !v.video_id)
    );
    const pendingAny = avatarJobs.filter((v) => v.status !== 'completed' || !v.video_id);
    const stage = job.stage || '';
    console.log(
      `[poll] stage=${stage} pending changed=${pendingChanged.length} pending total=${pendingAny.length}`
    );
    if (pendingChanged.length === 0 && pendingAny.length === 0 && avatarJobs.length >= 14) {
      return job;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }
  throw new Error('HeyGen poll timeout');
}

async function waitForAssembly(timeoutMs = 900000) {
  const start = Date.now();
  const beforeMtime = (() => {
    try {
      return require('fs').statSync(
        path.join(__dirname, '..', 'output', 'cwn_8clips_script_twitch_1782857743249.mp4')
      ).mtimeMs;
    } catch (_) {
      return 0;
    }
  })();
  while (Date.now() - start < timeoutMs) {
    const job = await getJob();
    const stage = job.stage || '';
    let mtime = beforeMtime;
    try {
      mtime = require('fs').statSync(job.assembledPath).mtimeMs;
    } catch (_) { /* wait */ }
    const fresh = mtime > beforeMtime + 1000;
    console.log(`[poll] assembly stage=${stage} asm=${job.assemblyId} outputFresh=${fresh}`);
    if (fresh && (stage === 'assembled' || stage === 'awaiting_review' || job.localPreviewUrl)) {
      return job;
    }
    if (stage === 'assembly_failed') throw new Error('Assembly failed — check pm2 logs');
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('Assembly poll timeout');
}

async function runPipeline() {
  let job = await getJob();
  if (job.stage === 'published') {
    console.log('[run] Rollback published → assembled…');
    await apiPost(`/job/${encodeURIComponent(JOB_ID)}/rollback`);
    job = await getJob();
  } else {
    console.log(`[run] Stage=${job.stage} — skip rollback`);
  }
  const changed = job.surgicalFix?.changedScenes || [];
  console.log(`[run] Resubmit HeyGen for ${changed.length} changed scene(s)…`);

  await apiPost(`/job/${encodeURIComponent(JOB_ID)}/script`, { script: job.script?.raw || '' });

  await apiPost(`/job/${encodeURIComponent(JOB_ID)}/resubmit-avatar`, {
    forceRerender: true,
    onlyScenePattern: changed.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  });

  console.log('[run] Waiting for HeyGen…');
  await waitForHeyGenComplete();

  const coldScript =
    (await getJob()).coldOpen?.script ||
    require('../lib/twitch_bookends').buildColdOpenScriptDraft(await getJob());
  console.log('[run] Regenerating cold open VO…', coldScript.slice(0, 100) + '…');
  await apiPost(`/job/${encodeURIComponent(JOB_ID)}/cold-open/generate`, {
    script: coldScript,
    force: true,
  });
  await apiPost(`/job/${encodeURIComponent(JOB_ID)}/cold-open/approve`, {
    approved: true,
    audioApproved: true,
  });

  console.log('[run] Reassemble…');
  await apiPost(`/job/${encodeURIComponent(JOB_ID)}/reassemble`, {
    skipSceneOrderGate: true,
  });

  const final = await waitForAssembly();
  console.log('[run] ✅ Done');
  console.log(`  Preview: ${final.localPreviewUrl || `http://localhost:3000/download/${path.basename(final.assembledPath || '')}`}`);
  console.log(`  Path: ${final.assembledPath || final.outputPath || '—'}`);
  return final;
}

async function main() {
  const phase = process.argv[2] || 'all';
  if (phase === 'prepare') {
    await prepareCard();
    console.log('\nNext: bash scripts/deploy_c0.sh && node scripts/surgical_fix_ep4_twitch.js run');
    return;
  }
  if (phase === 'run') {
    await runPipeline();
    return;
  }
  if (phase === 'all') {
    await prepareCard();
    deployC0();
    await runPipeline();
    return;
  }
  console.error('Usage: prepare | run | all');
  process.exit(1);
}

main().catch((e) => {
  console.error('[surgical_fix]', e.message);
  process.exit(1);
});
