#!/usr/bin/env node
'use strict';
/**
 * Serve the **full** operator dashboard from cwn-c0 on :8765.
 *
 * cwn-production/cwn_production.html is a Render-trimmed fork (~10k lines).
 * cwn-c0/cwn_production.html is the canonical localhost dashboard (~13k lines):
 * Channel Stats, stream health, live show pack, calendar, etc.
 *
 * Pipeline APIs (jobs, stats, /stats/channel) still hit localhost:3000 via CFG.ffmpegUrl
 * — keep `pm2 auraflux` running.
 *
 * Live grid/TV can proxy via :3000 → sidecar, or direct to Render when
 * broadcast-config.js + broadcast_api.js are loaded (optional extension).
 *
 *   npm run dashboard
 *   open http://localhost:8765/cwn_production.html
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prodRoot = path.join(__dirname, '..');
const c0Root = process.env.C0_DASHBOARD_ROOT || path.join(os.homedir(), 'cwn-c0');
const fleetConfigPath = path.join(prodRoot, 'config', 'solo_roster_fleet.json');

let fleetConfigJson = '{}';
try {
  fleetConfigJson = JSON.stringify(JSON.parse(fs.readFileSync(fleetConfigPath, 'utf8')));
} catch (e) {
  console.warn('[broadcast-dashboard] fleet config missing:', e.message);
}

const PORT = Number(process.env.BROADCAST_DASHBOARD_PORT || 8765);
const HOST = process.env.BROADCAST_DASHBOARD_HOST || '::';
const SIDECAR = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const SIDECAR_B = (process.env.BROADCAST_SIDECAR_B_URL || 'https://auraflux-broadcast-staging-b.onrender.com').replace(/\/$/, '');
const OPERATOR = process.env.BROADCAST_OPERATOR_SECRET || '';
const BUILD_TAG = 'cpd-1067-c0-dashboard-v1';

const c0Html = path.join(c0Root, 'cwn_production.html');
const dashboardRoot = fs.existsSync(c0Html) ? c0Root : prodRoot;

if (dashboardRoot === prodRoot) {
  console.warn('[broadcast-dashboard] cwn-c0 not found at', c0Root);
  console.warn('[broadcast-dashboard] serving trimmed cwn-production copy — stats page missing');
} else {
  console.log('[broadcast-dashboard] serving full dashboard from', c0Root);
}

const app = express();

app.get('/cwn_production.html', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(dashboardRoot, 'cwn_production.html'));
});

app.get('/broadcast-config.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(
    `window.__BROADCAST_DASHBOARD_BUILD__=${JSON.stringify(BUILD_TAG)};` +
    `window.__BROADCAST_DASHBOARD_ROOT__=${JSON.stringify(dashboardRoot)};` +
    `window.__BROADCAST_SIDECAR_URL__=${JSON.stringify(SIDECAR)};` +
    `window.__BROADCAST_SIDECAR_B_URL__=${JSON.stringify(SIDECAR_B)};` +
    `window.__BROADCAST_OPERATOR_SECRET__=${JSON.stringify(OPERATOR)};` +
    `window.__FLEET_ROSTER_CONFIG__=${fleetConfigJson};`,
  );
});

// cwn-c0 may lack production-only assets
app.get('/assets/broadcast_api.js', (_req, res) => {
  res.sendFile(path.join(prodRoot, 'assets/broadcast_api.js'));
});

app.use(express.static(dashboardRoot));
app.use(express.static(prodRoot));

const server = app.listen(PORT, HOST, () => {
  console.log(`[broadcast-dashboard] build=${BUILD_TAG}`);
  console.log(`[broadcast-dashboard] http://127.0.0.1:${PORT}/cwn_production.html`);
  console.log(`[broadcast-dashboard] root=${dashboardRoot}`);
  console.log(`[broadcast-dashboard] sidecar=${SIDECAR} (live-grid via :3000 proxy or direct)`);
  if (!OPERATOR) console.warn('[broadcast-dashboard] BROADCAST_OPERATOR_SECRET missing — Render fleet start will 401');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[broadcast-dashboard] Port ${PORT} in use:`);
    console.error(`  lsof -i :${PORT}`);
    process.exit(1);
  }
  throw err;
});
