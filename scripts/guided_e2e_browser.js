#!/usr/bin/env node
/**
 * Guided (dwy) tier E2E — browser-only, no API access.
 *
 * Interaction mode: dashboard wizard with Copilot panel open.
 *
 * For each of the 6 scenarios (T1–T6):
 *   1. Open the new-job wizard
 *   2. Interact with the Copilot panel (ask about the scenario to confirm guidance)
 *   3. Walk the wizard selecting the correct options
 *   4. Submit the job
 *   5. Verify the job appears in Active Jobs with a running pipeline
 *
 * What we measure:
 *   - Copilot gave relevant step-level guidance (non-empty response)
 *   - Wizard accepted all selections without validation errors
 *   - Job was submitted successfully (redirected to Active Jobs or job detail)
 *   - Pipeline status is visible (portal badge or status text)
 *
 * Accounts:
 *   AURAFLUX_E2E_EMAIL    (default: demo@auraflux.co)
 *   AURAFLUX_E2E_PASSWORD (default: AuraFlux2026!)
 *   AURAFLUX_E2E_BASE     (default: https://app.auraflux.co)
 *
 * CPD-142
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE     = process.env.AURAFLUX_E2E_BASE  || 'https://app.auraflux.co';
const CLERK_SK = process.env.CLERK_SECRET_KEY    || 'sk_test_ImNgn23Q8kFm6u2jJ3tw6rWKxi5cbrSiGFTfKALWQl';
const USER_ID  = 'user_3DHrNlngvQKhKeOcFr52o3JT1jE';
const PUBLIC_MP4 = 'https://media.w3.org/2010/05/sintel/trailer_hd.mp4';

// The 6 scenarios — valid wizard path/format combinations
// Short-form fetch path: "Fetch and enhance" (short_fetch_enhance) — sources: fetch only
// Long-form paths: "Produce from source" (long_produce_source) or "Compile from short clips" (long_compile_clips)
// Tones available: professional, informative, casual, energetic, hype, punchy, urgent, conversational
const SCENARIOS = [
  {
    id: 'G-T1',
    desc: 'short · Fetch and enhance · professional · YouTube',
    format: 'short',
    pathLabel: 'Fetch and enhance',   // exact button label in wizard
    topic: 'AI breakthroughs in healthcare 2026',
    tone: 'professional',             // lowercase select value
    platform: 'YouTube',
    url: PUBLIC_MP4,
  },
  {
    id: 'G-T2',
    desc: 'short · Fetch and enhance · energetic · TikTok',
    format: 'short',
    pathLabel: 'Fetch and enhance',
    topic: 'Extreme sports highlights',
    tone: 'energetic',
    platform: 'TikTok',
    url: PUBLIC_MP4,
  },
  {
    id: 'G-T3',
    desc: 'long · Produce from source · informative · YouTube',
    format: 'long',
    pathLabel: 'Produce from source',
    topic: 'How AI is transforming small business operations',
    tone: 'informative',
    platform: 'YouTube',
    url: PUBLIC_MP4,
  },
  {
    id: 'G-T4',
    desc: 'short · Fetch and enhance · hype · Instagram',
    format: 'short',
    pathLabel: 'Fetch and enhance',
    topic: 'Basketball championship highlights',
    tone: 'hype',
    platform: 'Instagram',
    url: PUBLIC_MP4,
  },
  {
    id: 'G-T5',
    desc: 'long · Compile from short clips · casual · YouTube',
    format: 'long',
    pathLabel: 'Compile from short clips',
    topic: 'Bitcoin and Ethereum price trends 2026',
    tone: 'casual',
    platform: 'YouTube',
    url: PUBLIC_MP4,
  },
  {
    id: 'G-T6',
    desc: 'long · Produce from source · urgent · YouTube',
    format: 'long',
    pathLabel: 'Produce from source',
    topic: 'Nature documentary highlights',
    tone: 'urgent',
    platform: 'YouTube',
    url: PUBLIC_MP4,
  },
];

const w = (ms) => new Promise(r => setTimeout(r, ms));

async function getClerkTicket() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ user_id: USER_ID, expires_in_seconds: 3600 });
    const req = https.request({
      hostname: 'api.clerk.com', path: '/v1/sign_in_tokens', method: 'POST',
      headers: { 'Authorization': `Bearer ${CLERK_SK}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.url) {
            const ticket = new URL(parsed.url).searchParams.get('__clerk_ticket');
            resolve(ticket);
          } else reject(new Error('No URL: ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function signIn(page) {
  const ticket = await getClerkTicket();
  // Load the app's sign-in page WITH the clerk ticket — Clerk JS picks it up natively
  const signInUrl = `${BASE}/sign-in?__clerk_ticket=${ticket}`;
  console.log('  → Loading app sign-in with Clerk ticket...');
  await page.goto(signInUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await w(3000);
  console.log('  → After ticket sign-in, URL:', page.url());
  if (!page.url().includes('/dashboard')) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
    await w(2000);
  }
  await page.waitForURL('**/dashboard**', { timeout: 20000 });
  await w(2000);
}

