'use strict';
/**
 * managed_gemini_e2e.js — Managed tier E2E with Gemini as the customer (CPD-142).
 *
 * Gemini acts as a Managed-plan customer. Each scenario produces a REAL video:
 *  1. Gemini composes an opening message describing the brief to the Copilot.
 *  2. Copilot responds. Gemini sends one follow-up.
 *  3. Gemini extracts structured job parameters from the conversation.
 *  4. Job is submitted via API using the extracted parameters.
 *  5. Job is polled until outputUrl appears (up to 25 min — WAN generation).
 *  6. Gemini audits: Copilot quality + job parameters extracted correctly + video produced.
 *
 * Env:
 *   GEMINI_API_KEY                 — required
 *   AURAFLUX_E2E_API_KEY_MANAGED   — API key for the Managed demo account (required)
 *   AURAFLUX_E2E_BASE              — API base URL (default: https://auraflux-api.onrender.com)
 *   AURAFLUX_APP_BASE              — App base URL (default: https://app.auraflux.co)
 *   CLERK_SECRET_KEY               — Clerk backend key for token generation (required)
 */

const { chromium } = require('playwright');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const BASE_API   = process.env.AURAFLUX_E2E_BASE      || 'https://auraflux-api.onrender.com';
const BASE_APP   = process.env.AURAFLUX_APP_BASE      || 'https://app.auraflux.co';
const CLERK_SK   = process.env.CLERK_SECRET_KEY        || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY          || '';
const API_KEY    = process.env.AURAFLUX_E2E_API_KEY_MANAGED || '';
// Managed demo account — must exist in the Clerk tenant for CLERK_SK
const USER_ID    = process.env.AURAFLUX_E2E_USER_ID_MANAGED || 'user_3DIyT3RsdxBA4rPvIKSjb9PRNgu';

const SCENARIOS = [
  {
    id: 'M-T1',
    profile: 'vertical_reel',
    platforms: ['tiktok'],
    brief: 'I want a short-form vertical highlights reel about extreme sports. Hype energy. TikTok.',
    prompt: 'High-energy extreme sports: skaters, surfers, snowboarders. Fast cuts, vertical 9:16.',
  },
  {
    id: 'M-T2',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Professional 3-minute news desk segment about AI in healthcare 2026. Informative. YouTube.',
    prompt: 'News desk: AI transforming healthcare 2026 — diagnostics, surgery AI, drug discovery.',
  },
  {
    id: 'M-T3',
    profile: 'vertical_reel',
    platforms: ['instagram'],
    brief: 'Short casual video about morning productivity — coffee, exercise, mindset. Instagram Reels.',
    prompt: 'Morning routine: coffee, workout, journaling. Warm, relatable, vertical 9:16.',
  },
  {
    id: 'M-T4',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Long-form product launch announcement for a new AI analytics platform. Professional. YouTube.',
    prompt: 'Corporate product launch: AI analytics platform, real-time insights, executive dashboards.',
  },
  {
    id: 'M-T5',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Breaking news — urgent coverage of a major economic development. Short and direct. YouTube.',
    prompt: 'Breaking news anchor: urgent economic report, stock market, global economy crisis.',
  },
  {
    id: 'M-T6',
    profile: 'vertical_reel',
    platforms: ['tiktok'],
    brief: 'Short entertainment pop culture trends clip. Energetic, fun, youthful. TikTok.',
    prompt: 'Pop culture trends: viral challenges, music drops, celebrity moments. Gen-Z TikTok.',
  },
];

// ── Shared API helpers ────────────────────────────────────────────────────────

