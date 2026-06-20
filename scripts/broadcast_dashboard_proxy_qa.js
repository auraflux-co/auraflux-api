#!/usr/bin/env node
'use strict';
/**
 * CPD-1055 — smoke-test broadcast sidecar routes (Render or local sidecar).
 * Usage: node scripts/broadcast_dashboard_proxy_qa.js [baseUrl]
 */
const axios = require('axios');

const base = (process.argv[2] || process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');

const checks = [
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
  { name: 'tv status', method: 'GET', path: '/live-tv/status', expect: (d) => d.ok === true },
  { name: 'tv playlist', method: 'GET', path: '/live-tv/playlist', expect: (d) => d.ok === true },
  { name: 'preflight', method: 'GET', path: '/live-grid/preflight?skipTests=1', expect: (d) => d.ok === true },
];

async function run() {
  console.log(`[qa] base=${base}`);
  const results = [];
  for (const c of checks) {
    try {
      const resp = await axios({ method: c.method, url: `${base}${c.path}`, timeout: 60000, validateStatus: () => true });
      const data = resp.data;
      const pass = resp.status < 500 && c.expect(data);
      results.push({ ...c, pass, status: resp.status, error: pass ? null : JSON.stringify(data).slice(0, 120) });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name} (${resp.status})`);
    } catch (e) {
      results.push({ ...c, pass: false, status: 0, error: e.message });
      console.log(`FAIL ${c.name} — ${e.message}`);
    }
  }
  const failed = results.filter((r) => !r.pass);
  const outPath = require('path').join(__dirname, '..', 'logs', 'cpd1055_proxy_qa.json');
  require('fs').writeFileSync(outPath, JSON.stringify({ base, at: new Date().toISOString(), results }, null, 2));
  console.log(`[qa] wrote ${outPath}`);
  if (failed.length) {
    console.error(`[qa] ${failed.length}/${results.length} failed`);
    process.exit(1);
  }
  console.log(`[qa] ${results.length}/${results.length} passed`);
}

run();
