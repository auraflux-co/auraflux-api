#!/usr/bin/env node
/**
 * QA the REAL operator clicks:
 *   1) paste URL → click "URL → Library" → see checked pick → COMPOSE →
 *   2) attach MP4 → click "Import MP4 → Library" → see checked pick → COMPOSE →
 *
 * Does NOT call openStagedImportInComposer() directly.
 *
 *   node scripts/qa_import_library_compose_e2e.js
 *   CWN_QA_MP4=/path/to/file.mp4 CWN_QA_YT_URL=https://...
 */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = process.env.CWN_QA_BASE || 'http://localhost:3000';
const YT = process.env.CWN_QA_YT_URL || 'https://www.youtube.com/watch?v=SGC45IFoShA';
const MP4 = process.env.CWN_QA_MP4
  || path.join(__dirname, '..', 'tmp', 'fb_reel', 'reel_sd.mp4');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function fail(step, detail) {
  console.error(JSON.stringify({ pass: false, step, ...detail }, null, 2));
  process.exit(1);
}

async function waitForApi(page) {
  for (let i = 0; i < 30; i++) {
    const health = await page.evaluate(async (base) => {
      try {
        const r = await fetch(base + '/health');
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return { ok: false }; }
      } catch (e) { return { ok: false }; }
    }, BASE);
    if (health && health.ok) return health;
    await new Promise((r) => setTimeout(r, 400));
  }
  fail('health', { error: 'API not ready' });
}

async function openFreshLibrary(page) {
  await page.goto(BASE + '/?page=library&qa=' + Date.now(), { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    try {
      sessionStorage.removeItem('cwn_library_source_mode');
      sessionStorage.removeItem('cwn_composer_handoff');
    } catch (e) { /* ignore */ }
    // Clear prior picks so this run is isolated
    if (typeof _twitchPickerStreamers !== 'undefined') _twitchPickerStreamers = [];
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await waitForApi(page);
  await page.evaluate(() => {
    if (typeof setLibrarySourceMode === 'function') setLibrarySourceMode('streamers');
    if (typeof nav === 'function') nav('library');
  });
}

async function libraryImportState(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('library-panel-streamers');
    const picker = document.getElementById('twitch-inline-picker');
    const composeBtn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'COMPOSE →');
    const urlBtn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'URL → Library');
    const mp4Btn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'Import MP4 → Library');
    const picked = (typeof collectCompPickedClips === 'function')
      ? collectCompPickedClips()
      : [];
    return {
      mode: (document.getElementById('library-source-mode') || {}).value,
      panelVisible: !!(panel && panel.offsetParent !== null),
      pickerHasCard: !!(picker && picker.querySelector('.gen-picker-card.is-selected, .gen-picker-card')),
      pickerText: picker ? picker.innerText.replace(/\s+/g, ' ').slice(0, 240) : '',
      composeVisible: !!(composeBtn && composeBtn.offsetParent !== null),
      urlBtnVisible: !!(urlBtn && urlBtn.offsetParent !== null),
      mp4BtnVisible: !!(mp4Btn && mp4Btn.offsetParent !== null),
      picked: picked.length,
      leadTitle: picked[0] && picked[0].clip && picked[0].clip.title,
      hasStaged: !!(picked[0] && picked[0].clip
        && (picked[0].clip.playbackUrl || picked[0].clip.stagedUrl || picked[0].clip.r2Url)),
      status: (document.getElementById('twitch-fetch-status') || {}).textContent || '',
      onLibrary: !!(document.getElementById('page-library') || {}).classList.contains('active')
    };
  });
}

