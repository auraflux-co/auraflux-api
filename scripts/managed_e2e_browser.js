#!/usr/bin/env node
/**
 * Managed (dfy) tier E2E — browser-only, Copilot page ONLY, no API access.
 *
 * Interaction mode: customer describes intent to the AuraFlux Collab.
 * The system (Copilot) should understand the intent and route toward
 * the correct job configuration — no wizard, no manual form filling.
 *
 * For each of the 6 scenarios (T1–T6):
 *   1. Go to /dashboard/concierge (Copilot page)
 *   2. Send a natural-language description of the desired video
 *   3. Read Copilot's response — does it correctly identify:
 *      - Format (short/long)?
 *      - Production approach (compose/fetch)?
 *      - Topic/tone understanding?
 *      - Platform recommendation?
 *   4. If Copilot suggests navigating to the wizard, follow the link/button
 *   5. Record what Copilot recommended vs what was asked
 *
 * What we measure (input intent → Copilot output fidelity):
 *   - Copilot responded (non-empty, > 50 chars)
 *   - Response mentions the correct format (short/long)
 *   - Response mentions or confirms the topic/subject matter
 *   - Response provides actionable next step (link to wizard or button)
 *
 * Accounts:
 *   AURAFLUX_E2E_MANAGED_EMAIL    (default: managed-demo@auraflux.co)
 *   AURAFLUX_E2E_MANAGED_PASSWORD (default: AuraFlux2026!)
 *   AURAFLUX_E2E_BASE             (default: https://app.auraflux.co)
 *
 * CPD-142
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE     = process.env.AURAFLUX_E2E_BASE  || 'https://app.auraflux.co';
const CLERK_SK = process.env.CLERK_SECRET_KEY    || 'sk_test_ImNgn23Q8kFm6u2jJ3tw6rWKxi5cbrSiGFTfKALWQl';
const USER_ID  = 'user_3DIyT3RsdxBA4rPvIKSjb9PRNgu';

// Natural-language prompts for each scenario — what a Managed customer would say
const SCENARIOS = [
  {
    id: 'M-T1',
    desc: 'Compose · broadcast_desk · short · professional',
    prompt: 'I need a short professional video about AI breakthroughs in healthcare for 2026. This should be suitable for YouTube — something broadcast-style with a desk presenter look.',
    expectFormat: 'short',
    expectTopic: ['AI', 'healthcare', 'health'],
    expectPlatform: ['YouTube', 'youtube'],
  },
  {
    id: 'M-T2',
    desc: 'Fetch · vertical_reel · short · energetic',
    prompt: 'Can you help me create a short energetic highlight reel from a video source? It\'s extreme sports content — fast-paced, vertical format for TikTok.',
    expectFormat: 'short',
    expectTopic: ['extreme', 'sports', 'highlight'],
    expectPlatform: ['TikTok', 'tiktok'],
  },
  {
    id: 'M-T3',
    desc: 'Compose · broadcast_desk · long · educational',
    prompt: 'I want a long-form educational video explaining how AI is transforming small business operations. Full episode format, YouTube, broadcast desk style.',
    expectFormat: 'long',
    expectTopic: ['AI', 'small business', 'business'],
    expectPlatform: ['YouTube', 'youtube'],
  },
  {
    id: 'M-T4',
    desc: 'Fetch · live_event · short · exciting',
    prompt: 'I have basketball championship footage and need a short exciting highlight clip for Instagram. Live event style.',
    expectFormat: 'short',
    expectTopic: ['basketball', 'championship', 'sport'],
    expectPlatform: ['Instagram', 'instagram'],
  },
  {
    id: 'M-T5',
    desc: 'Compose · broadcast_desk · short · analytical',
    prompt: 'Create a short analytical video covering Bitcoin and Ethereum price trends for 2026. Professional tone, broadcast desk layout, publish to YouTube.',
    expectFormat: 'short',
    expectTopic: ['bitcoin', 'ethereum', 'crypto', 'price'],
    expectPlatform: ['YouTube', 'youtube'],
  },
  {
    id: 'M-T6',
    desc: 'Fetch · vertical_reel · long · calm',
    prompt: 'I have nature documentary footage I\'d like turned into a long-form calm highlight video, vertical reel style for YouTube.',
    expectFormat: 'long',
    expectTopic: ['nature', 'documentary'],
    expectPlatform: ['YouTube', 'youtube'],
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

async function runScenario(page, scenario) {
  const result = {
    id: scenario.id,
    desc: scenario.desc,
    prompt: scenario.prompt,
    copilotResponse: '',
    passed: false,
    checks: [],
    issues: [],
  };

  const check = (label, ok, detail = '') => {
    result.checks.push({ label, ok, detail });
    if (!ok) result.issues.push(`✗ ${label}${detail ? ': ' + detail : ''}`);
  };

  console.log(`\n[${scenario.id}] ${scenario.desc}`);
  console.log(`  Prompt: "${scenario.prompt.substring(0, 80)}..."`);

  try {
    // Go to Copilot page
    await page.goto(`${BASE}/dashboard/concierge`, { waitUntil: 'networkidle' });
    await w(2000);

    check('copilot page loaded', page.url().includes('concierge'), page.url());

    // Find the chat input
    const chatInput = page.locator(
      'textarea[placeholder*="job"], textarea[placeholder*="portal"], textarea[placeholder*="help"], textarea[placeholder*="ask"], input[placeholder*="ask"], input[placeholder*="message"]'
    ).first();

    const inputVisible = await chatInput.isVisible({ timeout: 5000 }).catch(() => false);
    check('chat input visible', inputVisible);

    if (!inputVisible) {
      result.issues.push('✗ Copilot chat input not found — cannot proceed');
      return result;
    }

    // Send the natural-language prompt
    await chatInput.fill(scenario.prompt);
    await w(500);

    const sendBtn = page.locator('button:has-text("Send"), button[type="submit"]').first();
    await sendBtn.click();

    // Wait for "Thinking…" to appear then disappear (Copilot processing indicator)
    console.log('  Waiting for Copilot response...');
    await page.locator('text=Thinking').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await page.locator('text=Thinking').waitFor({ state: 'hidden', timeout: 25000 }).catch(() => w(12000));

    // Capture the last assistant message (div.flex.justify-start contains assistant bubbles)
    const fullResponse = await page.evaluate(() => {
      const allMsgs = document.querySelectorAll('.flex.justify-start');
      if (!allMsgs.length) return '';
      const last = allMsgs[allMsgs.length - 1];
      return (last.innerText || last.textContent || '').trim();
    });

    result.copilotResponse = fullResponse.substring(0, 500);
    console.log(`  Response (${fullResponse.length} chars): "${fullResponse.substring(0, 150)}..."`);

    // Check response quality
    check('copilot responded', fullResponse.length > 50, `${fullResponse.length} chars`);

    // Check if format mentioned
    const formatMentioned = fullResponse.toLowerCase().includes(scenario.expectFormat);
    check(`format "${scenario.expectFormat}" in response`, formatMentioned, formatMentioned ? '' : `Response: "${fullResponse.substring(0, 100)}"`);

    // Check if topic/subject matter understood
    const topicMentioned = scenario.expectTopic.some(t => fullResponse.toLowerCase().includes(t.toLowerCase()));
    check('topic understood', topicMentioned, topicMentioned ? '' : `Expected one of: ${scenario.expectTopic.join('/')}`);

    // Check if platform mentioned
    const platformMentioned = scenario.expectPlatform.some(p => fullResponse.toLowerCase().includes(p.toLowerCase()));
    check(`platform ${scenario.expectPlatform[0]} in response`, platformMentioned);

    // Check if Copilot provides actionable next step (link to wizard or "Create job" button)
    const hasActionableLink = await page.locator(
      'a[href*="jobs/new"], button:has-text("New job"), button:has-text("Create job"), a:has-text("wizard"), a:has-text("job")'
    ).first().isVisible({ timeout: 3000 }).catch(() => false);
    check('actionable next step provided', hasActionableLink, hasActionableLink ? 'wizard/job link visible' : 'no job creation link in response');

    result.passed = result.issues.length === 0;

  } catch (err) {
    result.issues.push(`✗ Uncaught error: ${err.message}`);
  }

  return result;
}

async function main() {
  console.log('='.repeat(60));
  console.log('AuraFlux Managed E2E — Copilot Only (CPD-142)');
  console.log('Account: managed-demo@auraflux.co');
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
    await w(2000);
  }

  await browser.close();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('MANAGED E2E SUMMARY');
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

  const outFile = path.join(__dirname, '..', 'logs', `managed_e2e_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ tier: 'managed', timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${outFile}`);

  if (passed < results.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
