'use strict';
/**
 * Load solo roster fleet config — sidecar A slots 1–5, sidecar B slots 6–10.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'solo_roster_fleet.json');

function loadFleetConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function currentFleetId() {
  return String(process.env.LIVE_GRID_FLEET_ID || 'a').toLowerCase();
}

function sidecarForFleet(fleetId) {
  const cfg = loadFleetConfig();
  const id = String(fleetId || currentFleetId()).toLowerCase();
  const sidecar = (cfg.sidecars || []).find((s) => String(s.id).toLowerCase() === id);
  if (!sidecar) throw new Error(`unknown fleet id: ${id}`);
  return sidecar;
}

/** Slots owned by this sidecar with local pool index 1–5. */
function localFleetSlots(fleetId) {
  const sidecar = sidecarForFleet(fleetId);
  return (sidecar.slots || []).map((s, i) => ({
    ...s,
    localPool: i + 1,
    localIndex: i,
    sidecarId: sidecar.id,
    sidecarUrl: sidecar.url,
  }));
}

function fleetSlotMap(fleetId) {
  const out = {};
  for (const s of localFleetSlots(fleetId)) {
    out[s.login.toLowerCase()] = s;
  }
  return out;
}

function loginSlotMapForBindings(fleetId) {
  const map = {};
  for (const s of localFleetSlots(fleetId)) {
    map[s.login] = s.localPool;
  }
  return map;
}

function isSlotPaused(slotDef) {
  if (isFleetPaused()) return true;
  return slotDef?.paused === true;
}

function isFleetPaused() {
  try {
    return loadFleetConfig().fleetPaused === true;
  } catch {
    return false;
  }
}

function fleetPausedReason() {
  try {
    return loadFleetConfig().fleetPausedReason || 'fleet paused in roster config';
  } catch {
    return 'fleet paused';
  }
}

module.exports = {
  CONFIG_PATH,
  loadFleetConfig,
  currentFleetId,
  sidecarForFleet,
  localFleetSlots,
  fleetSlotMap,
  loginSlotMapForBindings,
  isSlotPaused,
  isFleetPaused,
  fleetPausedReason,
};
