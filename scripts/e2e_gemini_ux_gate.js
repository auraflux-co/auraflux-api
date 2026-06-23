#!/usr/bin/env node
'use strict';
/**
 * CPD-592 — Gemini UX gate for graded E2E jobs.
 * Captures dashboard screenshots + optional output video frame review via Gemini.
 *
 * Usage:
 *   node scripts/e2e_gemini_ux_gate.js \
 *     --job-id JOB_ID \
 *     --app-base https://app.auraflux.co \
 *     --api-base https://auraflux-api.onrender.com \
 *     --auth-token "$E2E_CLERK_TOKEN" \
 *     [--output-url https://...mp4]
 *
 * Exit 0 = UX pass (score may be capped at 99 without full screenshot set).
 * Exit 1 = UX fail (critical layout/branding issues).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PAGES = [
  { slug: 'jobs', path: '/dashboard/jobs' },
  { slug: 'job_detail', pathTemplate: (jobId) => `/dashboard/jobs/${encodeURIComponent(jobId)}` },
  { slug: 'credits', path: '/dashboard/credits' },
  { slug: 'billing', path: '/billing' },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--job-id') out.jobId = argv[++i];
    else if (a === '--app-base') out.appBase = argv[++i].replace(/\/$/, '');
    else if (a === '--api-base') out.apiBase = argv[++i].replace(/\/$/, '');
    else if (a === '--auth-token') out.authToken = argv[++i];
    else if (a === '--output-url') out.outputUrl = argv[++i];
    else if (a === '--run-id') out.runId = argv[++i];
  }
  return out;
}

async function captureDashboardScreenshots({ appBase, authToken, jobId, outDir }) {
  const { chromium } = require('playwright');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  const page = await context.newPage();
  const shots = [];

  for (const spec of PAGES) {
    const rel = spec.pathTemplate ? spec.pathTemplate(jobId) : spec.path;
    const url = `${appBase}${rel}`;
    const file = path.join(outDir, `${spec.slug}.jpg`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: file, type: 'jpeg', quality: 85, fullPage: false });
      if (fs.existsSync(file) && fs.statSync(file).size > 3000) {
        shots.push({ slug: spec.slug, url, file });
      }
    } catch (err) {
      shots.push({ slug: spec.slug, url, error: err.message });
    }
  }

  await browser.close();
  return shots;
}

async function geminiReviewUx({ shots, outputUrl, jobId }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const parts = [{
    text: `You are grading AuraFlux E2E UX for job ${jobId}.
Review dashboard screenshots against: dark theme, readable nav, no broken layout, AuraFlux branding (not generic white Atlassian).
${outputUrl ? `Output video URL (metadata only): ${outputUrl}` : 'No output video URL provided.'}

Respond ONLY JSON:
{
  "uxPass": boolean,
  "scoreCap": number,
  "issues": ["..."],
  "notes": "one paragraph"
}
uxPass=false if any page is login wall, 404, or severely broken. scoreCap=99 max unless all pages look production-ready (then 100).`,
  }];

  for (const s of shots.filter((x) => x.file)) {
    const b64 = fs.readFileSync(s.file).toString('base64');
    parts.push({ text: `Screenshot: ${s.slug} (${s.url})` });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
  }

  const model = process.env.GEMINI_UX_MODEL || 'gemini-2.5-flash';
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json',
      },
    },
    { timeout: 90_000 },
  );

  const text = ((resp.data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '').join('')).trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Gemini UX non-JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function maybeUploadToR2(localDir, runId) {
  try {
    const { uploadFile } = require('../lib/storage');
    const date = new Date().toISOString().slice(0, 10);
    const prefix = `e2e/${date}/ux/${runId || 'run'}`;
    const uploaded = [];
    for (const f of fs.readdirSync(localDir).filter((n) => n.endsWith('.jpg'))) {
      const key = `${prefix}/${f}`;
      const url = await uploadFile(path.join(localDir, f), key, 'image/jpeg');
      uploaded.push({ key, url });
    }
    return uploaded;
  } catch (_e) {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.jobId) {
    console.error('Missing --job-id');
    process.exit(2);
  }

  const appBase = args.appBase || process.env.AURAFLUX_APP_URL || 'https://app.auraflux.co';
  const runId = args.runId || args.jobId;
  const outDir = path.join(__dirname, '..', 'logs', 'e2e_ux', runId);
  const authToken = args.authToken || process.env.E2E_CLERK_TOKEN || '';

  let shots = [];
  if (authToken) {
    shots = await captureDashboardScreenshots({
      appBase,
      authToken,
      jobId: args.jobId,
      outDir,
    });
  } else {
    console.warn('[e2e_gemini_ux_gate] No auth token — skipping dashboard screenshots');
  }

  const review = await geminiReviewUx({
    shots,
    outputUrl: args.outputUrl,
    jobId: args.jobId,
  });

  const r2 = await maybeUploadToR2(outDir, runId);
  const report = {
    jobId: args.jobId,
    runId,
    shots: shots.map((s) => ({ slug: s.slug, url: s.url, error: s.error || null })),
    r2,
    review,
    ts: new Date().toISOString(),
  };

  const reportPath = path.join(outDir, 'ux_report.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (!review.uxPass) process.exit(1);
}

main().catch((err) => {
  console.error('[e2e_gemini_ux_gate] fatal:', err.message);
  process.exit(1);
});
