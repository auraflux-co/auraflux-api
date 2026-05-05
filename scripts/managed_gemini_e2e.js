'use strict';
/**
 * managed_gemini_e2e.js — Managed tier E2E with Gemini as the customer (CPD-142).
 *
 * Gemini acts as a Managed-plan customer who only uses Copilot.
 * The system (AuraFlux Copilot) is supposed to lead job creation entirely.
 *
 *  1. Gemini reads a content brief.
 *  2. Gemini composes a natural customer message describing what they want.
 *  3. Playwright sends the message to the Copilot page.
 *  4. Gemini reads the Copilot response and decides whether to follow up.
 *  5. Gemini audits: did the Copilot correctly interpret the brief and lead
 *     the customer toward a correctly-spec'd job?
 *
 * Env:
 *   GEMINI_API_KEY      — required
 *   AURAFLUX_E2E_BASE   — app base (default: https://app.auraflux.co)
 *   CLERK_SECRET_KEY    — Clerk backend key
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE       = process.env.AURAFLUX_E2E_BASE || 'https://app.auraflux.co';
const CLERK_SK   = process.env.CLERK_SECRET_KEY  || 'sk_test_ImNgn23Q8kFm6u2jJ3tw6rWKxi5cbrSiGFTfKALWQl';
const GEMINI_KEY = process.env.GEMINI_API_KEY    || '';
const USER_ID    = 'user_3DIyT3RsdxBA4rPvIKSjb9PRNgu'; // Managed demo account

const SCENARIOS = [
  { id: 'M-T1', brief: 'I want a short-form vertical highlights reel about extreme sports. Hype energy. TikTok.' },
  { id: 'M-T2', brief: 'Professional 3-minute news desk segment about AI in healthcare 2026. Informative. YouTube.' },
  { id: 'M-T3', brief: 'Short casual video about morning productivity — coffee, exercise, mindset. Instagram Reels.' },
  { id: 'M-T4', brief: 'Long-form product launch announcement for a new AI analytics platform. Professional. YouTube.' },
  { id: 'M-T5', brief: 'Breaking news — urgent coverage of a major economic development. Short and direct. YouTube.' },
  { id: 'M-T6', brief: 'Short entertainment pop culture trends clip. Energetic, fun, youthful. TikTok.' },
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
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
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

// ── Prompts ───────────────────────────────────────────────────────────────────

const OPENING_MSG_PROMPT = `You are a Managed-plan AuraFlux customer. On the Managed plan, you rely entirely
on the AI Copilot to guide and manage your video production — you don't do it yourself.

Write a natural opening message to the Copilot describing what you want to produce.
Sound like a real customer who is handing the brief off to be managed for them.
Be specific about the content, style, tone, and platform.
Keep it to 2-4 sentences.

Content brief: {brief}`;

const FOLLOWUP_PROMPT = `You are a Managed-plan AuraFlux customer in a conversation with the AI Copilot.

Your original brief: {brief}
Your first message: {firstMsg}
Copilot's response: {copilotResponse}

If the Copilot asked a question or needs clarification, answer it naturally in 1-2 sentences.
If the Copilot seems to have understood and is proceeding, say something brief like "Great, go ahead" or "That sounds perfect".
If the Copilot's response seems off or missed the point, politely correct it.

Write ONLY your next message — nothing else.`;

const AUDIT_PROMPT = `You are auditing a Managed-tier AuraFlux Copilot interaction.

The customer's brief: {brief}

Conversation:
Customer: {firstMsg}
Copilot: {firstResponse}
Customer: {followupMsg}
Copilot: {followupResponse}

Evaluate:
1. Did the Copilot correctly identify the content type, format, tone, and platform from the brief?
2. Did the Copilot respond like a system that will MANAGE the production (not just answer questions)?
3. Did the Copilot give the customer confidence that the job will be set up correctly?
4. Was there any mention of upgrading to a higher plan (which would be wrong for a Managed-plan customer)?

Respond with JSON:
{
  "understood": true | false,
  "managed_response": true | false,
  "wrong_tier_response": false | true,
  "passed": true | false,
  "score": 0-100,
  "issues": ["list any problems"],
  "notes": "brief explanation"
}`;

// ── Send message to Copilot ───────────────────────────────────────────────────

async function sendCopilotMessage(page, message) {
  const input = page.locator('textarea, input[type="text"]').last();
  await input.fill(message);
  await input.press('Enter');

  // Wait for thinking to finish
  await page.waitForFunction(
    () => !document.body.innerText.includes('Thinking'),
    { timeout: 45000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);

  // Get last assistant message
  const msgs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.flex.justify-start'))
      .map(el => el.innerText.trim())
      .filter(t => t.length > 20)
  );
  return msgs[msgs.length - 1] || '';
}

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(page, scenario) {
  const { id, brief } = scenario;
  console.log(`\n[${id}] Gemini crafting opening message for: ${brief.slice(0, 60)}...`);

  // Step 1: Navigate to Copilot
  await page.goto(`${BASE}/dashboard/concierge`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Step 2: Gemini composes the opening message
  let firstMsg;
  try {
    firstMsg = await geminiAsk(OPENING_MSG_PROMPT.replace('{brief}', brief));
  } catch (e) {
    firstMsg = `I need help producing a video: ${brief}`;
  }
  console.log(`  → Customer message: "${firstMsg.slice(0, 80)}..."`);

  // Step 3: Send opening message and capture response
  let firstResponse = '';
  try {
    firstResponse = await sendCopilotMessage(page, firstMsg);
    console.log(`  → Copilot response (${firstResponse.length} chars): "${firstResponse.slice(0, 80)}..."`);
  } catch (e) {
    console.log(`  ⚠ Copilot send failed: ${e.message}`);
  }

  // Step 4: Gemini decides follow-up
  let followupMsg = '';
  let followupResponse = '';
  if (firstResponse) {
    try {
      followupMsg = await geminiAsk(
        FOLLOWUP_PROMPT
          .replace('{brief}', brief)
          .replace('{firstMsg}', firstMsg)
          .replace('{copilotResponse}', firstResponse)
      );
      console.log(`  → Follow-up: "${followupMsg.slice(0, 80)}"`);
      followupResponse = await sendCopilotMessage(page, followupMsg);
      console.log(`  → Copilot follow-up (${followupResponse.length} chars)`);
    } catch (e) {
      console.log(`  ⚠ Follow-up failed: ${e.message}`);
    }
  }

  // Step 5: Gemini audits the full conversation
  let audit = { passed: false, score: 0, issues: ['Audit not run'], notes: '' };
  try {
    audit = await geminiAsk(
      AUDIT_PROMPT
        .replace('{brief}', brief)
        .replace('{firstMsg}', firstMsg)
        .replace('{firstResponse}', firstResponse || '(no response)')
        .replace('{followupMsg}', followupMsg || '(no follow-up)')
        .replace('{followupResponse}', followupResponse || '(no response)'),
      true
    );
  } catch (e) {
    audit.issues = [`Gemini audit failed: ${e.message}`];
  }

  const sym = audit.passed ? '✓' : '✗';
  console.log(`  ${sym} [${id}] score=${audit.score}/100 — ${(audit.notes || '').slice(0, 80)}`);
  (audit.issues || []).forEach(i => console.log(`       ✗ ${i}`));

  return {
    id, brief, firstMsg, firstResponse, followupMsg, followupResponse,
    audit, passed: !!audit.passed, score: audit.score || 0,
    issues: audit.issues || [],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!GEMINI_KEY) { console.error('ERROR: GEMINI_API_KEY not set'); process.exit(2); }

  console.log('='.repeat(60));
  console.log('AuraFlux Managed E2E — Gemini as Customer (CPD-142)');
  console.log(`Account: Managed demo (${USER_ID})`);
  console.log(`Base: ${BASE}`);
  console.log('='.repeat(60));

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
    await page.waitForTimeout(1500);
  }

  await browser.close();

  const passed = results.filter(r => r.passed).length;
  const total  = results.length;

  console.log('\n' + '='.repeat(60));
  console.log(`MANAGED E2E SUMMARY — ${passed}/${total} passed`);
  console.log('='.repeat(60));
  results.forEach(r => {
    const sym = r.passed ? '✓' : '✗';
    console.log(`  ${sym} [${r.id}] score=${r.score}/100  ${r.brief.slice(0, 60)}`);
    r.issues.forEach(i => console.log(`       ✗ ${i}`));
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `managed_gemini_e2e_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(
    { tier: 'managed', timestamp: ts, summary: { passed, total }, results }, null, 2
  ));
  console.log(`\nResults written to ${outPath}`);

  process.exit(passed === total ? 0 : 1);
})();
