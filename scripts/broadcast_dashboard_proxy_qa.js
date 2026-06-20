#!/usr/bin/env node
'use strict';
/**
 * CPD-1055 — broadcast route QA (token-cheap by default).
 *
 * Modes:
 *   default     GET routes only — no YouTube/Twitch quota, no encode
 *   --actions   safe POST when grid offline (expects 400) — verifies proxy wiring
 *   --lifecycle short GO LIVE → verify rtmpHeld → STOP (<90s Render CPU, no new YT listing)
 *
 * Usage:
 *   node scripts/broadcast_dashboard_proxy_qa.js                    # Render direct
 *   node scripts/broadcast_dashboard_proxy_qa.js --local            # legacy: via localhost proxy (optional)
 *   node scripts/broadcast_dashboard_proxy_qa.js --local --actions
 *   node scripts/broadcast_dashboard_proxy_qa.js --local --lifecycle
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const LOCAL = args.includes('--local');
const ACTIONS = args.includes('--actions');
const LIFECYCLE = args.includes('--lifecycle');
const positional = args.filter((a) => !a.startsWith('--'));

const RENDER = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const LOCALHOST = (process.env.BROADCAST_LOCAL_URL || 'http://localhost:3000').replace(/\/$/, '');
const base = LOCAL ? LOCALHOST : (positional[0] || RENDER).replace(/\/$/, '');

const readChecks = [
  { name: 'sidecar health', method: 'GET', path: '/live-broadcast/health', expect: (d) => d.ok === true && d.service === 'broadcast-sidecar' },
  { name: 'grid status', method: 'GET', path: '/live-grid/status', expect: (d) => d.ok === true && typeof d.running === 'boolean' },
  { name: 'program status', method: 'GET', path: '/live-grid/program/status', expect: (d) => d.ok === true },
  { name: 'followed bench', method: 'GET', path: '/live-grid/followed-bench', expect: (d) => d.ok === true || d.error?.includes('Twitch') },
  { name: 'discovery bench', method: 'GET', path: '/live-grid/discovery/bench', expect: (d) => d.ok === true },
  { name: 'allowlist', method: 'GET', path: '/live-grid/allowlist', expect: (d) => d.ok === true },
  { name: 'files', method: 'GET', path: '/live-grid/files', expect: (d) => d.ok === true && Array.isArray(d.files) },
  { name: 'event feed preview', method: 'GET', path: '/live-grid/event-feed/preview', expect: (d) => d.ok === true },
  { name: 'delivery QA', method: 'GET', path: '/live-grid/delivery', expect: (d) => d.ok === true || d.delivery != null },
  { name: 'solo listings', method: 'GET', path: '/live-grid/solo-listings', expect: (d) => d.ok === true },
  { name: 'youtube listing', method: 'GET', path: '/live-grid/youtube-listing', expect: (d) => d.ok === true },
  { name: 'tv status', method: 'GET', path: '/live-tv/status', expect: (d) => d.ok === true },
  { name: 'tv playlist', method: 'GET', path: '/live-tv/playlist', expect: (d) => d.ok === true },
  { name: 'preflight', method: 'GET', path: '/live-grid/preflight?skipTests=1', expect: (d) => d.ok === true },
];

const actionChecks = [
  { name: 'stop when offline', method: 'POST', path: '/live-grid/stop', body: {}, expectStatus: 400 },
  { name: 'rtmp-go when offline', method: 'POST', path: '/live-grid/rtmp-go', body: {}, expectStatus: 400 },
  { name: 'solo-go when offline', method: 'POST', path: '/live-grid/solo-go', body: {}, expectStatus: 400 },
  { name: 'audio when offline', method: 'POST', path: '/live-grid/audio', body: { quadrant: 1 }, expectStatus: 400 },
  { name: 'operator-mode when offline', method: 'POST', path: '/live-grid/operator-mode', body: { enabled: true }, expectStatus: 400 },
];

async function req(method, url, body) {
  return axios({ method, url, data: body, timeout: 120000, validateStatus: () => true });
}

async function runReadChecks(results) {
  for (const c of readChecks) {
    try {
      const resp = await req(c.method, `${base}${c.path}`);
      const pass = resp.status < 500 && c.expect(resp.data);
      results.push({ ...c, pass, status: resp.status, error: pass ? null : JSON.stringify(resp.data).slice(0, 120) });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name} (${resp.status})`);
    } catch (e) {
      results.push({ ...c, pass: false, status: 0, error: e.message });
      console.log(`FAIL ${c.name} — ${e.message}`);
    }
  }
}

async function runActionChecks(results) {
  for (const c of actionChecks) {
    try {
      const resp = await req(c.method, `${base}${c.path}`, c.body);
      const pass = resp.status === c.expectStatus;
      results.push({ ...c, pass, status: resp.status, error: pass ? null : JSON.stringify(resp.data).slice(0, 120) });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name} (${resp.status}, want ${c.expectStatus})`);
    } catch (e) {
      results.push({ ...c, pass: false, status: 0, error: e.message });
      console.log(`FAIL ${c.name} — ${e.message}`);
    }
  }
}

async function runLifecycle(results) {
  const statusResp = await req('GET', `${base}/live-grid/status`);
  if (statusResp.data?.running) {
    console.log('SKIP lifecycle — grid already running (stop manually first)');
    results.push({ name: 'lifecycle', pass: false, status: 0, error: 'grid already running' });
    return;
  }
  console.log('[lifecycle] GO LIVE (createListing:false, RTMP held — no YouTube listing API)');
  const startBody = {
    privacyStatus: 'unlisted',
    createListing: false,
    autoPilot: true,
    operatorMode: false,
    usePrepared: false,
  };
  const start = await req('POST', `${base}/live-grid/start`, startBody);
  const startOk = start.status === 200 && start.data?.ok !== false;
  results.push({
    name: 'lifecycle start',
    pass: startOk,
    status: start.status,
    error: startOk ? null : JSON.stringify(start.data).slice(0, 200),
  });
  console.log(`${startOk ? 'PASS' : 'FAIL'} lifecycle start (${start.status})`);
  if (!startOk) return;

  await new Promise((r) => setTimeout(r, 8000));
  const mid = await req('GET', `${base}/live-grid/status`);
  const held = mid.data?.middleware?.rtmpHeld === true;
  const running = mid.data?.running === true;
  const midOk = running && held;
  results.push({
    name: 'lifecycle rtmpHeld',
    pass: midOk,
    status: mid.status,
    error: midOk ? null : `running=${running} rtmpHeld=${held}`,
  });
  console.log(`${midOk ? 'PASS' : 'FAIL'} lifecycle rtmpHeld (running=${running}, held=${held})`);

  const stop = await req('POST', `${base}/live-grid/stop`, {});
  const stopOk = stop.status === 200 && stop.data?.ok !== false;
  results.push({
    name: 'lifecycle stop',
    pass: stopOk,
    status: stop.status,
    error: stopOk ? null : JSON.stringify(stop.data).slice(0, 120),
  });
  console.log(`${stopOk ? 'PASS' : 'FAIL'} lifecycle stop (${stop.status})`);
}

async function run() {
  console.log(`[qa] base=${base} local=${LOCAL} actions=${ACTIONS} lifecycle=${LIFECYCLE}`);
  const results = [];
  await runReadChecks(results);
  if (ACTIONS) await runActionChecks(results);
  if (LIFECYCLE) await runLifecycle(results);

  const failed = results.filter((r) => !r.pass);
  const outPath = path.join(__dirname, '..', 'logs', LOCAL ? 'cpd1055_local_proxy_qa.json' : 'cpd1055_proxy_qa.json');
  fs.writeFileSync(outPath, JSON.stringify({ base, local: LOCAL, at: new Date().toISOString(), results }, null, 2));
  console.log(`[qa] wrote ${outPath}`);
  if (failed.length) {
    console.error(`[qa] ${failed.length}/${results.length} failed`);
    process.exit(1);
  }
  console.log(`[qa] ${results.length}/${results.length} passed`);
}

run();
