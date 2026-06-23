#!/usr/bin/env node
'use strict';
/**
 * Fleet CPU capacity watch — snapshot Render CPU/memory when live streamer count changes.
 *
 * Polls both broadcast sidecars (fleet health + solo encoder procs) and Render metrics.
 * Appends JSONL on concurrency increase (and optional decrease / heartbeat).
 *
 * Usage:
 *   node scripts/monitor_fleet_cpu_capacity.js
 *   node scripts/monitor_fleet_cpu_capacity.js --once
 *   MONITOR_INTERVAL_SEC=60 node scripts/monitor_fleet_cpu_capacity.js
 *
 * Env:
 *   MONITOR_INTERVAL_SEC=60
 *   FLEET_CPU_CAPACITY_LOG=logs/fleet_cpu_capacity.jsonl
 *   FLEET_CPU_HEARTBEAT_MIN=15     — baseline row even when count unchanged (0=off)
 *   FLEET_CPU_SNAPSHOT_DECREASE=on — log when live count drops
 *   RENDER_API_KEY                 — required for CPU/memory from Render API
 *   BROADCAST_OPERATOR_SECRET      — sidecar fleet health auth
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadFleetConfig } = require('../lib/live_grid/solo_roster_fleet');

const INTERVAL_MS = Math.max(30, parseInt(process.env.MONITOR_INTERVAL_SEC || '60', 10)) * 1000;
const LOG = process.env.FLEET_CPU_CAPACITY_LOG
  || path.join(__dirname, '..', 'logs', 'fleet_cpu_capacity.jsonl');
const HEARTBEAT_MS = Math.max(0, parseInt(process.env.FLEET_CPU_HEARTBEAT_MIN || '15', 10)) * 60 * 1000;
const SNAPSHOT_DECREASE = String(process.env.FLEET_CPU_SNAPSHOT_DECREASE ?? 'on').toLowerCase() !== 'off';
const ONCE = process.argv.includes('--once');
const SECRET = String(process.env.BROADCAST_OPERATOR_SECRET || '').trim();
const RENDER_KEY = String(process.env.RENDER_API_KEY || '').trim();

const state = {
  totalLive: null,
  perSidecar: {},
  lastHeartbeat: 0,
};

function log(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  const cpu = row.fleet?.totalCpuMax != null ? `${row.fleet.totalCpuMax}/${row.fleet.totalCpuLimit}` : '—';
  console.log(
    `[fleet-cpu] ${row.event} live=${row.totalLive} enc=${row.totalEncodersRunning} cpu=${cpu} → ${LOG}`,
  );
}

async function fetchRenderMetric(kind, serviceId) {
  if (!RENDER_KEY || !serviceId) return null;
  const url = `https://api.render.com/v1/metrics/${kind}?resource=${serviceId}&resolutionSeconds=60&aggregationMethod=MAX`;
  try {
    const { data } = await axios.get(url, {
      timeout: 20_000,
      headers: { Authorization: `Bearer ${RENDER_KEY}`, Accept: 'application/json' },
    });
    const series = Array.isArray(data) ? data[0] : data;
    const values = series?.values || [];
    if (!values.length) return null;
    const latest = values[values.length - 1];
    return {
      value: latest.value,
      unit: series.unit || (kind === 'cpu' ? 'cpu' : 'bytes'),
      timestamp: latest.timestamp,
    };
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

async function sidecarSnapshot(sidecar) {
  const base = sidecar.url.replace(/\/$/, '');
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const params = SECRET ? { operator: SECRET } : {};

  const [healthRes, statusRes] = await Promise.all([
    axios.get(`${base}/live-grid/fleet/health`, { headers, params, timeout: 25_000 }),
    axios.get(`${base}/live-grid/status`, { headers, params, timeout: 25_000 }),
  ]);

  const health = healthRes.data?.health || {};
  const status = statusRes.data || {};
  const liveSlots = (health.slots || []).filter(
    (s) => (s.phase === 'live' || s.phase === 'starting') && !s.paused,
  );
  const seats = status.soloStreams?.seats || [];
  const encodersRunning = seats.filter((s) => s.running).length;
  const healthyLive = liveSlots.filter((s) => {
    const seat = seats.find((x) => x.quadrant === s.localPool);
    return s.phase === 'live' && s.feeder !== 'slate' && (seat?.running || s.ffmpeg);
  });

  const [cpu, memory] = await Promise.all([
    fetchRenderMetric('cpu', sidecar.renderServiceId),
    fetchRenderMetric('memory', sidecar.renderServiceId),
  ]);

  const cpuLimit = sidecar.plan === 'pro_ultra' ? 8 : null;
  const memoryMb = memory?.value != null ? Math.round(memory.value / 1024 / 1024) : null;

  return {
    fleetId: sidecar.id,
    renderService: sidecar.renderService,
    renderServiceId: sidecar.renderServiceId,
    tag: health.tag,
    liveCount: health.liveCount ?? liveSlots.length,
    encodersRunning,
    healthyLiveCount: healthyLive.length,
    worstLiveScore: health.worstLiveScore,
    cpu: cpu?.value ?? null,
    cpuLimit,
    cpuPct: cpu?.value != null && cpuLimit ? +((cpu.value / cpuLimit) * 100).toFixed(1) : null,
    memoryMb,
    cpuAt: cpu?.timestamp || null,
    streams: liveSlots.map((s) => ({
      slot: s.slot,
      login: s.login,
      phase: s.phase,
      score: s.score,
      feeder: s.feeder,
      encoderUp: !!(seats.find((x) => x.quadrant === s.localPool)?.running || s.ffmpeg),
      broadcastId: s.broadcastId,
    })),
    metricsError: cpu?.error || memory?.error || null,
  };
}

function decideEvent(prevTotal, totalLive, prevPer, sidecars) {
  if (prevTotal == null) return 'baseline';
  if (totalLive > prevTotal) return 'concurrency_increase';
  if (totalLive < prevTotal && SNAPSHOT_DECREASE) return 'concurrency_decrease';
  for (const sc of sidecars) {
    const prev = prevPer[sc.fleetId] ?? 0;
    if (sc.liveCount > prev) return 'sidecar_increase';
    if (sc.liveCount < prev && SNAPSHOT_DECREASE) return 'sidecar_decrease';
  }
  if (HEARTBEAT_MS > 0 && Date.now() - state.lastHeartbeat >= HEARTBEAT_MS) return 'heartbeat';
  return null;
}

async function tick() {
  const cfg = loadFleetConfig();
  const sidecars = [];
  for (const sc of cfg.sidecars || []) {
    try {
      sidecars.push(await sidecarSnapshot(sc));
    } catch (e) {
      sidecars.push({
        fleetId: sc.id,
        renderService: sc.renderService,
        error: e.response?.data?.error || e.message,
      });
    }
  }

  const totalLive = sidecars.reduce((n, s) => n + (s.liveCount || 0), 0);
  const totalEncodersRunning = sidecars.reduce((n, s) => n + (s.encodersRunning || 0), 0);
  const totalHealthyLive = sidecars.reduce((n, s) => n + (s.healthyLiveCount || 0), 0);
  const totalCpuMax = sidecars.reduce((n, s) => n + (s.cpu || 0), 0) || null;
  const totalCpuLimit = sidecars.reduce((n, s) => n + (s.cpuLimit || 0), 0) || null;

  const event = decideEvent(state.totalLive, totalLive, state.perSidecar, sidecars);
  if (!event) return;

  const row = {
    ts: new Date().toISOString(),
    event,
    prevTotalLive: state.totalLive,
    totalLive,
    totalHealthyLive,
    totalEncodersRunning,
    sidecars,
    fleet: {
      totalCpuMax: totalCpuMax != null ? +totalCpuMax.toFixed(3) : null,
      totalCpuLimit,
      totalCpuPct: totalCpuMax != null && totalCpuLimit
        ? +((totalCpuMax / totalCpuLimit) * 100).toFixed(1)
        : null,
    },
  };

  log(row);

  state.totalLive = totalLive;
  state.perSidecar = Object.fromEntries(sidecars.map((s) => [s.fleetId, s.liveCount || 0]));
  if (event === 'heartbeat') state.lastHeartbeat = Date.now();
  else if (state.lastHeartbeat === 0) state.lastHeartbeat = Date.now();
}

async function main() {
  if (!RENDER_KEY) {
    console.warn('[fleet-cpu] RENDER_API_KEY missing — CPU/memory will be null');
  }
  console.log(
    `[fleet-cpu] watching fleet every ${INTERVAL_MS / 1000}s — log ${LOG}`
    + (HEARTBEAT_MS ? ` heartbeat every ${HEARTBEAT_MS / 60000}m` : ''),
  );
  await tick();
  if (ONCE) return;
  setInterval(() => tick().catch((e) => console.error('[fleet-cpu] tick failed:', e.message)), INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
