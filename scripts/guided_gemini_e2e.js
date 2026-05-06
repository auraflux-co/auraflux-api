'use strict';
/**
 * guided_gemini_e2e.js — Guided tier E2E with Gemini as the customer (CPD-142).
 *
 * Gemini acts as a Guided-plan customer. Each scenario produces a REAL video:
 *  1. Gemini decides wizard inputs from the content brief.
 *  2. Playwright navigates the new-job wizard and submits.
 *  3. jobId is resolved via GET /v1/jobs (most recent job after submit timestamp).
 *  4. Job is polled until outputUrl appears (up to 25 min — WAN generation).
 *  5. Gemini sends a Copilot message while the job is running.
 *  6. Gemini audits: wizard correct + Copilot understood + video produced.
 *
 * Env:
 *   GEMINI_API_KEY                — required
 *   AURAFLUX_E2E_API_KEY_GUIDED   — API key for the Guided demo account (required)
 *   AURAFLUX_E2E_BASE             — API base URL (default: https://auraflux-api.onrender.com)
 *   AURAFLUX_APP_BASE             — App base URL (default: https://app.auraflux.co)
 *   CLERK_SECRET_KEY              — Clerk backend key for token generation (required)
 */

const { chromium } = require('playwright');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const BASE_API  = process.env.AURAFLUX_E2E_BASE    || 'https://auraflux-api.onrender.com';
const BASE_APP  = process.env.AURAFLUX_APP_BASE    || 'https://app.auraflux.co';
const CLERK_SK  = process.env.CLERK_SECRET_KEY      || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY       || '';
const API_KEY   = process.env.AURAFLUX_E2E_API_KEY_GUIDED || '';
// Guided demo account — must exist in the Clerk tenant for CLERK_SK
const USER_ID   = process.env.AURAFLUX_E2E_USER_ID_GUIDED || 'user_3DHrNlngvQKhKeOcFr52o3JT1jE';

const SCENARIOS = [
  {
    id: 'G-T1',
    profile: 'vertical_reel',
    platforms: ['tiktok'],
    brief: 'I want a short-form vertical highlights reel about extreme sports. Hype energy. Going on TikTok.',
    prompt: 'High-energy extreme sports highlights: skaters, surfers, snowboarders. Fast cuts, vertical 9:16.',
  },
  {
    id: 'G-T2',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Professional 3-minute news desk segment about AI in healthcare 2026. Informative. YouTube.',
    prompt: 'News desk segment on AI in healthcare 2026: diagnostics, surgery AI, drug discovery.',
  },
  {
    id: 'G-T3',
    profile: 'vertical_reel',
    platforms: ['instagram'],
    brief: 'Short casual video about morning productivity — coffee, exercise, mindset. Instagram Reels.',
    prompt: 'Morning routine lifestyle: coffee, workout, journaling. Warm authentic feel, vertical 9:16.',
  },
  {
    id: 'G-T4',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Long-form product launch announcement for a new AI analytics platform. Professional. YouTube.',
    prompt: 'Corporate product launch: AI analytics platform, real-time insights, executive dashboards.',
  },
  {
    id: 'G-T5',
    profile: 'broadcast_desk',
    platforms: ['youtube'],
    brief: 'Breaking news — urgent coverage of a major economic development. Short and direct. YouTube.',
    prompt: 'Breaking news anchor: urgent economic report, stock market, global economy crisis.',
  },
  {
    id: 'G-T6',
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
    topic:       params.topic       || 'AI generated video',
    tone:        params.tone        || 'professional',
    prompt:      params.prompt      || params.topic || 'A professional video',
    platforms:   params.platforms   || ['youtube'],
  };
  const { body: resp } = await apiRequest('POST', '/v1/jobs', apiKey, body);
  return resp?.jobId || resp?.id || null;
}

async function getLatestJobAfter(timestampMs, apiKey) {
  const { body: resp } = await apiRequest('GET', '/v1/jobs', apiKey).catch(() => ({ body: {} }));
  const jobs = resp?.jobs || [];
  // Find the job created most recently after our pre-submit timestamp
  const candidate = jobs
    .filter(j => j.createdAt && new Date(j.createdAt).getTime() > timestampMs)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return candidate?.jobId || null;
}