async function clickComposeAndAssert(page, flow) {
  await page.evaluate(() => {
    const composeBtn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'COMPOSE →');
    if (!composeBtn) throw new Error('COMPOSE button missing');
    if (!composeBtn.offsetParent) throw new Error('COMPOSE button not visible');
    composeBtn.click();
  });
  await page.waitForFunction(() => {
    const gen = document.getElementById('page-generate');
    return gen && gen.classList.contains('active');
  }, { timeout: 45000 });
  await new Promise((r) => setTimeout(r, 800));
  const after = await page.evaluate(() => {
    const picked = collectCompPickedClips();
    const lead = picked[0] && picked[0].clip;
    const summary = document.getElementById('composer-handoff-summary');
    const lineup = document.getElementById('twitch-comp-lineup');
    return {
      onGenerate: !!(document.getElementById('page-generate') || {}).classList.contains('active'),
      picked: picked.length,
      leadTitle: lead && lead.title,
      hasStaged: !!(lead && (lead.playbackUrl || lead.stagedUrl || lead.r2Url)),
      summaryText: summary ? summary.innerText.replace(/\s+/g, ' ').slice(0, 200) : null,
      lineupText: lineup ? lineup.innerText.replace(/\s+/g, ' ').slice(0, 200) : null
    };
  });
  if (!after.onGenerate || after.picked < 1 || !after.hasStaged) {
    fail(flow + '-compose', { after });
  }
  return after;
}

async function flowUrlToLibrary(page) {
  await openFreshLibrary(page);
  // Type into the real input, click the real button
  await page.focus('#library-paste-url');
  await page.evaluate((url) => {
    const input = document.getElementById('library-paste-url');
    input.value = url;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, YT);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'URL → Library');
    if (!btn || !btn.offsetParent) throw new Error('URL → Library not visible');
    btn.click();
  });

  // Wait until import lands as a checked library pick (status or card)
  await page.waitForFunction(() => {
    try {
      if (typeof collectCompPickedClips !== 'function') return false;
      const picked = collectCompPickedClips();
      if (!picked.length) return false;
      const c = picked[0].clip || {};
      return !!(c.playbackUrl || c.stagedUrl || c.r2Url);
    } catch (e) { return false; }
  }, { timeout: 180000 });

  const afterImport = await libraryImportState(page);
  if (
    !afterImport.panelVisible
    || !afterImport.composeVisible
    || !afterImport.pickerHasCard
    || afterImport.picked < 1
    || !afterImport.hasStaged
    || afterImport.mode !== 'streamers'
  ) {
    fail('url-after-import', { afterImport });
  }
  const afterCompose = await clickComposeAndAssert(page, 'url');
  return { afterImport, afterCompose };
}

async function flowMp4ToLibrary(page) {
  if (!fs.existsSync(MP4)) fail('mp4-missing', { MP4 });
  await openFreshLibrary(page);

  const fileInput = await page.$('#library-import-file');
  if (!fileInput) fail('mp4-input-missing', {});
  await fileInput.uploadFile(MP4);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'Import MP4 → Library');
    if (!btn || !btn.offsetParent) throw new Error('Import MP4 → Library not visible');
    btn.click();
  });

  await page.waitForFunction(() => {
    try {
      if (typeof collectCompPickedClips !== 'function') return false;
      const picked = collectCompPickedClips();
      if (!picked.length) return false;
      const c = picked[0].clip || {};
      return !!(c.playbackUrl || c.stagedUrl || c.r2Url);
    } catch (e) { return false; }
  }, { timeout: 180000 });

  const afterImport = await libraryImportState(page);
  if (
    !afterImport.panelVisible
    || !afterImport.composeVisible
    || !afterImport.pickerHasCard
    || afterImport.picked < 1
    || !afterImport.hasStaged
    || afterImport.mode !== 'streamers'
  ) {
    fail('mp4-after-import', { afterImport });
  }
  const afterCompose = await clickComposeAndAssert(page, 'mp4');
  return { afterImport, afterCompose };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const alerts = [];
  page.on('dialog', async (d) => { alerts.push(d.message()); await d.dismiss(); });

  const urlResult = await flowUrlToLibrary(page);
  const mp4Result = await flowMp4ToLibrary(page);

  const pass = alerts.length === 0
    && urlResult.afterCompose.hasStaged
    && mp4Result.afterCompose.hasStaged;
  console.log(JSON.stringify({
    pass,
    alerts,
    yt: YT,
    mp4: MP4,
    urlFlow: urlResult,
    mp4Flow: mp4Result
  }, null, 2));
  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
