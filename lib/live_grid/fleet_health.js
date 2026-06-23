'use strict';
/**
 * Fleet slot health scoring — viewer experience + Kick ingest signals (CPD-1067).
 * Used by sidecar /live-grid/fleet/health and CLI monitors.
 */

function scoreFleetSlot(slot, quadrant, solo) {
  const reasons = [];
  let score = 100;
  const phase = slot.phase || 'idle';
  const feeder = quadrant?.kind || 'slate';
  const ffmpeg = !!solo?.ffmpegActive;
  const running = !!solo?.running;
  const failures = quadrant?.feedFailures || 0;
  const paused = !!slot.paused;

  if (paused) {
    return {
      score: null,
      level: 'paused',
      reasons: [slot.pausedReason || 'roster paused'],
    };
  }

  if (phase === 'idle') {
    return { score: null, level: 'idle', reasons: ['source offline or not started'] };
  }

  if (phase === 'starting') {
    score -= 25;
    reasons.push('slot still starting');
  }

  if (feeder === 'slate') {
    score -= 55;
    reasons.push('feeder on slate — spinner on YouTube');
  } else if (slot.platform === 'kick' && feeder !== 'url') {
    score -= 35;
    reasons.push(`kick feeder ${feeder} — expected HLS url`);
  } else if (slot.platform === 'twitch' && feeder !== 'channel' && feeder !== 'url') {
    score -= 35;
    reasons.push(`twitch feeder ${feeder} — expected channel`);
  }

  if (!running || !ffmpeg) {
    score -= 40;
    reasons.push('solo RTMP encoder down — YouTube may freeze/spin');
  }

  if (failures > 0) {
    score -= Math.min(30, failures * 10);
    reasons.push(`${failures} feeder failure(s)`);
  }

  if (phase === 'live' && feeder !== 'slate' && ffmpeg && running) {
    score = Math.max(score, 85);
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= 80 ? 'good' : score >= 50 ? 'degraded' : 'bad';
  return { score, level, reasons };
}

function slotLabel(fleetId, slot, login) {
  return `${String(fleetId).toUpperCase()}${slot} · @${login}`;
}

/**
 * Build health snapshot from /live-grid/status-shaped payload.
 * @param {object} status — sidecar status()
 * @param {string} fleetId
 */
function buildFleetHealth(status, fleetId = 'a') {
  const fleet = status?.fleetOrchestrator;
  if (!fleet) {
    return { ok: false, error: 'not_fleet_mode', fleetId, ts: new Date().toISOString() };
  }

  let fleetPaused = false;
  let fleetPausedReason = null;
  try {
    const { isFleetPaused, fleetPausedReason: reasonFn } = require('./solo_roster_fleet');
    fleetPaused = isFleetPaused();
    fleetPausedReason = fleetPaused ? reasonFn() : null;
  } catch (_) { /* optional */ }

  const quadrants = status.quadrants || [];
  const solos = status.encodeContract?.solos || [];
  const slots = (fleet.slots || []).map((s) => {
    const qIdx = (s.localPool || s.slot) - 1;
    const q = quadrants.find((x) => x.quadrant === (s.localPool || s.slot))
      || quadrants[qIdx]
      || {};
    const solo = solos.find((x) => x.poolSlot === (s.localPool || s.slot)) || {};
    const health = scoreFleetSlot(s, q, solo);
    return {
      key: `${fleetId}:${s.slot}`,
      slot: s.slot,
      localPool: s.localPool,
      label: slotLabel(fleetId, s.slot, s.login),
      login: s.login,
      platform: s.platform,
      phase: s.phase,
      paused: !!s.paused,
      pausedReason: s.pausedReason || null,
      broadcastId: s.broadcastId || null,
      watchUrl: s.watchUrl || null,
      feeder: q.kind || 'slate',
      feederLogin: q.login || null,
      feedFailures: q.feedFailures || 0,
      feedUnhealthy: !!q.feedUnhealthy,
      ffmpeg: !!solo.ffmpegActive,
      soloRunning: !!solo.running,
      soloRestarts: solo.restarts || 0,
      ...health,
    };
  });

  const live = slots.filter((s) => (s.phase === 'live' || s.phase === 'starting') && !s.paused);
  const worstLiveScore = live.reduce(
    (m, s) => (s.score != null && (m == null || s.score < m) ? s.score : m),
    null,
  );
  const tag = fleetPaused ? 'PAUSED'
    : live.some((s) => s.level === 'bad') ? 'BAD'
      : live.some((s) => s.level === 'degraded') ? 'DEGRADED'
        : live.length ? 'ok' : 'idle';

  return {
    ok: true,
    ts: new Date().toISOString(),
    fleetId,
    pollMs: fleet.pollMs,
    fleetPaused,
    fleetPausedReason,
    tag,
    worstLiveScore,
    liveCount: live.length,
    slots,
  };
}

module.exports = {
  scoreFleetSlot,
  slotLabel,
  buildFleetHealth,
};