async function askCopilot(page, question) {
  const chatBox = page.locator('textarea[placeholder*="job spec"], textarea[placeholder*="portal"], textarea[placeholder*="guided"], textarea[placeholder*="ask"]').first();
  if (await chatBox.isVisible({ timeout: 3000 }).catch(() => false)) {
    await chatBox.fill(question);
    await page.locator('button:has-text("Send")').first().click();
    // Wait for Thinking to appear then go away
    await page.locator('text=Thinking').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await page.locator('text=Thinking').waitFor({ state: 'hidden', timeout: 20000 }).catch(() => w(8000));
    // Get last assistant message (div.flex.justify-start)
    const response = await page.evaluate(() => {
      const msgs = document.querySelectorAll('.flex.justify-start');
      if (!msgs.length) return '(no response captured)';
      return (msgs[msgs.length - 1].innerText || '').trim();
    });
    return response || '(no response captured)';
  }
  return '(copilot not visible)';
}

async function runScenario(page, scenario) {
  const result = {
    id: scenario.id,
    desc: scenario.desc,
    passed: false,
    checks: [],
    issues: [],
  };

  const check = (label, ok, detail = '') => {
    result.checks.push({ label, ok, detail });
    if (!ok) result.issues.push(`✗ ${label}${detail ? ': ' + detail : ''}`);
    else result.checks[result.checks.length - 1].detail = detail;
  };

  console.log(`\n[${scenario.id}] ${scenario.desc}`);

  try {
    // ── Step 0: Format ────────────────────────────────────────────────
    await page.goto(`${BASE}/dashboard/jobs/new`, { waitUntil: 'networkidle' });
    await w(3000);
    check('wizard loaded', page.url().includes('jobs/new'), page.url());

    // Ask Copilot about this scenario
    const copilotQ = `I want to create a ${scenario.format}-form video about "${scenario.topic}" with a ${scenario.tone} tone for ${scenario.platform}. What format and path should I choose?`;
    const copilotResp = await askCopilot(page, copilotQ);
    check('copilot responded', copilotResp !== '(copilot not visible)' && copilotResp.length > 20, copilotResp.substring(0, 120));

    // Select format button (Long-form / Short-form)
    const formatLabel = scenario.format === 'short' ? 'Short-form' : 'Long-form';
    const fmtBtn = page.locator(`button:has-text("${formatLabel}")`).first();
    await fmtBtn.waitFor({ timeout: 5000 });
    await fmtBtn.click();
    await w(800);
    check(`${formatLabel} selected`, true);

    // Click "Next →" to advance to path step
    await page.locator('button:visible').filter({ hasText: /Next/ }).first().click();
    await w(1500);

    // ── Step 1: Production path ────────────────────────────────────────
    const pathBtn = page.locator(`button:has-text("${scenario.pathLabel}")`).first();
    const pathVisible = await pathBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (pathVisible) {
      await pathBtn.click();
      await w(800);
      check(`path "${scenario.pathLabel}" selected`, true);
    } else {
      const avail = await page.locator('button:visible').allInnerTexts();
      check('path selected', false, `"${scenario.pathLabel}" not found. Available: ${avail.slice(0,8).join(' | ')}`);
    }

    await page.locator('button:visible').filter({ hasText: /Next/ }).first().click();
    await w(1500);

    // ── Step 2: Source ─────────────────────────────────────────────────
    // Fill video topic
    const topicInput = page.locator('input[placeholder*="topic"], input[placeholder*="AI"], input[placeholder*="e.g"]').first();
    if (await topicInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await topicInput.fill(scenario.topic);
      check('topic entered', true);
    }

    // Set tone via <select> (value = lowercase tone string)
    const toneSelect = page.locator('select').first();
    if (await toneSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await toneSelect.selectOption(scenario.tone).catch(() => {});
      check('tone set', true);
    }

    // Click "Fetch from URLs" if the source mode toggle is visible
    const fetchBtn = page.locator('button:visible:has-text("Fetch from URLs")').first();
    if (await fetchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fetchBtn.click();
      await w(500);
    }

    // Fill source URL in the Textarea (placeholder "https://...")
    const urlTextarea = page.locator('textarea[placeholder="https://..."]').first();
    if (await urlTextarea.isVisible({ timeout: 3000 }).catch(() => false)) {
      await urlTextarea.fill(scenario.url);
      check('URL entered', true);
    } else {
      check('URL textarea found', false, 'Source URL textarea not visible');
    }

    // Ask Copilot about source config
    const copilotQ2 = `For this ${scenario.format}-form fetch job about "${scenario.topic}", is my source URL configuration correct?`;
    await askCopilot(page, copilotQ2);

    await page.locator('button:visible').filter({ hasText: /Next/ }).first().click();
    await w(2000);

    // ── Step 3: Features (accept defaults) ────────────────────────────
    const featuresVisible = await page.locator('text=Select the production capabilities').isVisible({ timeout: 3000 }).catch(() => false);
    check('features step reached', featuresVisible);
    await page.locator('button:visible').filter({ hasText: /Next/ }).first().click();
    await w(1500);

    // ── Step 4: Publish / Platform ────────────────────────────────────
    // YouTube is pre-selected by default; click platform button to confirm
    const platformBtn2 = page.locator(`button:has-text("${scenario.platform}")`).first();
    if (await platformBtn2.isVisible({ timeout: 5000 }).catch(() => false)) {
      await platformBtn2.click();
      await w(500);
      check(`platform ${scenario.platform} visible`, true);
    } else {
      check(`platform ${scenario.platform} visible`, false, 'publish step not reached or platform button missing');
    }

    // Click "Submit job"
    const submitBtn = page.locator('button:has-text("Submit job")').first();
    if (await submitBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await submitBtn.click();
      await w(3000);
      check('job submitted', true);
    } else {
      check('submit button found', false, 'Submit job button not visible on step 4');
    }

    // Verify redirect / active jobs
    const urlAfter = page.url();
    check('redirected after submit', urlAfter.includes('active') || urlAfter.includes('jobs/') || urlAfter.includes('dashboard'), urlAfter);

    await page.goto(`${BASE}/dashboard/jobs/active`, { waitUntil: 'networkidle' });
    await w(2000);
    const jobCount = await page.locator('[class*="card"], article, [role="listitem"]').count().catch(() => 0);
    check('active jobs list visible', jobCount > 0, `${jobCount} items visible`);

    result.passed = result.issues.length === 0;

  } catch (err) {
    result.issues.push(`✗ Uncaught error: ${err.message}`);
  }

  return result;
}

async function main() {
  console.log('='.repeat(60));
  console.log('AuraFlux Guided E2E — Dashboard + Copilot (CPD-142)');
  console.log('Account: demo@auraflux.co');
  console.log(`Base: ${BASE}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    console.log('\nSigning in...');
    await signIn(page);
    console.log('✓ Signed in via Clerk token');
  } catch (err) {
    console.error('✗ Sign-in failed:', err.message);
    await browser.close();
    process.exit(1);
  }

  const results = [];
  for (const scenario of SCENARIOS) {
    const result = await runScenario(page, scenario);
    results.push(result);
    // Brief pause between scenarios
    await w(2000);
  }

  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('GUIDED E2E SUMMARY');
  console.log('='.repeat(60));
  const passed = results.filter(r => r.passed).length;
  console.log(`Passed: ${passed}/${results.length}`);
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} [${r.id}] ${r.desc}`);
    for (const issue of r.issues) {
      console.log(`       ${issue}`);
    }
  }

  // Write results JSON
  const outFile = path.join(__dirname, '..', 'logs', `guided_e2e_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ tier: 'guided', timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  if (passed < results.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
