'use strict';
/**
 * Grid stability — tracks only changes that matter for live ops.
 * Ignores Twitch/YouTube viewer counts; 4× relay transcode CPU is baseline load.
 */

const BASELINE_HEALTH_ISSUES = new Set([
  'heavy_sources',
  'total_ffmpeg_cpu',
  'sources_1080p60',
  'upscale_path', // expected with transcode relay profile
]);

const STABLE_TICKS_REQUIRED = parseInt(process.env.LIVE_MONITOR_STABLE_TICKS || '10', 10);

function rosterKey(quadrants) {
  if (!Array.isArray(quadrants)) return '';
  return quadrants
    .slice()
    .sort((a, b) => a.quadrant - b.quadrant)
    .map((q) => `Q${q.quadrant}:${q.login || q.displayName || 'empty'}`)
    .join('|');
}

function extractGridSnapshot(status) {
  if (!status) return null;
  return {
    onAirQuad: status.audio?.quadrant ?? null,
    onAirLogin: status.audio?.login ?? null,
    audioMode: status.audio?.mode ?? null,
    audioMuted: !!status.audio?.muted,
    roster: rosterKey(status.quadrants),
    quadrants: (status.quadrants || []).map((q) => ({
      quadrant: q.quadrant,
      login: q.login || q.displayName || null,
    })),
  };
}

function diffGrid(prev, next) {
  const changes = [];
  if (!prev || !next) return changes;

  if (prev.onAirQuad !== next.onAirQuad || prev.onAirLogin !== next.onAirLogin) {
    changes.push({
      type: 'audio_routing',
      from: `Q${prev.onAirQuad} ${prev.onAirLogin || '—'}`,
      to: `Q${next.onAirQuad} ${next.onAirLogin || '—'}`,
      mode: next.audioMode,
    });
  } else if (prev.audioMode !== next.audioMode) {
    changes.push({
      type: 'audio_mode',
      from: prev.audioMode,
      to: next.audioMode,
    });
  }

  if (prev.roster !== next.roster) {
    const prevMap = Object.fromEntries((prev.quadrants || []).map((q) => [q.quadrant, q.login]));
    const nextMap = Object.fromEntries((next.quadrants || []).map((q) => [q.quadrant, q.login]));
    for (const q of [1, 2, 3, 4]) {
      if ((prevMap[q] || null) !== (nextMap[q] || null)) {
        changes.push({
          type: 'grid_swap',
          quad: q,
          from: prevMap[q] || 'empty',
          to: nextMap[q] || 'empty',
        });
      }
    }
  }

  return changes;
}

function filterActionableHealthIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  const baseline = [];
  const actionable = [];
  for (const iss of list) {
    const key = String(iss).split(':')[0];
    if (BASELINE_HEALTH_ISSUES.has(key)) baseline.push(iss);
    else actionable.push(iss);
  }
  return { baseline, actionable };
}

function computeStabilityTick({
  prevState,
  gridStatus,
  healthTick,
  avProbeTick,
}) {
  const grid = extractGridSnapshot(gridStatus);
  const prevGrid = prevState?.lastGrid || null;
  const gridChanges = diffGrid(prevGrid, grid);

  const healthIssues = healthTick?.issues || [];
  const viewerIssues = healthTick?.viewerIssues || [];
  const { baseline: baselineHealth, actionable: actionableHealth } = filterActionableHealthIssues([
    ...healthIssues,
    ...viewerIssues,
  ]);

  const relayChurnSum = (healthTick?.relayChurn || []).reduce((s, n) => s + (n || 0), 0);
  const masterRestarts = healthTick?.masterRestarts ?? 0;
  const videoLevel = avProbeTick?.videoLevel || 'unknown';
  const audioLevel = avProbeTick?.audioLevel || 'unknown';
  const videoIssues = avProbeTick?.videoIssues || [];
  const audioIssues = avProbeTick?.audioIssues || [];

  const blockers = [];
  if (masterRestarts > 0) blockers.push(`master_restarts:${masterRestarts}`);
  if (relayChurnSum >= 2) blockers.push(`relay_churn:${relayChurnSum}`);
  if (videoLevel === 'critical') blockers.push('av_video_critical');
  if (audioLevel === 'critical') blockers.push('av_audio_critical');
  if (videoIssues.some((i) => /frozen|black|no_frame/i.test(i))) blockers.push('av_frozen_or_black');
  if (audioIssues.some((i) => /silent|no_audio/i.test(i))) blockers.push('av_silent');
  if (audioIssues.some((i) => /choppy|audio_gaps|dropout/i.test(i))) blockers.push('av_audio_choppy');
  for (const iss of actionableHealth) {
    if (/master_down|youtube_stale|dts_error|rtsp_probe_fail|ffmpeg_decode_lag|fallback_music/.test(iss)) {
      blockers.push(iss);
    }
  }

  const informationalChanges = gridChanges.filter((c) => c.type === 'grid_swap' || c.type === 'audio_routing');
  const hadMeaningfulChange = informationalChanges.length > 0;

  let stableStreak = prevState?.stableStreak ?? 0;
  if (blockers.length === 0 && !hadMeaningfulChange) {
    stableStreak += 1;
  } else if (blockers.length > 0) {
    stableStreak = 0;
  } else if (hadMeaningfulChange) {
    // Operator swaps are expected — do not reset streak, but note the change
    stableStreak = Math.max(0, stableStreak);
  }

  const isStable = stableStreak >= STABLE_TICKS_REQUIRED && blockers.length === 0;
  const level = blockers.length
    ? 'critical'
    : hadMeaningfulChange || videoLevel === 'warn' || audioLevel === 'warn' || actionableHealth.length
      ? 'warn'
      : isStable
        ? 'stable'
        : 'warming';

  return {
    ts: new Date().toISOString(),
    level,
    isStable,
    stableStreak,
    stableTicksRequired: STABLE_TICKS_REQUIRED,
    grid,
    gridChanges,
    blockers,
    baselineHealth,
    actionableHealth,
    av: {
      videoLevel,
      audioLevel,
      videoScore: avProbeTick?.videoScore ?? null,
      audioScore: avProbeTick?.audioScore ?? null,
      videoIssues,
      audioIssues,
    },
    pipeline: {
      masterRestarts,
      relayChurnSum,
      relayRestarts: healthTick?.relayRestarts || null,
      masterCpu: healthTick?.masterCpu ?? null,
      encodeFps: healthTick?.encode?.fps ?? null,
      gridRunning: healthTick?.gridRunning ?? gridStatus?.running ?? null,
    },
    watchUrl: gridStatus?.broadcast?.watchUrl || avProbeTick?.watchUrl || null,
    lastGrid: grid,
  };
}

