#!/usr/bin/env node
'use strict';
/**
 * Submit a hub staging QA job (TikTok Clutch, Review before publishing, private).
 * Logs job id + portal map to logs/hub_staging_test_job.json for CPD-1056 / R-HUB.
 *
 * Usage:
 *   ALLOW_E2E_JOB_SUBMIT=1 node scripts/hub_staging_test_job.js
 *   ALLOW_E2E_JOB_SUBMIT=1 node scripts/hub_staging_test_job.js --poll
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'hub_staging_test_job.json');

function loadDotenv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim();
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotenv();

const poll = process.argv.includes('--poll');
const BASE = process.env.AURAFLUX_E2E_BASE || 'https://api.auraflux.co';
const API_KEY = process.env.AURAFLUX_E2E_API_KEY_OPERATE || '';

if (!process.env.ALLOW_E2E_JOB_SUBMIT) {
  console.error('Set ALLOW_E2E_JOB_SUBMIT=1 to submit a live staging job.');
  process.exit(1);
}
if (!API_KEY) {
  console.error('AURAFLUX_E2E_API_KEY_OPERATE missing from .env');
  process.exit(1);
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { json = { raw: raw.slice(0, 500) }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchClip() {
  const { status, body } = await request('GET', '/source/twitch/hasanabi/content?limit=5&type=clip');
  if (status !== 200) throw new Error(`source library HTTP ${status}`);
  const items = (body.items || []).filter((i) => i.url && (i.duration || 0) >= 15 && (i.duration || 0) <= 120);
  if (!items.length) throw new Error('no suitable twitch clips from hasanabi');
  return items[0];
}

async function pollJob(jobId, maxSec = 900) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSec) {
    const { status, body } = await request('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (status !== 200) {
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }
    const job = body.job || body;
    const st = (job.status || '').toLowerCase();
    const stage = (job.stage || '').toLowerCase();
    process.stdout.write(`\r  poll ${jobId.slice(-24)} status=${st} stage=${stage}   `);
    if (['complete', 'operator_review', 'published', 'failed', 'error', 'cancelled'].includes(st)
        || ['operator_review', 'failed', 'error'].includes(stage)) {
      console.log('');
      return job;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log('\n  poll timeout');
  return null;
}

async function main() {
  console.log(`Hub staging test job → ${BASE}`);
  const clip = await fetchClip();
  console.log(`Clip: ${clip.title?.slice(0, 60) || clip.url}`);

  const payload = {
    entry: 'fetch',
    productionProfile: 'vertical_reel',
    format: 'short',
    contentType: 'clips',
    platforms: ['tiktok'],
    targetPlatform: 'tiktok',
    url: clip.url,
    urls: [clip.url],
    sourceLibrary: [{
      url: clip.url,
      title: clip.title || 'Hub QA clip',
      duration: clip.duration,
      platform: 'twitch',
      contentType: 'clips',
    }],
    topic: 'Hub staging QA — TikTok Clutch',
    tone: 'high-energy, engaging',
    durationMins: 1,
    templateName: 'TikTok Clutch',
    publishMode: 'immediate',
    staging: true,
    publishMeta: { privacyStatus: 'private', title: 'Hub QA staging (private)' },
    addOns: {
      tts: { active: false },
      thumbnail: { active: true },
      branding: { active: true },
      clipSourcing: { active: true },
      showCommentary: { active: false },
    },
    createdVia: 'hub_staging_test',
  };

  const { status, body } = await request('POST', '/v1/jobs', payload);
  if (status !== 200 && status !== 201 && status !== 202) {
    const err = body.message || body.error || JSON.stringify(body).slice(0, 400);
    fs.writeFileSync(OUT, JSON.stringify({ error: err, httpStatus: status, at: new Date().toISOString() }, null, 2));
    console.error(`Submit failed HTTP ${status}: ${err}`);
    process.exit(1);
  }

  const jobId = body.jobId || (body.job || body).id || body.id;

  // 202 response may not include full spec — fetch job for portal map
  let spec = (body.job || body).spec || body.spec || {};
  if (jobId && !spec.portals) {
    const got = await request('GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (got.status === 200) spec = got.body.job?.spec || got.body.spec || got.body || spec;
  }

  const portals = spec.portals
    ? Object.entries(spec.portals).filter(([, v]) => v?.active).map(([k]) => k)
    : null;

  const log = {
    ticket: 'CPD-1037',
    submittedAt: new Date().toISOString(),
    apiBase: BASE,
    jobId,
    httpStatus: status,
    staging: body.staging ?? spec.staging ?? true,
    stagingPortal5: spec.portals?.portal5?.active,
    portals: portals || null,
    templateName: payload.templateName,
    publishMeta: payload.publishMeta,
    clipUrl: clip.url,
  };

  console.log(`Submitted jobId: ${jobId}`);
  if (portals?.length) console.log(`Active portals: ${portals.join(', ')}`);

  // Customer GET masks spec.portals — verify hub wiring via same code path as API
  try {
    const { resolveActivePortals } = require('../lib/job_spec');
    const probe = {
      contentType: 'clips',
      templateName: 'TikTok Clutch',
      staging: true,
      stageMap: { script: { active: false } },
    };
    const active = resolveActivePortals(probe);
    log.hubWiring = {
      activePortals: active,
      portal4: probe.portals?.portal4?.active,
      portal5: probe.portals?.portal5?.active,
    };
    console.log(`Hub wiring (resolveActivePortals): ${active.join(', ')}`);
    if (probe.portals?.portal5?.active === false) console.log('portal5 inactive (staging) ✓');
    if (active.includes('portal4')) console.log('portal4 active (clip QA) ✓');
  } catch (e) {
    log.hubWiringError = e.message;
  }

  if (portals?.includes('portal4')) console.log('portal4 active (clip QA) ✓');

  if (poll && jobId) {
    const job = await pollJob(jobId);
    if (job) {
      log.finalStatus = job.status;
      log.finalStage = job.stage;
      log.grade = job.grade;
      log.outputUrl = job.outputUrl || job.output?.url;
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
