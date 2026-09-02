#!/usr/bin/env node
/**
 * QA: Import URL → Clip Library picks stay visible → COMPOSE → Generate
 * with staged playback. Catches setLibrarySourceMode('twitch') panel-hide regression.
 *
 * Usage: node scripts/qa_import_library_compose_e2e.js
 * Requires: localhost:3000 up, puppeteer + Chrome.
 */
const path = require('path');
const puppeteer = require('puppeteer');

const BASE = process.env.CWN_QA_BASE || 'http://localhost:3000';
const YT = process.env.CWN_QA_YT_URL || 'https://www.youtube.com/watch?v=SGC45IFoShA';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const alerts = [];
  page.on('dialog', async (d) => { alerts.push(d.message()); await d.dismiss(); });

  await page.goto(BASE + '/?page=library&qa=' + Date.now(), { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    try { sessionStorage.removeItem('cwn_library_source_mode'); } catch (e) { /* ignore */ }
  });
  await page.reload({ waitUntil: 'networkidle2' });

  // Wait for API (not HTML) — deploy can briefly serve before Express is ready
  for (let i = 0; i < 20; i++) {
    const health = await page.evaluate(async (base) => {
      try {
        const r = await fetch(base + '/health');
        const t = await r.text();
        try { return JSON.parse(t); } catch (e) { return { ok: false, raw: t.slice(0, 40) }; }
      } catch (e) { return { ok: false, err: String(e) }; }
    }, BASE);
    if (health && health.ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const staged = await page.evaluate(async (base, url) => {
    const r = await fetch(base + '/content-library/stage-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) {
      return { ok: false, error: 'non-json stage response', status: r.status, body: t.slice(0, 120) };
    }
  }, BASE, YT);
  if (!staged.ok) {
    console.error(JSON.stringify({ pass: false, step: 'stage-url', staged }, null, 2));
    await browser.close();
    process.exit(1);
  }

  const afterImport = await page.evaluate((clip, url) => {
    openStagedImportInComposer(clip, { source: 'qa-e2e', displayName: 'QA import', sourceUrl: url });
    const panel = document.getElementById('library-panel-streamers');
    const picker = document.getElementById('twitch-inline-picker');
    const composeBtn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'COMPOSE →');
    return {
      mode: (document.getElementById('library-source-mode') || {}).value,
      panelVisible: !!(panel && panel.offsetParent !== null),
      pickerHasCard: !!(picker && picker.querySelector('.gen-picker-card')),
      composeVisible: !!(composeBtn && composeBtn.offsetParent !== null),
      picked: collectCompPickedClips().length,
      status: (document.getElementById('twitch-fetch-status') || {}).textContent || '',
      onLibrary: !!(document.getElementById('page-library') || {}).classList.contains('active')
    };
  }, staged.clip || staged.staged, YT);

  if (
    !afterImport.panelVisible
    || !afterImport.composeVisible
    || !afterImport.pickerHasCard
    || afterImport.picked < 1
    || afterImport.mode !== 'streamers'
  ) {
    console.error(JSON.stringify({ pass: false, step: 'after-import', afterImport }, null, 2));
    await browser.close();
    process.exit(1);
  }

  await page.evaluate(() => {
    const composeBtn = Array.from(document.querySelectorAll('#page-library button'))
      .find((b) => b.textContent.trim() === 'COMPOSE →');
    if (!composeBtn) throw new Error('COMPOSE button missing');
    composeBtn.click();
  });

  await page.waitForFunction(() => {
    const gen = document.getElementById('page-generate');
    return gen && gen.classList.contains('active');
  }, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));

  const afterCompose = await page.evaluate(() => {
    const picked = collectCompPickedClips();
    const lead = picked[0] && picked[0].clip;
    const lineup = document.getElementById('twitch-comp-lineup');
    const summary = document.getElementById('composer-handoff-summary');
    return {
      onGenerate: !!(document.getElementById('page-generate') || {}).classList.contains('active'),
      picked: picked.length,
      leadTitle: lead && lead.title,
      hasStaged: !!(lead && (lead.playbackUrl || lead.stagedUrl || lead.r2Url)),
      lineupText: lineup ? lineup.innerText.replace(/\s+/g, ' ').slice(0, 200) : null,
      summaryText: summary ? summary.innerText.replace(/\s+/g, ' ').slice(0, 200) : null
    };
  });

  const pass = afterCompose.onGenerate
    && afterCompose.picked >= 1
    && afterCompose.hasStaged
    && alerts.length === 0;
  console.log(JSON.stringify({ pass, alerts, afterImport, afterCompose }, null, 2));
  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