function buildAgentMarkdown(state) {
  const lines = [
    `# Live monitor — ${state.ts}`,
    '',
    '**Read-only** — polls stream-health + A/V probe. No fixes applied without operator approval.',
    '',
    `**Stability:** ${state.level.toUpperCase()} · streak **${state.stableStreak}/${state.stableTicksRequired}**${state.isStable ? ' · ✅ STABLE — no tweaks needed' : ''}`,
    '',
    '## Philosophy',
    '- YouTube viewer count is **not** a tuning signal — audience is on YouTube CDN, not our encoder.',
    '- **4 relay transcodes** = fixed power load; `heavy_sources` / high ffmpeg CPU is baseline, not a failure.',
    '- **Only runtime changes that matter:** which quad has on-air audio, which streamer leaves/enters a grid box.',
    '',
  ];

  if (state.gridChanges?.length) {
    lines.push('## Grid changes this tick');
    for (const c of state.gridChanges) {
      if (c.type === 'audio_routing') {
        lines.push(`- **Audio routing:** ${c.from} → ${c.to} (${c.mode || 'mode unknown'})`);
      } else if (c.type === 'grid_swap') {
        lines.push(`- **Q${c.quad} swap:** ${c.from} → ${c.to}`);
      } else {
        lines.push(`- ${c.type}: ${JSON.stringify(c)}`);
      }
    }
    lines.push('');
  }

  if (state.blockers?.length) {
    lines.push('## Blockers (must clear before stable)');
    for (const b of state.blockers) lines.push(`- ${b}`);
    lines.push('');
  }

  lines.push('## A/V probe (sampled RTSP)');
  lines.push(`- Video: **${state.av.videoLevel}** (${state.av.videoScore ?? '—'}/100)`);
  lines.push(`- Audio: **${state.av.audioLevel}** (${state.av.audioScore ?? '—'}/100)`);
  if (state.av.videoIssues?.length) {
    lines.push('- Video issues:');
    for (const i of state.av.videoIssues) lines.push(`  - ${i}`);
  }
  if (state.av.audioIssues?.length) {
    lines.push('- Audio issues:');
    for (const i of state.av.audioIssues) lines.push(`  - ${i}`);
  }
  lines.push('');

  lines.push('## Pipeline (encoder / relays)');
  const g = state.grid;
  lines.push(`- On-air: **Q${g?.onAirQuad || '—'}** ${g?.onAirLogin || ''} · mode ${g?.audioMode || '—'}`);
  lines.push(`- Master restarts: ${state.pipeline.masterRestarts ?? 0} · relay churn tick: ${state.pipeline.relayChurnSum ?? 0}`);
  if (state.pipeline.masterCpu != null) lines.push(`- Master CPU ${state.pipeline.masterCpu}%`);
  lines.push('');

  if (state.baselineHealth?.length) {
    lines.push('## Baseline load (informational — do not tune for these)');
    for (const b of state.baselineHealth) lines.push(`- ${b}`);
    lines.push('');
  }

  if (state.actionableHealth?.length) {
    lines.push('## Actionable health flags');
    for (const a of state.actionableHealth) lines.push(`- ${a}`);
    lines.push('');
  }

  if (state.watchUrl) {
    lines.push(`## Watch (localhost QA)`);
    const lp = require('./local_preview').resolveLocalPreviewConfig();
    lines.push(`- Composed HLS: ${lp.hlsUrl}${require('./local_preview').hlsPreviewReady() ? ' (ready)' : ' (pending grid restart)'}`);
    lines.push(`- Watch page: ${lp.watchPageUrl}`);
    if (!state.watchUrl.includes('local-watch')) {
      lines.push(`- YouTube (optional): ${state.watchUrl}`);
    }
    lines.push('');
  }

  lines.push('## Agent endpoints');
  lines.push('- `GET /broadcast/live-monitor` — this report (JSON + markdown)');
  lines.push('- `GET /broadcast/av-probe` — frame snapshots + audio levels');
  lines.push('- `GET /broadcast/stream-health` — relay/encode/youtube pipeline');
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  STABLE_TICKS_REQUIRED,
  BASELINE_HEALTH_ISSUES,
  extractGridSnapshot,
  diffGrid,
  filterActionableHealthIssues,
  computeStabilityTick,
  buildAgentMarkdown,
};