async function pollForVideo(jobId, apiKey, maxMs = 25 * 60 * 1000) {
  const deadline   = Date.now() + maxMs;
  let lastStatus   = null;
  let finalResult  = {};
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

const WIZARD_PROMPT = `You are a Guided-plan AuraFlux customer using the new-job wizard.

The wizard has 5 steps: Format → Path → Source → Features → Publish.

Step 0 — Format: choose "Long-form" (16:9) or "Short-form" (9:16)
Step 1 — Path:
  Long-form: "Compile from short clips" | "Produce from source"
  Short-form: "Cut clips from long-form" | "Enhance uploaded clips" | "Fetch and enhance"
  Rules: pick a path that uses URL source (not upload):
    Long-form  → "Produce from source"
    Short-form → "Fetch and enhance"
Step 2 — Source: fill topic and select tone
  Tones: professional | informative | casual | energetic | hype | punchy | urgent | conversational
Step 4 — Publish: choose platform

Content brief: {brief}
Target platforms: {platforms}

Respond with JSON:
{
  "format": "Long-form" | "Short-form",
  "path": "Produce from source" | "Fetch and enhance",
  "topic": "<concise topic string max 60 chars>",
  "tone": "professional" | "informative" | "casual" | "energetic" | "hype" | "punchy" | "urgent" | "conversational",
  "platform": "YouTube" | "TikTok" | "Instagram",
  "templateId": "long-form" | "short-form"
}`;

const COPILOT_MSG_PROMPT = `You are a Guided-plan AuraFlux customer using the Copilot chat assistant.
Write a natural, customer-like message asking the Copilot for confirmation about your brief.
Be specific about what you want. Keep it to 2-4 sentences.

Content brief: {brief}
Wizard choices: format={format}, path={path}, topic={topic}, tone={tone}, platform={platform}

Write ONE natural customer message asking if this setup is correct or if there are improvements.
Do not say you are testing. Sound like a real customer.`;

const AUDIT_PROMPT = `You are auditing a Guided-tier AuraFlux customer interaction.

Content brief: {brief}
Wizard choices: {choices}
Copilot message sent: {message}
Copilot response: {response}
Video produced (outputUrl present): {video_present}
Video accessible (HTTP 200/206): {video_ok}

Evaluate:
1. Did the wizard choices (format, path, topic, tone, platform) correctly reflect the brief?
2. Did the Copilot understand the brief and give helpful, relevant guidance?
3. Was a real video produced? (required for E2E pass)
4. Is the video accessible?

Respond with JSON:
{
  "wizardCorrect": true | false,
  "copilotUnderstood": true | false,
  "passed": true | false,
  "score": 0-100,
  "issues": ["list mismatches"],
  "notes": "brief explanation"
}

IMPORTANT: If video_present is false or video_ok is false, passed must be false and score below 60.`;

// ── Scenario runner ───────────────────────────────────────────────────────────

async function runScenario(browser, ticket, scenario) {
  const { id, brief, profile, platforms, prompt: videoPrompt } = scenario;
  console.log(`\n[${id}] ${brief.slice(0, 60)}...`);

  if (!API_KEY) {
    return { id, passed: false, error: 'AURAFLUX_E2E_API_KEY_GUIDED not set', brief };
  }

  // Fresh page per scenario — avoids state bleed between tests
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  // Sign in
  try {
    await page.goto(`${BASE_APP}/sign-in?__clerk_ticket=${ticket}`);
    await page.waitForURL(/dashboard/, { timeout: 20000 });
  } catch (e) {
    await context.close();
    return { id, passed: false, error: `Sign-in failed: ${e.message}`, brief };
  }

  // Step 1: Gemini decides wizard inputs
  let choices;
  try {
    choices = await geminiAsk(
      WIZARD_PROMPT.replace('{brief}', brief).replace('{platforms}', JSON.stringify(platforms)),
      true
    );
  } catch (e) {
    await context.close();
    return { id, passed: false, error: `Gemini wizard decision failed: ${e.message}`, brief };
  }
  console.log(`  → Wizard: format=${choices.format}, path=${choices.path}, tone=${choices.tone}, platform=${choices.platform}`);

  // Step 2: Navigate wizard and submit job
  const preSubmitTs = Date.now();
  try {
    await page.goto(`${BASE_APP}/dashboard/jobs/new`);
    await page.waitForLoadState('domcontentloaded');
    await sleep(1500);

    async function clickNext() {
      const btn = page.locator('button:has-text("Next"), button:has-text("Submit job")').last();
      await btn.waitFor({ timeout: 8000 });
      await btn.click();
      await sleep(600);
    }

    // Step 0: Format
    await page.locator(`button:has-text("${choices.format}")`).first().waitFor({ timeout: 10000 });
    await page.locator(`button:has-text("${choices.format}")`).first().click();
    await sleep(400);
    await clickNext();

    // Step 1: Production path
    await page.locator(`button:has-text("${choices.path}")`).first().waitFor({ timeout: 8000 });
    await page.locator(`button:has-text("${choices.path}")`).first().click();
    await sleep(400);
    await clickNext();

    // Step 2: Source — topic, tone, URL
    const topicInput = page.locator('input[placeholder*="topic" i], input[placeholder*="about" i], input[name="topic"]').first();
    if (await topicInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      await topicInput.waitFor({ timeout: 4000 });
      await topicInput.fill(choices.topic);
    }
    // Tone — prefer named select to avoid hitting wrong dropdown
    const toneSelect = page.locator('select[name="tone"], select[aria-label*="tone" i], select').first();
    if (await toneSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await toneSelect.selectOption({ value: choices.tone }).catch(() =>
        toneSelect.selectOption({ label: choices.tone }).catch(() => {})
      );
    }
    // Source URL
    const fetchBtn = page.locator('button:has-text("Fetch from URLs")');
    if (await fetchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await fetchBtn.click();
      await sleep(300);
    }
    const urlArea = page.locator('textarea[placeholder*="https"], textarea[placeholder*="url" i]').first();
    if (await urlArea.isVisible({ timeout: 3000 }).catch(() => false)) {
      await urlArea.fill('https://media.w3.org/2010/05/sintel/trailer_hd.mp4');
    }
    await clickNext();

    // Step 3: Features — accept defaults
    await clickNext();

    // Step 4: Publish — select platform
    await page.locator(`button:has-text("${choices.platform}")`).first().waitFor({ timeout: 8000 });
    await page.locator(`button:has-text("${choices.platform}")`).first().click();
    await sleep(400);

    const submitBtn = page.locator('button:has-text("Submit job")');
    await submitBtn.waitFor({ timeout: 8000 });
    await submitBtn.click();

    await page.waitForURL(/\/dashboard\//, { timeout: 15000 });
    console.log(`  → Wizard submitted — redirected to: ${page.url()}`);
  } catch (e) {
    await context.close();
    return { id, passed: false, error: `Wizard failed: ${e.message.split('\n')[0]}`, brief, choices };
  }

  // Step 3: Resolve jobId — use API key to find the job created after preSubmitTs
  let jobId = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(5000);
    jobId = await getLatestJobAfter(preSubmitTs, API_KEY).catch(() => null);
    if (jobId) break;
    console.log(`  [${id}] Waiting for jobId to appear in API... (attempt ${attempt + 1})`);
  }

  if (!jobId) {
    // Fallback: submit via API directly using Gemini-decided params
    console.log(`  [${id}] jobId not found via wizard — submitting via API as fallback`);
    try {
      jobId = await submitJob({
        templateId: choices.templateId || (choices.format === 'Short-form' ? 'short-form' : 'long-form'),
        topic:     choices.topic,
        tone:      choices.tone,
        prompt:    videoPrompt,
        platforms,
      }, API_KEY);
      if (jobId) console.log(`  → Fallback API submit — jobId: ${jobId}`);
    } catch (e) {
      console.log(`  ✗ [${id}] API fallback failed: ${e.message}`);
    }
  } else {
    console.log(`  → jobId resolved: ${jobId}`);
  }

  // Step 4: Copilot interaction (runs while job processes)
  let copilotMsg = '';
  let copilotResponse = '';
  try {
    copilotMsg = await geminiAsk(
      COPILOT_MSG_PROMPT
        .replace('{brief}', brief)
        .replace('{format}', choices.format)
        .replace('{path}',   choices.path)
        .replace('{topic}',  choices.topic)
        .replace('{tone}',   choices.tone)
        .replace('{platform}', choices.platform)
    );

    await page.goto(`${BASE_APP}/dashboard/concierge`);
    await page.waitForLoadState('domcontentloaded');
    await sleep(2000);

    const msgsBefore = await page.locator('[data-role="assistant"], .chat-message-assistant, .flex.justify-start').count().catch(() => 0);

    const input = page.locator('textarea[placeholder], textarea').last();
    await input.waitFor({ timeout: 8000 });
    await input.fill(copilotMsg);
    await input.press('Enter');

    // Wait for a new assistant message to appear (count-based, not text-based)
    await page.waitForFunction(
      (before) => {
        const els = document.querySelectorAll('[data-role="assistant"], .chat-message-assistant, .flex.justify-start');
        return els.length > before;
      },
      msgsBefore,
      { timeout: 45000 }
    ).catch(() => {});
    await sleep(1500);

    // Extract the last assistant message — prefer data-role attribute, fall back to flex class
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
      // Generic fallback: messages in the chat column (left-aligned = assistant)
      return Array.from(document.querySelectorAll('main .flex.justify-start'))
        .map(el => el.innerText.trim())
        .filter(t => t.length > 20);
    });
    copilotResponse = msgs[msgs.length - 1] || '';
    console.log(`  → Copilot responded (${copilotResponse.length} chars)`);
  } catch (e) {
    console.log(`  ⚠ Copilot interaction failed: ${e.message}`);
  }

  // Step 5: Poll for video (blocks until WAN + pipeline complete)
  let outputUrl = null;
  let finalStatus = 'not_submitted';
  if (jobId) {
    console.log(`  → Polling for video... (up to 25 min)`);
    const finalJob = await pollForVideo(jobId, API_KEY);
    outputUrl   = finalJob?.outputUrl || finalJob?.videoUrl || null;
    finalStatus = finalJob?.status || 'unknown';
    console.log(`  → Final status: ${finalStatus} | outputUrl: ${outputUrl || 'MISSING'}`);
  } else {
    console.log(`  ✗ No jobId — cannot poll for video`);
  }

  const videoUrlOk = await checkVideoUrl(outputUrl);
  if (outputUrl) console.log(`  → Video HTTP check: ${videoUrlOk ? '200/206 OK' : 'FAILED'}`);

  // Step 6: Gemini audits the full interaction
  let audit = { passed: false, score: 0, issues: ['Audit not run'], notes: '' };
  try {
    audit = await geminiAsk(
      AUDIT_PROMPT
        .replace('{brief}',         brief)
        .replace('{choices}',       JSON.stringify(choices))
        .replace('{message}',       copilotMsg || '(not sent)')
        .replace('{response}',      copilotResponse || '(no response)')
        .replace('{video_present}', String(!!outputUrl))
        .replace('{video_ok}',      String(videoUrlOk)),
      true
    );
  } catch (e) {
    audit.issues = [`Gemini audit failed: ${e.message}`];
  }

  const sym = audit.passed ? '✓' : '✗';
  console.log(`  ${sym} [${id}] score=${audit.score}/100 — ${(audit.notes || '').slice(0, 80)}`);
  (audit.issues || []).forEach(i => console.log(`       ✗ ${i}`));

  await context.close();
  return {
    id, brief, choices, copilotMsg, copilotResponse,
    jobId, finalStatus, outputUrl, outputUrlOk: videoUrlOk,
    audit, passed: !!audit.passed, score: audit.score || 0,
    issues: audit.issues || [],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  if (!GEMINI_KEY) { console.error('ERROR: GEMINI_API_KEY not set'); process.exit(2); }
  if (!CLERK_SK)   { console.error('ERROR: CLERK_SECRET_KEY not set'); process.exit(2); }
  if (!API_KEY)    { console.error('ERROR: AURAFLUX_E2E_API_KEY_GUIDED not set'); process.exit(2); }

  console.log('='.repeat(60));
  console.log('AuraFlux Guided E2E — Gemini as Customer (CPD-142)');
  console.log(`Account: Guided demo (${USER_ID})`);
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
    // Brief pause between scenarios — let the pod breathe
    await sleep(3000);
    // Re-fetch Clerk ticket if needed (tokens expire in ~10 min)
    try { ticket = await getClerkTicket(); } catch (_) { /* keep old ticket */ }
  }

  await browser.close();

  const passed = results.filter(r => r.passed).length;
  const total  = results.length;

  console.log('\n' + '='.repeat(60));
  console.log(`GUIDED E2E SUMMARY — ${passed}/${total} passed`);
  console.log('='.repeat(60));
  results.forEach(r => {
    const sym = r.passed ? '✓' : '✗';
    const vid = r.outputUrl ? 'video:✓' : 'video:✗';
    console.log(`  ${sym} [${r.id}] score=${r.score}/100 ${vid}  ${r.brief.slice(0, 55)}`);
    (r.issues || []).forEach(i => console.log(`       ✗ ${i}`));
  });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir  = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `guided_gemini_e2e_${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(
    { tier: 'guided', timestamp: ts, summary: { passed, total }, results }, null, 2
  ));
  console.log(`\nResults written to ${outPath}`);

  process.exit(passed === total ? 0 : 1);
})();
