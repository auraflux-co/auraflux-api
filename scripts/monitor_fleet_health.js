#!/usr/bin/env node
'use strict';
/**
 * Poll Sidecar /live-grid/fleet/health and append JSONL (CPD-1070).
 *
 *   BROADCAST_SIDECAR_URL=https://auraflux-broadcast-staging.onrender.com \
 *   BROADCAST_OPERATOR_SECRET=... \
 *   node scripts/monitor_fleet_health.js
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const BASE = (process.env.BROADCAST_SIDECAR_URL || 'http://localhost:3000').replace(/\/$/, '');
const SECRET = process.env.BROADCAST_OPERATOR_SECRET || '';
const INTERVAL_MS = Number(process.env.FLEET_HEALTH_POLL_MS || 45000);
const OUT = process.env.FLEET_HEALTH_LOG || path.join('logs', 'fleet_health_watch.jsonl');

async function poll() {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const r = await fetch(`${BASE}/live-grid/fleet/health`, { headers });
  const body = await r.json();
  const line = JSON.stringify({ ts: new Date().toISOString(), status: r.status, ...body });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, line + '\n');
  const tag = body.health?.tag || 'n/a';
  const worst = body.health?.worstLiveScore;
  console.log(`[fleet-health] ${tag} worst=${worst ?? '—'} live=${body.health?.liveCount ?? 0}`);
}

poll().catch((e) => console.error(e));
setInterval(() => poll().catch((e) => console.error(e)), INTERVAL_MS);
