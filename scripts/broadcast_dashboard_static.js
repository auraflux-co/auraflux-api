#!/usr/bin/env node
'use strict';
/**
 * Serve broadcast dashboard from cwn-production (no c0 / no localhost proxy).
 * Live grid + TV API calls go direct to Render via broadcast_api.js + CORS.
 *
 *   LIVE_SIDECAR_URL=https://auraflux-broadcast-staging.onrender.com node scripts/broadcast_dashboard_static.js
 *   open http://localhost:8765/cwn_production.html → Broadcast tab
 */
const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const fleetConfigPath = path.join(__dirname, '..', 'config', 'solo_roster_fleet.json');
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
const root = path.join(__dirname, '..');
const BUILD_TAG = 'cpd-1067-fleet-split-v2';

const app = express();
app.get('/cwn_production.html', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(root, 'cwn_production.html'));
});
app.get('/broadcast-config.js', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(
    `window.__BROADCAST_DASHBOARD_BUILD__=${JSON.stringify(BUILD_TAG)};` +
    `window.__BROADCAST_SIDECAR_URL__=${JSON.stringify(SIDECAR)};` +
    `window.__BROADCAST_SIDECAR_B_URL__=${JSON.stringify(SIDECAR_B)};` +
    `window.__BROADCAST_OPERATOR_SECRET__=${JSON.stringify(OPERATOR)};` +
    `window.__FLEET_ROSTER_CONFIG__=${fleetConfigJson};`,
  );
});
app.use(express.static(root));
const server = app.listen(PORT, HOST, () => {
  console.log(`[broadcast-dashboard] build=${BUILD_TAG} http://127.0.0.1:${PORT}/cwn_production.html → Broadcast sidebar`);
  console.log(`[broadcast-dashboard] sidecar=${SIDECAR} (direct — no c0 proxy)`);
  if (!OPERATOR) console.warn('[broadcast-dashboard] BROADCAST_OPERATOR_SECRET missing — fleet start will 401');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[broadcast-dashboard] Port ${PORT} in use — often stale cwn-c0 Python:`);
    console.error(`  lsof -i :${PORT}`);
    console.error(`  pkill -f "http.server ${PORT}"`);
    process.exit(1);
  }
  throw err;
});
