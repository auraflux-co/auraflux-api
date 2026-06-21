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
const SIDECAR = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const SIDECAR_B = (process.env.BROADCAST_SIDECAR_B_URL || 'https://auraflux-broadcast-staging-b.onrender.com').replace(/\/$/, '');
const OPERATOR = process.env.BROADCAST_OPERATOR_SECRET || '';
const root = path.join(__dirname, '..');

const app = express();
app.get('/broadcast-config.js', (_req, res) => {
  res.type('application/javascript').send(
    `window.__BROADCAST_SIDECAR_URL__=${JSON.stringify(SIDECAR)};` +
    `window.__BROADCAST_SIDECAR_B_URL__=${JSON.stringify(SIDECAR_B)};` +
    `window.__BROADCAST_OPERATOR_SECRET__=${JSON.stringify(OPERATOR)};` +
    `window.__FLEET_ROSTER_CONFIG__=${fleetConfigJson};`,
  );
});
app.use(express.static(root));
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[broadcast-dashboard] http://127.0.0.1:${PORT}/cwn_production.html`);
  console.log(`[broadcast-dashboard] sidecar=${SIDECAR} (direct — no c0 proxy)`);
});
