'use strict';
/**
 * CPD-1122 — Clip Library dashboard E2E (no HeyGen / Avatar VOD).
 * Clicks real dashboard buttons: Load library → COMPOSE → EXECUTE.
 *
 * Usage: node scripts/cpd1122_library_dashboard_e2e.js
 * Env: C0_BASE=http://localhost:3000
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.C0_BASE || 'http://localhost:3000';
const STREAMER = (process.env.C0_E2E_STREAMER || 'lacy').toLowerCase();
const ASSEMBLY_TIMEOUT_MS = parseInt(process.env.C0_E2E_ASSEMBLY_MS || '600000', 10);

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
      // Staging may finish on COMPOSE; require no stuck DOWNLOADING state
      if (downloading === 0 && selected > 0) return { done: true, streamers: streamers.length, selected, staged, downloading, errors };
    });
    if (s && s.fail) throw new Error('clip stage errors');
    return s && s.done ? s : null;
  }, 'clip staging', 180000, 2000);
}

async function clickCompose(page, panel, timeoutMs) {
  const btn = page.locator('#library-panel-' + panel + ' .gen-action-bar button.btn-gold').first();
  await btn.scrollIntoViewIfNeeded();
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
    const btn = document.getElementById('btn-composer-execute');
    if (btn && !btn.disabled && typeof executeFromComposer === 'function') executeFromComposer();
  });
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

async function pollJobStage(jobId) {
  const start = Date.now();
  let lastStage = '';
  while (Date.now() - start < ASSEMBLY_TIMEOUT_MS) {
    const data = await apiGet('/job/' + encodeURIComponent(jobId));
    const job = data.job || data;
    const stage = job.stage || job.status || '';
    if (stage && stage !== lastStage) {
      console.log('  job ' + jobId + ' → ' + stage);
      lastStage = stage;
    }
    if (['awaiting_review', 'metadata_review', 'published', 'hook_review'].includes(stage)
      || job.status === 'completed') {
      return { ok: true, stage: stage || job.status };
    }
    if (stage === 'failed' || job.assemblyError) {
      return { ok: false, stage, error: job.assemblyError || 'failed' };
    }
    await sleep(5000);
  }
  return { ok: false, stage: lastStage, error: 'assembly timeout' };
}

async function runStreamersFlow(page) {
  await goLibraryTab(page, 'streamers');
  await page.evaluate((handles) => {
    if (typeof setSelectedStreamers === 'function') setSelectedStreamers(handles);
    if (typeof renderStreamerChips === 'function') renderStreamerChips();
  }, [STREAMER, 'jasontheween']);

  await page.locator('#btn-preview-twitch').click();
  await waitForLoadButton(page, 'btn-preview-twitch');
  await page.waitForFunction(() => (window._twitchPickerStreamers || []).some((e) => (e.clips || []).length > 0), { timeout: 120000 });

  const clipState = await waitForClipStaging(page);
  log('streamers: load library + R2 staging (no stuck DOWNLOADING)', true, JSON.stringify(clipState));

  await clickCompose(page, 'streamers');
  log('streamers: COMPOSE →', true, 'composer open');

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
  log('streamers: post-COMPOSE staging', postCompose.stuck === 0 && postCompose.staged > 0,
    JSON.stringify(postCompose));

  const { jobId } = await dispatchJob(page, 'comp');
  log('streamers: EXECUTE →', true, 'jobId=' + jobId);

  const asm = await pollJobStage(jobId);
  log('streamers: assembly', asm.ok, asm.ok ? asm.stage : (asm.error || asm.stage));
  return asm.ok;
}

async function runWireFlow(page) {
  await goLibraryTab(page, 'wire');
  await page.evaluate(() => { window._newsPickerStories = []; });
  await page.locator('#btn-library-wire-load').click();
  await waitForLoadButton(page, 'btn-library-wire-load');

  const loaded = await waitUntil(async () => page.evaluate(() => {
    const stories = window._newsPickerStories || [];
    const withHls = stories.filter((s) => s.hlsUrl).length;
    return stories.length ? { done: true, n: stories.length, withHls } : null;
  }), 'wire stories', 120000, 1500);

  log('wire: load library', loaded.withHls > 0, loaded.n + ' stories, ' + loaded.withHls + ' HLS');

  const pickIdx = await page.evaluate(() => {
    const stories = window._newsPickerStories || [];
    for (let i = 0; i < stories.length; i++) {
      if (stories[i].hlsUrl) { stories[i].selected = true; return i; }
    }
    return -1;
  });
  if (pickIdx < 0) throw new Error('no HLS story');

  await clickCompose(page, 'wire', 300000);
  log('wire: COMPOSE → composer', true, 'story #' + pickIdx);

  const staged = await waitUntil(async () => page.evaluate(() => {
    const picked = (window._newsPickerStories || []).filter((s) => s.selected);
    if (!picked.length) return null;
    const ready = picked.every((s) => !!(s.stagedUrl || s.playbackUrl));
    const err = picked.find((s) => s.stageError);
    if (err) return { done: false, fail: err.stageError };
    return ready ? { done: true, picked: picked.length } : null;
  }), 'wire R2 staging', 180000, 2000);

  if (staged.fail) throw new Error(staged.fail);
  log('wire: live HLS → R2 staging', true, JSON.stringify(staged));

  const { jobId } = await dispatchJob(page, 'short');
  log('wire: EXECUTE →', true, 'jobId=' + jobId);

  const asm = await pollJobStage(jobId);
  log('wire: assembly', asm.ok, asm.ok ? asm.stage : (asm.error || asm.stage));
  return asm.ok;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));

  let exitCode = 0;
  try {
    const health = await apiGet('/health');
    log('server health', !!health.ok, health.gitHash || '');
  } catch (e) {
    log('server health', false, e.message);
    exitCode = 1;
  }

  for (const [name, fn] of [['streamers', runStreamersFlow], ['wire', runWireFlow]]) {
    if (process.env.C0_E2E_FLOW && process.env.C0_E2E_FLOW !== name) continue;
    try {
      if (!await fn(page)) exitCode = 1;
    } catch (e) {
      log(name + ' flow', false, e.message);
      exitCode = 1;
    }
  }

  await browser.close();
  const outPath = path.join(__dirname, '../logs/cpd1122_library_e2e.json');
  fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  console.log('\nWrote ' + outPath);
  console.log('Summary: ' + results.filter((r) => r.ok).length + '/' + results.length + ' passed');
  process.exit(exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