function apiRequest(method, urlPath, apiKey, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(BASE_API + urlPath);
    const mod = fullUrl.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = mod.request(
      {
        hostname: fullUrl.hostname,
        path:     fullUrl.pathname + fullUrl.search,
        method,
        headers: {
          'Authorization':  `Bearer ${apiKey}`,
          'Content-Type':   'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch (e) { resolve({ status: res.statusCode, body: d }); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('API timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function submitJob(params, apiKey) {
  const body = {
    entry:       'generate',
    type:        'text',
    contentType: 'custom',
    templateId:  params.templateId || 'long-form',
    topic:       params.topic      || 'AI generated video',
    tone:        params.tone       || 'professional',
    prompt:      params.prompt     || params.topic || 'A professional video',
    platforms:   params.platforms  || ['youtube'],
  };
  console.log(`    → Submitting job: templateId=${body.templateId} tone=${body.tone} platforms=${JSON.stringify(body.platforms)}`);
  const { body: resp } = await apiRequest('POST', '/v1/jobs', apiKey, body);
  const jobId = resp?.jobId || resp?.id || null;
  if (!jobId) throw new Error(`Job submission failed: ${JSON.stringify(resp).slice(0, 200)}`);
  return jobId;
}

async function pollForVideo(jobId, apiKey, maxMs = 25 * 60 * 1000) {
  const deadline  = Date.now() + maxMs;
  let lastStatus  = null;
  let finalResult = {};
  while (Date.now() < deadline) {
    const { body: result } = await apiRequest('GET', `/v1/jobs/${jobId}`, apiKey).catch(() => ({ body: {} }));
    const job       = result?.job || result;
    const status    = job?.status || 'unknown';
    const outputUrl = job?.outputUrl || job?.videoUrl || null;
    if (status !== lastStatus) {
      console.log(`    [poll ${jobId}] ${status} | video: ${outputUrl ? 'ready' : 'pending'}`);
      lastStatus = status;
    }
    finalResult = job;
    if (['failed', 'error', 'credit_paused'].includes(status)) break;
    if (['complete', 'completed', 'published'].includes(status) && outputUrl) break;
    await sleep(20000);
  }
  return finalResult;
}

async function checkVideoUrl(url) {
  if (!url) return false;
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          method: 'GET', headers: { Range: 'bytes=0-0' } },
        (res) => { resolve(res.statusCode === 200 || res.statusCode === 206); res.destroy(); }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(15000, () => { req.destroy(); resolve(false); });
      req.end();
    } catch (_) { resolve(false); }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
              text = text.replace(/^\s*```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
              resolve(JSON.parse(text));
            } else {
              resolve(text);
            }
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Clerk token helper ────────────────────────────────────────────────────────

function getClerkTicket() {
  return new Promise((resolve, reject) => {
    if (!CLERK_SK) return reject(new Error('CLERK_SECRET_KEY not set'));
    const body = JSON.stringify({ user_id: USER_ID });
    const req = https.request({
      hostname: 'api.clerk.com', path: '/v1/sign_in_tokens', method: 'POST',
      headers: { Authorization: `Bearer ${CLERK_SK}`, 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(d);
          if (r.token) resolve(r.token);
          else reject(new Error(`Clerk error: ${JSON.stringify(r).slice(0, 200)}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const OPENING_MSG_PROMPT = `You are a Managed-plan AuraFlux customer. On the Managed plan, the AI Copilot
manages video production for you — you just describe what you want.

Write a natural opening message to the Copilot describing what you want to produce.
Sound like a real customer handing a brief to a managed service.
Be specific about content, style, tone, and platform. Keep it to 2-4 sentences.

Content brief: {brief}`;

const FOLLOWUP_PROMPT = `You are a Managed-plan AuraFlux customer in a conversation with the AI Copilot.

Your original brief: {brief}
Your first message: {firstMsg}
Copilot's response: {copilotResponse}

If the Copilot asked a question or needs clarification, answer it in 1-2 sentences.
If the Copilot seems to have understood and is proceeding, say something like "Great, go ahead" or "That sounds perfect".
If the Copilot's response seems off, politely correct it.

Write ONLY your next message — nothing else.`;

const EXTRACT_PARAMS_PROMPT = `Based on this conversation between a customer and the AuraFlux Copilot, extract the video job parameters.

Customer brief: {brief}
Full conversation:
Customer: {firstMsg}
Copilot: {firstResponse}
Customer: {followupMsg}
Copilot: {followupResponse}

Extract the parameters that should be used to submit the video production job.
Use the customer's brief as the primary source if the Copilot's response is vague.

Respond with JSON:
{
  "topic": "<concise subject, max 80 chars>",
  "tone": "professional" | "informative" | "casual" | "energetic" | "hype" | "urgent",
  "templateId": "long-form" | "short-form",
  "platforms": ["youtube"] | ["tiktok"] | ["instagram"],
  "prompt": "<text-to-video generation prompt describing visuals, 1-2 sentences>"
}

Rules:
- templateId: "short-form" for TikTok/Reels/under 90 seconds. "long-form" for YouTube/professional.
- platforms: single-item array matching the target platform in the brief.
- prompt: visual description of what should appear in the video — not the script narration.`;

const AUDIT_PROMPT = `You are auditing a Managed-tier AuraFlux Copilot interaction.

The customer's brief: {brief}

Conversation:
Customer: {firstMsg}
Copilot: {firstResponse}
Customer: {followupMsg}
Copilot: {followupResponse}

Extracted job parameters (what was submitted to the pipeline): {params}
Video produced (outputUrl present): {video_present}
Video accessible (HTTP 200/206): {video_ok}

Evaluate:
1. Did the Copilot correctly identify the content type, format, tone, and platform from the brief?
2. Did the Copilot respond as a system that MANAGES production (not just answer questions)?
3. Were the extracted job parameters accurate to the brief?
4. Was a real video produced? (required for E2E pass)
5. Is the video accessible?
6. Did the Copilot wrongly suggest upgrading plans? (should not happen for Managed)

Respond with JSON:
{
  "copilotUnderstood": true | false,
  "managedResponse": true | false,
  "wrongTierResponse": false | true,
  "paramsAccurate": true | false,
  "passed": true | false,
  "score": 0-100,
  "issues": ["list any problems"],
  "notes": "brief explanation"
}

IMPORTANT: If video_present is false or video_ok is false, passed must be false and score below 60.`;

// ── Send message to Copilot ───────────────────────────────────────────────────

async function sendCopilotMessage(page, message) {
  const msgsBefore = await page.locator(
    '[data-role="assistant"], .chat-message-assistant, [data-testid="copilot-message"]'
  ).count().catch(() => 0);

  const input = page.locator('textarea[placeholder], textarea').last();
  await input.waitFor({ timeout: 8000 });
  await input.fill(message);
  await input.press('Enter');

  // Wait for a new assistant message to appear (count-based — avoids "Thinking" text trap)
  await page.waitForFunction(
    (before) => {
      const selectors = [
        '[data-role="assistant"]',
        '.chat-message-assistant',
        '[data-testid="copilot-message"]',
      ];
      for (const sel of selectors) {
        if (document.querySelectorAll(sel).length > before) return true;
      }
      return false;
    },
    msgsBefore,
    { timeout: 45000 }
  ).catch(() => {});
  await sleep(1500);

  // Extract last assistant message — prefer data attributes, fall back to structural selector
  const msgs = await page.evaluate(() => {
    const selectors = [
      '[data-role="assistant"]',
      '.chat-message-assistant',
      '[data-testid="copilot-message"]',
    ];
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length > 0) {
        return els.map(el => el.innerText.trim()).filter(t => t.length > 10);
      }
    }
    // Generic fallback: left-aligned messages in the main chat column
    return Array.from(document.querySelectorAll('main .flex.justify-start'))
      .map(el => el.innerText.trim())
      .filter(t => t.length > 20);
  });
  return msgs[msgs.length - 1] || '';
}

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(browser, ticket, scenario) {
  const { id, brief, platforms, prompt: videoPrompt } = scenario;
  console.log(`\n[${id}] ${brief.slice(0, 60)}...`);

  if (!API_KEY) {
    return { id, passed: false, error: 'AURAFLUX_E2E_API_KEY_MANAGED not set', brief };
  }

  // Fresh page per scenario — avoids conversation state bleed between tests
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  try {
    await page.goto(`${BASE_APP}/sign-in?__clerk_ticket=${ticket}`);
    await page.waitForURL(/dashboard/, { timeout: 20000 });
  } catch (e) {
    await context.close();
    return { id, passed: false, error: `Sign-in failed: ${e.message}`, brief };
  }

  // Step 1: Navigate to Copilot
  await page.goto(`${BASE_APP}/dashboard/concierge`);
  await page.waitForLoadState('domcontentloaded');
  await sleep(2000);

  // Step 2: Gemini composes the opening message
  let firstMsg;
  try {
    firstMsg = await geminiAsk(OPENING_MSG_PROMPT.replace('{brief}', brief));
  } catch (e) {
    firstMsg = `I need help producing a video: ${brief}`;
  }
  console.log(`  → Customer: "${firstMsg.slice(0, 80)}..."`);

  // Step 3: Send opening message and capture response
  let firstResponse = '';
  try {
    firstResponse = await sendCopilotMessage(page, firstMsg);
    console.log(`  → Copilot (${firstResponse.length} chars): "${firstResponse.slice(0, 80)}..."`);
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
          .replace('{brief}',           brief)
          .replace('{firstMsg}',        firstMsg)
          .replace('{copilotResponse}', firstResponse)
      );
      console.log(`  → Follow-up: "${followupMsg.slice(0, 80)}"`);
      followupResponse = await sendCopilotMessage(page, followupMsg);
      console.log(`  → Copilot follow-up (${followupResponse.length} chars)`);
    } catch (e) {
      console.log(`  ⚠ Follow-up failed: ${e.message}`);
    }
  }

  await context.close();

  // Step 5: Gemini extracts structured job parameters from the conversation
  let extractedParams = null;
  try {
    extractedParams = await geminiAsk(
      EXTRACT_PARAMS_PROMPT
        .replace('{brief}',           brief)
        .replace('{firstMsg}',        firstMsg)
        .replace('{firstResponse}',   firstResponse  || '(no response)')
        .replace('{followupMsg}',     followupMsg    || '(no follow-up)')
        .replace('{followupResponse}', followupResponse || '(no response)'),
      true
    );
    console.log(`  → Extracted params: templateId=${extractedParams.templateId} tone=${extractedParams.tone} platforms=${JSON.stringify(extractedParams.platforms)}`);
  } catch (e) {
    console.log(`  ⚠ Param extraction failed: ${e.message} — using scenario defaults`);
    extractedParams = {
      topic:      brief.slice(0, 80),
      tone:       'professional',
      templateId: scenario.profile === 'vertical_reel' ? 'short-form' : 'long-form',
      platforms,
      prompt:     videoPrompt,
    };
  }

  // Ensure prompt is set — fall back to scenario-level prompt if Gemini omits it
  if (!extractedParams.prompt || extractedParams.prompt.length < 10) {
    extractedParams.prompt = videoPrompt;
  }
  if (!extractedParams.platforms || !extractedParams.platforms.length) {
    extractedParams.platforms = platforms;
  }

  // Step 6: Submit job via API using extracted parameters
  let jobId = null;
  try {
    jobId = await submitJob(extractedParams, API_KEY);
    console.log(`  → Submitted jobId: ${jobId}`);
  } catch (e) {
    console.log(`  ✗ Job submission failed: ${e.message}`);
  }

  // Step 7: Poll for video (up to 25 min)
  let outputUrl   = null;
  let finalStatus = 'not_submitted';
  if (jobId) {
    console.log(`  → Polling for video... (up to 25 min)`);
    const finalJob = await pollForVideo(jobId, API_KEY);
    outputUrl   = finalJob?.outputUrl || finalJob?.videoUrl || null;
    finalStatus = finalJob?.status || 'unknown';
    console.log(`  → Final status: ${finalStatus} | outputUrl: ${outputUrl || 'MISSING'}`);
  }

  const videoUrlOk = await checkVideoUrl(outputUrl);
  if (outputUrl) console.log(`  → Video HTTP check: ${videoUrlOk ? '200/206 OK' : 'FAILED'}`);

  // Step 8: Gemini audits the full interaction
  let audit = { passed: false, score: 0, issues: ['Audit not run'], notes: '' };
  try {
    audit = await geminiAsk(
      AUDIT_PROMPT
        .replace('{brief}',            brief)
        .replace('{firstMsg}',         firstMsg)
        .replace('{firstResponse}',    firstResponse    || '(no response)')
        .replace('{followupMsg}',      followupMsg      || '(no follow-up)')
        .replace('{followupResponse}', followupResponse || '(no response)')
        .replace('{params}',           JSON.stringify(extractedParams, null, 2))
        .replace('{video_present}',    String(!!outputUrl))
        .replace('{video_ok}',         String(videoUrlOk)),
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
    extractedParams, jobId, finalStatus, outputUrl, outputUrlOk: videoUrlOk,
    audit, passed: !!audit.passed, score: audit.score || 0,
    issues: audit.issues || [],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!GEMINI_KEY) { console.error('ERROR: GEMINI_API_KEY not set'); process.exit(2); }
  if (!CLERK_SK)   { console.error('ERROR: CLERK_SECRET_KEY not set'); process.exit(2); }
  if (!API_KEY)    { console.error('ERROR: AURAFLUX_E2E_API_KEY_MANAGED not set'); process.exit(2); }

  console.log('='.repeat(60));
  console.log('AuraFlux Managed E2E — Gemini as Customer (CPD-142)');
  console.log(`Account: Managed demo (${USER_ID})`);
  console.log(`API: ${BASE_API} | App: ${BASE_APP}`);
  console.log('='.repeat(60));

  let ticket;
  try {
    ticket = await getClerkTicket();
    console.log('✓ Clerk ticket obtained\n');
  } catch (e) {
    console.error(`Sign-in failed: ${e.message}`); process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const scenario of SCENARIOS) {
    const r = await runScenario(browser, ticket, scenario);
    results.push(r);
    await sleep(3000);
    // Re-fetch Clerk ticket to avoid expiry across long scenarios
    try { ticket = await getClerkTicket(); } catch (_) { /* keep old ticket */ }
  }

  await browser.close();

  const passed = results.filter(r => r.passed).length;
  const total  = results.length;

  console.log('\n' + '='.repeat(60));
  console.log(`MANAGED E2E SUMMARY — ${passed}/${total} passed`);
  console.log('='.repeat(60));
  results.forEach(r => {
    const sym = r.passed ? '✓' : '✗';
    const vid = r.outputUrl ? 'video:✓' : 'video:✗';
    console.log(`  ${sym} [${r.id}] score=${r.score}/100 ${vid}  ${r.brief.slice(0, 55)}`);
    r.issues.forEach(i => console.log(`       ✗ ${i}`));
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir  = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `managed_gemini_e2e_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(
    { tier: 'managed', timestamp: ts, summary: { passed, total }, results }, null, 2
  ));
  console.log(`\nResults written to ${outPath}`);

  process.exit(passed === total ? 0 : 1);
})();
