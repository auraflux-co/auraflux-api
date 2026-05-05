'use strict';
/**
 * guided_gemini_e2e.js — Guided tier E2E with Gemini as the customer (CPD-142).
 *
 * Gemini acts as a Guided-plan customer:
 *  1. Reads a plain-English content brief.
 *  2. Decides what to enter in the new-job wizard (format, path, topic, tone, platform).
 *  3. Submits the job via the dashboard UI.
 *  4. Sends a natural-language message to the Copilot describing the brief.
 *  5. Reads the Copilot response and audits whether it understood the brief correctly.
 *
 * Env:
 *   GEMINI_API_KEY          — required
 *   AURAFLUX_E2E_BASE       — app base (default: https://app.auraflux.co)
 *   CLERK_SECRET_KEY        — Clerk backend key for token generation
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE     = process.env.AURAFLUX_E2E_BASE  || 'https://app.auraflux.co';
const CLERK_SK = process.env.CLERK_SECRET_KEY   || 'sk_test_ImNgn23Q8kFm6u2jJ3tw6rWKxi5cbrSiGFTfKALWQl';
const GEMINI_KEY = process.env.GEMINI_API_KEY   || '';
const USER_ID  = 'user_3DHrNlngvQKhKeOcFr52o3JT1jE'; // Guided demo account

const SCENARIOS = [
  { id: 'G-T1', brief: 'I want a short-form vertical highlights reel about extreme sports. Hype energy. Going on TikTok.' },
  { id: 'G-T2', brief: 'Professional 3-minute news desk segment about AI in healthcare 2026. Informative. YouTube.' },
  { id: 'G-T3', brief: 'Short casual video about morning productivity — coffee, exercise, mindset. Instagram Reels.' },
  { id: 'G-T4', brief: 'Long-form product launch announcement for a new AI analytics platform. Professional. YouTube.' },
  { id: 'G-T5', brief: 'Breaking news — urgent coverage of a major economic development. Short and direct. YouTube.' },
  { id: 'G-T6', brief: 'Short entertainment pop culture trends clip. Energetic, fun, youthful. TikTok.' },
];

// ── Gemini helper ─────────────────────────────────────────────────────────────

function geminiAsk(prompt, jsonMode = false) {
  return new Promise((resolve, reject) => {
    if (!GEMINI_KEY) return reject(new Error('GEMINI_API_KEY not set'));
    const model = 'gemini-2.5-flash';
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(jsonMode ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
      ...(jsonMode ? { systemInstruction: { parts: [{ text: 'Respond with valid JSON only — no markdown, no commentary.' }] } } : {}),
    });
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            let text = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            if (jsonMode) {
              text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
              resolve(JSON.parse(text));
            } else {
              resolve(text);
            }
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Clerk token helper ────────────────────────────────────────────────────────

function getClerkTicket() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ user_id: USER_ID });
    const req = https.request({
      hostname: 'api.clerk.com', path: '/v1/sign_in_tokens', method: 'POST',
      headers: { Authorization: `Bearer ${CLERK_SK}`, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const r = JSON.parse(d);
        if (r.token) resolve(r.token); else reject(new Error(JSON.stringify(r)));
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── Wizard decisions via Gemini ───────────────────────────────────────────────

const WIZARD_PROMPT = `You are a Guided-plan AuraFlux customer using the new-job wizard on the dashboard.

The wizard has these steps:
1. Format: click "Long-form" or "Short-form"
2. Path: click one of these buttons:
   - "Produce from source" (for long-form with source URL)
   - "Fetch and enhance" (for short-form with source URL)
   - "Compile from short clips" (for long-form from clips)
   - "Script-led production" (for compose/topic-only)
3. Topic: type the subject
4. Tone: select from dropdown: professional, energetic, informative, hype, casual, urgent
5. Source URL: if the path requires it, enter a public video URL (use https://media.w3.org/2010/05/sintel/trailer_hd.mp4 as test URL)
6. Platform: click "YouTube", "TikTok", or "Instagram"

Rules:
- "Short-form" format → use "Fetch and enhance" path (needs source URL)
- "Long-form" format → use "Produce from source" (needs URL) or "Script-led production" (no URL)
- For short content briefs, use Short-form. For 2min+ briefs, use Long-form.
- TikTok/Instagram content → Short-form + "Fetch and enhance"

Content brief: {brief}

Respond with JSON:
{
  "format": "Short-form" | "Long-form",
  "path": "Fetch and enhance" | "Produce from source" | "Compile from short clips" | "Script-led production",
  "topic": "<concise topic string>",
  "tone": "professional" | "energetic" | "informative" | "hype" | "casual" | "urgent",
  "needsUrl": true | false,
  "platform": "YouTube" | "TikTok" | "Instagram"
}`;

const COPILOT_PROMPT = `You are a Guided-plan AuraFlux customer using the Copilot chat assistant.
You want to get guidance on producing a video. Write a natural, customer-like message asking the Copilot
for help or confirmation about your brief. Be specific about what you want.

Content brief: {brief}
Wizard choices made: format={format}, path={path}, topic={topic}, tone={tone}, platform={platform}

Write ONE natural customer message (2-4 sentences max) asking the Copilot to confirm this is the right setup
or to suggest any improvements. Do not say you are testing. Sound like a real customer.`;

const AUDIT_PROMPT = `You are auditing a Guided-tier AuraFlux customer interaction.

Content brief the customer had: {brief}
Wizard choices made: {choices}
Message sent to Copilot: {message}
Copilot response: {response}

Did the Copilot understand the customer's brief? Did it give relevant, helpful guidance?
Did the wizard choices (format, path, topic, tone, platform) correctly reflect the brief?

Respond with JSON:
{
  "wizardCorrect": true | false,
  "copilotUnderstood": true | false,
  "passed": true | false,
  "score": 0-100,
  "issues": ["list mismatches"],
  "notes": "brief explanation"
}`;

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(page, scenario) {
  const { id, brief } = scenario;
  console.log(`\n[${id}] Gemini deciding wizard inputs for: ${brief.slice(0, 60)}...`);

  // Step 1: Gemini decides wizard choices
  let choices;
  try {
    choices = await geminiAsk(WIZARD_PROMPT.replace('{brief}', brief), true);
  } catch (e) {
    return { id, passed: false, error: `Gemini wizard decision failed: ${e.message}`, brief };
  }
  console.log(`  → Gemini: format=${choices.format}, path=${choices.path}, tone=${choices.tone}, platform=${choices.platform}`);

  // Step 2: Navigate to new job wizard
  await page.goto(`${BASE}/dashboard/jobs/new`);
  await page.waitForLoadState('networkidle');

  try {
    // Format step
    await page.locator(`button:has-text("${choices.format}")`).first().click();
    await page.waitForTimeout(500);

    // Path step
    await page.locator(`button:has-text("${choices.path}")`).first().click();
    await page.waitForTimeout(500);

    // Next
    const next1 = page.locator('button:has-text("Next")');
    if (await next1.isVisible()) await next1.click();
    await page.waitForTimeout(500);

    // Topic
    const topicInput = page.locator('input[placeholder*="topic" i], input[placeholder*="about" i], input[type="text"]').first();
    await topicInput.fill(choices.topic);
    await page.waitForTimeout(300);

    // Tone
    const toneSelect = page.locator('select');
    if (await toneSelect.isVisible()) {
      await toneSelect.selectOption(choices.tone);
    }

    // Source URL if needed
    if (choices.needsUrl) {
      const urlBtn = page.locator('button:has-text("Fetch from URLs")');
      if (await urlBtn.isVisible({ timeout: 2000 }).catch(() => false)) await urlBtn.click();
      const urlArea = page.locator('textarea[placeholder*="https"]');
      if (await urlArea.isVisible({ timeout: 2000 }).catch(() => false)) {
        await urlArea.fill('https://media.w3.org/2010/05/sintel/trailer_hd.mp4');
      }
    }

    // Next
    const next2 = page.locator('button:has-text("Next")');
    if (await next2.isVisible()) await next2.click();
    await page.waitForTimeout(500);

    // Platform
    await page.locator(`button:has-text("${choices.platform}")`).first().click();
    await page.waitForTimeout(300);

    // Next
    const next3 = page.locator('button:has-text("Next")');
    if (await next3.isVisible()) await next3.click();
    await page.waitForTimeout(500);

    // Submit
    const submitBtn = page.locator('button:has-text("Submit job")');
    await submitBtn.waitFor({ timeout: 5000 });
    await submitBtn.click();

    // Wait for redirect to active jobs
    await page.waitForURL(/\/(active|jobs)/, { timeout: 10000 });
    console.log(`  → Job submitted successfully`);
  } catch (e) {
    console.log(`  ✗ Wizard navigation failed: ${e.message}`);
    return { id, passed: false, error: `Wizard failed: ${e.message}`, brief, choices };
  }

  // Step 3: Gemini composes a Copilot message
  let copilotMsg;
  try {
    copilotMsg = await geminiAsk(
      COPILOT_PROMPT
        .replace('{brief}', brief)
        .replace('{format}', choices.format)
        .replace('{path}', choices.path)
        .replace('{topic}', choices.topic)
        .replace('{tone}', choices.tone)
        .replace('{platform}', choices.platform)
    );
  } catch (e) {
    copilotMsg = `I want to create a video about: ${brief}. Is this setup correct?`;
  }

  // Step 4: Navigate to Copilot and send message
  await page.goto(`${BASE}/dashboard/concierge`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  let copilotResponse = '';
  try {
    const input = page.locator('textarea, input[type="text"]').last();
    await input.fill(copilotMsg);
    await input.press('Enter');

    // Wait for thinking spinner to disappear
    await page.waitForFunction(
      () => !document.body.innerText.includes('Thinking'),
      { timeout: 30000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Extract last assistant message
    const msgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.flex.justify-start'))
        .map(el => el.innerText.trim())
        .filter(t => t.length > 20)
    );
    copilotResponse = msgs[msgs.length - 1] || '';
    console.log(`  → Copilot responded (${copilotResponse.length} chars)`);
  } catch (e) {
    console.log(`  ⚠ Copilot interaction failed: ${e.message}`);
    copilotResponse = '';
  }

  // Step 5: Gemini audits the full interaction
  let audit = { passed: false, score: 0, issues: ['Audit skipped'], notes: '' };
  try {
    audit = await geminiAsk(
      AUDIT_PROMPT
        .replace('{brief}', brief)
        .replace('{choices}', JSON.stringify(choices))
        .replace('{message}', copilotMsg)
        .replace('{response}', copilotResponse || '(no response captured)'),
      true
    );
  } catch (e) {
    audit.issues = [`Gemini audit failed: ${e.message}`];
  }

  const sym = audit.passed ? '✓' : '✗';
  console.log(`  ${sym} [${id}] score=${audit.score}/100 — ${(audit.notes || '').slice(0, 80)}`);
  (audit.issues || []).forEach(i => console.log(`       ✗ ${i}`));

  return { id, brief, choices, copilotMsg, copilotResponse, audit, passed: audit.passed, score: audit.score };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!GEMINI_KEY) { console.error('ERROR: GEMINI_API_KEY not set'); process.exit(2); }

  console.log('='.repeat(60));
  console.log('AuraFlux Guided E2E — Gemini as Customer (CPD-142)');
  console.log(`Account: Guided demo (${USER_ID})`);
  console.log(`Base: ${BASE}`);
  console.log('='.repeat(60));

  // Sign in via Clerk token
  let ticket;
  try {
    ticket = await getClerkTicket();
  } catch (e) {
    console.error(`Sign-in failed: ${e.message}`); process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  console.log('\nSigning in...');
  await page.goto(`${BASE}/sign-in?__clerk_ticket=${ticket}`);
  await page.waitForURL(/dashboard/, { timeout: 20000 });
  console.log('✓ Signed in\n');

  const results = [];
  for (const scenario of SCENARIOS) {
    const r = await runScenario(page, scenario);
    results.push(r);
    await page.waitForTimeout(1000);
  }

  await browser.close();

  const passed = results.filter(r => r.passed).length;
  const total  = results.length;

  console.log('\n' + '='.repeat(60));
  console.log(`GUIDED E2E SUMMARY — ${passed}/${total} passed`);
  console.log('='.repeat(60));
  results.forEach(r => {
    const sym = r.passed ? '✓' : '✗';
    console.log(`  ${sym} [${r.id}] score=${r.score || 0}/100  ${r.brief.slice(0, 60)}`);
    (r.issues || r.audit?.issues || []).forEach(i => console.log(`       ✗ ${i}`));
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `guided_gemini_e2e_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(
    { tier: 'guided', timestamp: ts, summary: { passed, total }, results }, null, 2
  ));
  console.log(`\nResults written to ${outPath}`);

  process.exit(passed === total ? 0 : 1);
})();
