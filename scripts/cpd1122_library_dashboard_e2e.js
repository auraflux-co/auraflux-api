'use strict';
/**
 * CPD-1122 — Full dashboard gold path: Clip Library → Publish.
 * One continuous job — same buttons you use in production. No HeyGen / Avatar VOD.
 *
 *   Clip Library → Load library → COMPOSE → EXECUTE
 *   → Job Queue → Publish Prep (REVIEW SEO) → APPROVE & PUBLISH → Gate 5
 *
 * Usage:
 *   node scripts/cpd1122_library_dashboard_e2e.js
 *   C0_E2E_FLOW=streamers|wire   (default: streamers — wire may hit post-live publish hold)
 *   C0_E2E_SKIP_PUBLISH=1        (stop after Publish Prep, no platform upload)
 *
 * Env: C0_BASE=http://localhost:3000
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.C0_BASE || 'http://localhost:3000';
const STREAMER = (process.env.C0_E2E_STREAMER || 'lacy').toLowerCase();
const PIPELINE_TIMEOUT_MS = parseInt(process.env.C0_E2E_PIPELINE_MS || '1800000', 10);
const PUBLISH_TIMEOUT_MS = parseInt(process.env.C0_E2E_PUBLISH_MS || '600000', 10);
const SKIP_PUBLISH = process.env.C0_E2E_SKIP_PUBLISH === '1';

const results = [];

function log(step, ok, detail) {
  const row = { step, ok: !!ok, detail: detail || '' };
  results.push(row);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}${detail ? ' — ' + detail : ''}`);
}

function apiGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(new URL(urlPath, BASE), (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d, status: res.statusCode }); }
      });
    }).on('error', reject);
  });
}

function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = JSON.stringify(body || {});
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function confirmHooksIfNeeded(jobId) {
  const data = await apiGet('/job/' + encodeURIComponent(jobId));
  const job = data.job || data;
  if (!job || job.stage !== 'hook_review') return false;
  const hooks = job.clipHookTitles || [];
  if (!hooks.some((h) => String(h || '').trim())) {
    throw new Error('hook_review but no clipHookTitles on ' + jobId);
  }
  const resp = await apiPost('/job/' + encodeURIComponent(jobId) + '/confirm-hooks', {});
  if (!resp.ok) throw new Error(resp.error || 'confirm-hooks failed');
  console.log('  job ' + jobId + ' → confirm-hooks (assembly started)');
  return true;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(fn, label, timeoutMs, intervalMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last === true || (last && last.done)) return last;
    await sleep(intervalMs || 1500);
  }
  throw new Error('Timeout: ' + label + (last ? ' last=' + JSON.stringify(last) : ''));
}

function publishTitle(job) {
  const pc = job.publishCopy || {};
  return pc.title || pc.platforms?.youtube?.title || pc.platforms?.tiktok?.title || '';
}

async function pollJobPublishReady(jobId) {
  let lastStage = '';
  return waitUntil(async () => {
    const data = await apiGet('/job/' + encodeURIComponent(jobId));
    const job = data.job || data;
    if (!job || data.ok === false) return null;
    const stage = job.stage || job.status || '';
    if (stage && stage !== lastStage) {
      console.log('  job ' + jobId + ' → ' + stage);
      lastStage = stage;
    }
    if (stage === 'failed' || job.assemblyError) return { done: false, fail: job.assemblyError || 'failed' };
    const cloud = job.driveUrl || job.finalUrl;
    const title = publishTitle(job);
    const reviewStages = ['awaiting_review', 'metadata_review', 'publish_scheduled'];
    if (stage === 'hook_review') {
      await confirmHooksIfNeeded(jobId);
      return null;
    }
    if (cloud && title && reviewStages.includes(stage)) {
      return { done: true, stage, title: title.slice(0, 80), cloud: true };
    }
    return null;
  }, 'publish-ready (driveUrl + SEO title)', PIPELINE_TIMEOUT_MS, 8000);
}

async function pollJobPublished(jobId) {
  let lastStage = '';
  return waitUntil(async () => {
    const data = await apiGet('/job/' + encodeURIComponent(jobId));
    const job = data.job || data;
    const stage = job.stage || '';
    if (stage && stage !== lastStage) {
      console.log('  job ' + jobId + ' → ' + stage);
      lastStage = stage;
    }
    if (stage === 'published') return { done: true, stage };
    if (stage === 'gate5_failed') return { done: false, fail: 'gate5_failed' };
    return null;
  }, 'published', PUBLISH_TIMEOUT_MS, 10000);
}

async function ensureJobInDashboard(page, jobId) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (jid) => {
    const cardResp = await fetch('/job/' + encodeURIComponent(jid)).then((r) => r.json());
    if (!cardResp.ok || !cardResp.job) throw new Error('Job card missing on server');
    const sj = cardResp.job;
    if (!window.JOBS) window.JOBS = [];
    var job = JOBS.find(function(j) { return j.id === jid; });
    if (!job) {
      job = {
        id: jid,
        jobId: jid,
        title: sj.title || jid,
        type: sj.contentType || sj.type || 'twitch-short',
        stage: sj.stage,
        status: sj.status || 'completed',
        driveUrl: sj.driveUrl,
        finalUrl: sj.finalUrl,
        publishCopy: sj.publishCopy,
        clipsOnly: !!sj.clipsOnly,
        queuePinned: true,
      };
      JOBS.unshift(job);
      if (typeof markJobQueued === 'function') markJobQueued(jid, true);
      if (typeof saveJobs === 'function') saveJobs();
    }
    if (typeof mergeServerJobIntoLocal === 'function') mergeServerJobIntoLocal(jid, sj);
    if (typeof renderQueue === 'function') renderQueue();
  }, jobId);
}

async function trackJobToPublish(page, jobId, label) {
  const ready = await pollJobPublishReady(jobId);
  log(label + ': assembly + SEO ready', true, JSON.stringify(ready));

  await ensureJobInDashboard(page, jobId);
  await page.locator('button.sidebar-btn').filter({ hasText: 'Job Queue' }).click();
  log(label + ': Job Queue', true, jobId);

  await page.evaluate((jid) => {
    if (typeof navToPublishPrep === 'function') navToPublishPrep(jid);
  }, jobId);
  await page.waitForFunction(
    () => document.getElementById('page-publish')?.classList.contains('active'),
    null,
    { timeout: 30000 }
  );
  const prep = await page.evaluate(() => ({
    job: document.getElementById('pub-job-select')?.value || '',
    ytTitle: (document.getElementById('pub-yt-title')?.value || '').slice(0, 80),
  }));
  log(label + ': Publish Prep (REVIEW SEO)', !!(prep.job && prep.ytTitle), JSON.stringify(prep));

  if (SKIP_PUBLISH) {
    log(label + ': Gate 5 publish', true, 'skipped (C0_E2E_SKIP_PUBLISH=1)');
    return true;
  }

  const gate5Resp = page.waitForResponse(
    (r) => r.url().includes('/run-gate5') && r.status() === 200,
    { timeout: 120000 }
  );
  await page.evaluate((jid) => {
    if (typeof approveAndPublishJob === 'function') approveAndPublishJob(jid);
  }, jobId);
  const gate5 = await gate5Resp;
  const gate5Data = await gate5.json();
  if (!gate5Data.ok) {
    if (gate5Data.code === 'publish_hold_post_live') {
      log(label + ': Gate 5 publish', false, 'post-live publish hold — use streamers desk for full publish test');
      return false;
    }
    throw new Error(gate5Data.error || 'run-gate5 failed');
  }
  log(label + ': APPROVE & PUBLISH → Gate 5', true, jobId);

  const pub = await pollJobPublished(jobId);
  log(label + ': published on platforms', pub.done && !pub.fail, pub.stage || pub.fail || '');
  return pub.done && !pub.fail;
}

async function goLibraryTab(page, mode) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('button.sidebar-btn').filter({ hasText: 'Clip Library' }).click();
  await page.evaluate((m) => { if (typeof setLibrarySourceMode === 'function') setLibrarySourceMode(m); }, mode);
  await page.waitForSelector('#library-panel-' + mode, { state: 'attached' });
}

async function waitForLoadButton(page, btnId) {
  await waitUntil(async () => {
    const t = await page.locator('#' + btnId).textContent();
    const disabled = await page.locator('#' + btnId).isDisabled();
    return t && t.indexOf('Loading') < 0 && t.indexOf('FETCHING') < 0 && !disabled ? true : null;
  }, btnId + ' idle', 120000, 1000);
}

async function waitForClipStaging(page) {
  return waitUntil(async () => {
    const s = await page.evaluate(() => {
      const streamers = window._twitchPickerStreamers || [];
      let selected = 0, staged = 0, downloading = 0, errors = 0;
      streamers.forEach((e) => {
        (e.clips || []).forEach((c) => {
          if (!c.selected) return;
          selected++;
          if (c.stagedUrl || c.playbackUrl) staged++;
          else if (c.staging || c._stageInflight) downloading++;
          else if (c.stageError) errors++;
        });
      });
      if (!streamers.length || !selected) return { done: false, streamers: streamers.length, selected };
      if (downloading) return { done: false, selected, staged, downloading, errors };
      if (errors) return { done: false, selected, staged, errors, fail: true };
      if (downloading === 0 && selected > 0) return { done: true, streamers: streamers.length, selected, staged, downloading, errors };
    });
    if (s && s.fail) throw new Error('clip stage errors');
    return s && s.done ? s : null;
  }, 'clip staging', 180000, 2000);
}

async function clickCompose(page, panel, timeoutMs) {
  const btn = page.locator('#library-panel-' + panel + ' .gen-action-bar button.btn-gold').first();
  await btn.click({ force: true });
  await waitUntil(async () => page.evaluate(() => {
    const onGenerate = document.getElementById('page-generate')?.classList.contains('active');
    const summary = document.getElementById('composer-handoff-summary')?.textContent || '';
    return onGenerate && summary.indexOf('FROM LIBRARY') >= 0;
  }), 'composer handoff', timeoutMs || 180000, 2000);
}

async function clickExecute(page) {
  await page.evaluate(() => {
    document.getElementById('page-generate')?.classList.add('active');
    document.getElementById('generate-composer')?.classList.add('is-open');
  });
  await page.locator('#btn-composer-execute').click({ force: true, timeout: 120000 });
  await page.waitForFunction(() => {
    const m = document.getElementById('platform-modal');
    return m && m.style.display === 'flex';
  }, null, { timeout: 120000 });
  await page.evaluate(() => { if (typeof confirmPlatformModal === 'function') confirmPlatformModal(); });
}

async function dispatchJob(page, delivery) {
  await page.evaluate((d) => {
    const sel = document.getElementById('composer-delivery');
    if (sel) { sel.value = d; sel.dataset.userSet = '1'; }
    if (typeof refreshGenerateComposer === 'function') refreshGenerateComposer(true);
  }, delivery);

  await waitUntil(async () => page.evaluate(async () => {
    const btn = document.getElementById('btn-composer-execute');
    if (btn && btn.disabled) return null;
    const body = buildCompositionSpecFromUI();
    const r = await fetch('/composition/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    return r.validation && r.validation.ok ? { done: true } : null;
  }), 'composition validate', 120000, 2000);

  const jobResponse = page.waitForResponse(
    (r) => r.url().includes('/generate-clip-comp') && r.status() === 200,
    { timeout: 180000 }
  );
  await clickExecute(page);
  const resp = await jobResponse;
  const data = await resp.json();
  if (!data.ok || !data.jobId) throw new Error(data.error || 'generate-clip-comp failed');
  return { jobId: data.jobId };
}

async function runStreamersGoldPath(page) {
  const label = 'streamers';
  await goLibraryTab(page, 'streamers');
  await page.evaluate((handles) => {
    if (typeof setSelectedStreamers === 'function') setSelectedStreamers(handles);
    if (typeof renderStreamerChips === 'function') renderStreamerChips();
  }, [STREAMER, 'jasontheween']);

  await page.locator('#btn-preview-twitch').click();
  await waitForLoadButton(page, 'btn-preview-twitch');
  await page.waitForFunction(() => (window._twitchPickerStreamers || []).some((e) => (e.clips || []).length > 0), { timeout: 120000 });

  const clipState = await waitForClipStaging(page);
  log(label + ': Load library + R2 staging', true, JSON.stringify(clipState));

  await clickCompose(page, 'streamers');
  log(label + ': COMPOSE →', true, 'composer open');

  const postCompose = await page.evaluate(() => {
    let stuck = 0, staged = 0, selected = 0;
    (window._twitchPickerStreamers || []).forEach((e) => {
      (e.clips || []).forEach((c) => {
        if (!c.selected) return;
        selected++;
        if (c.staging && !c.stagedUrl) stuck++;
        if (c.stagedUrl || c.playbackUrl) staged++;
      });
    });
    return { selected, staged, stuck };
  });
  log(label + ': post-COMPOSE staging', postCompose.stuck === 0 && postCompose.staged > 0, JSON.stringify(postCompose));

  const { jobId } = await dispatchJob(page, 'comp');
  log(label + ': EXECUTE →', true, 'jobId=' + jobId);

  return trackJobToPublish(page, jobId, label);
}

async function runWireGoldPath(page) {
  const label = 'wire';
  await goLibraryTab(page, 'wire');
  await page.evaluate(() => { window._newsPickerStories = []; });
  await page.locator('#btn-library-wire-load').click();
  await waitForLoadButton(page, 'btn-library-wire-load');

  const loaded = await waitUntil(async () => page.evaluate(() => {
    const stories = window._newsPickerStories || [];
    const withHls = stories.filter((s) => s.hlsUrl).length;
    return stories.length ? { done: true, n: stories.length, withHls } : null;
  }), 'wire stories', 120000, 1500);
  log(label + ': Load library', loaded.withHls > 0, loaded.n + ' stories, ' + loaded.withHls + ' HLS');

  const pickIdx = await page.evaluate(() => {
    const stories = window._newsPickerStories || [];
    for (let i = 0; i < stories.length; i++) {
      if (stories[i].hlsUrl) { stories[i].selected = true; return i; }
    }
    return -1;
  });
  if (pickIdx < 0) throw new Error('no HLS story');

  await clickCompose(page, 'wire', 300000);
  log(label + ': COMPOSE →', true, 'story #' + pickIdx);

  const { jobId } = await dispatchJob(page, 'short');
  log(label + ': EXECUTE →', true, 'jobId=' + jobId);

  return trackJobToPublish(page, jobId, label);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));

  let exitCode = 0;
  const flow = process.env.C0_E2E_FLOW || 'streamers';
  console.log('Gold path E2E — flow=' + flow + (SKIP_PUBLISH ? ' (publish skipped)' : ' → publish'));

  try {
    const health = await apiGet('/health');
    log('server health', !!health.ok, health.gitHash || '');
  } catch (e) {
    log('server health', false, e.message);
    exitCode = 1;
  }

  const flows = {
    streamers: runStreamersGoldPath,
    wire: runWireGoldPath,
  };

  for (const name of Object.keys(flows)) {
    if (flow !== 'both' && flow !== name) continue;
    try {
      if (!await flows[name](page)) exitCode = 1;
    } catch (e) {
      log(name + ' gold path', false, e.message);
      exitCode = 1;
    }
  }

  await browser.close();
  const outPath = path.join(__dirname, '../logs/cpd1122_library_e2e.json');
  fs.writeFileSync(outPath, JSON.stringify({
    at: new Date().toISOString(),
    base: BASE,
    flow,
    skipPublish: SKIP_PUBLISH,
    results,
  }, null, 2));
  console.log('\nWrote ' + outPath);
  console.log('Summary: ' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
