'use strict';

/**
 * CPD-1063 — Encode contract for 1 main grid + 4 solo YouTube outputs.
 * Single source for benchmark tiers, status snapshots, and uniform solo max env.
 */

const path = require('path');
const { gridEncodeConfig, gridLayoutDims } = require('./compositor');
const { soloOutputDims } = require('./solo_publishers');
const { soloFocusSeat, readSoloSeatInt, clearSoloFocusEnv } = require('./solo_focus');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');

/** YouTube 1080p30 recommended ingest (Studio stream health). */
const YT_1080P30_MAX_K = 6800;
const YT_720P30_HIGH_K = 4500;

const BENCHMARK_PROFILES = {
  baseline: 'live_grid_profile_render.json',
  tier_b: 'live_grid_profile_benchmark_tier_b.json',
  tier_c: 'live_grid_profile_benchmark_tier_c.json',
};

/** Ramp steps for 5-stream capacity test (off-air staging). */
const BENCHMARK_STEPS = {
  0: {
    label: 'baseline',
    profile: 'baseline',
    description: 'Current production profile — measure CPU and Studio bitrates',
    mainEncode: true,
    soloSeats: [1, 2, 3, 4],
    clearFocus: true,
  },
  1: {
    label: 'main_only_max',
    profile: 'tier_c',
    description: 'Main 1080p @ 6800k only — no solo encoders',
    mainEncode: true,
    soloSeats: [],
    clearFocus: true,
    mainOverrides: { bitrateK: YT_1080P30_MAX_K, maxrateK: YT_1080P30_MAX_K, bufsizeK: YT_1080P30_MAX_K * 2 },
  },
  2: {
    label: 'main_plus_one_solo_max',
    profile: 'tier_c',
    description: 'Main 6800k + Q1 solo 6800k — 2 encoders',
    mainEncode: true,
    soloSeats: [1],
    clearFocus: true,
    mainOverrides: { bitrateK: YT_1080P30_MAX_K, maxrateK: YT_1080P30_MAX_K, bufsizeK: YT_1080P30_MAX_K * 2 },
    soloOverrides: { bitrateK: YT_1080P30_MAX_K, maxrateK: YT_1080P30_MAX_K, bufsizeK: YT_1080P30_MAX_K * 2, w: 1920, h: 1080 },
  },
  3: {
    label: 'full_stack_tier_b',
    profile: 'tier_b',
    description: 'Main 6800k + 4 solos 720p @ 4500k',
    mainEncode: true,
    soloSeats: [1, 2, 3, 4],
    clearFocus: true,
  },
  4: {
    label: 'full_stack_tier_c',
    profile: 'tier_c',
    description: 'Main 6800k + 4 solos 1080p @ 6800k — stretch goal',
    mainEncode: true,
    soloSeats: [1, 2, 3, 4],
    clearFocus: true,
  },
};

function loadProfileEnv(profileKey) {
  const file = BENCHMARK_PROFILES[profileKey] || profileKey;
  const profilePath = path.isAbsolute(file) ? file : path.join(CONFIG_DIR, file);
  try {
    const raw = JSON.parse(require('fs').readFileSync(profilePath, 'utf8'));
    return { path: profilePath, env: raw.env || {}, meta: raw };
  } catch (e) {
    return { path: profilePath, env: null, error: e.message };
  }
}

function mainEncodeSnapshot() {
  const cfg = gridEncodeConfig();
  const { outW, outH } = gridLayoutDims();
  return {
    role: 'main_grid',
    w: outW,
    h: outH,
    fps: cfg.fps,
    bitrateK: cfg.bitrateK,
    maxrateK: parseInt(process.env.LIVE_GRID_X264_MAXRATE_K || String(cfg.bitrateK), 10),
    bufsizeK: parseInt(process.env.LIVE_GRID_X264_BUFSIZE_K || String(cfg.bitrateK * 2), 10),
    audioBitrateK: cfg.audioBitrateK,
    encoder: cfg.encoder,
    preset: process.env.LIVE_GRID_X264_PRESET || 'ultrafast',
    youtubeTargetK: YT_1080P30_MAX_K,
  };
}

function soloEncodeSnapshot(q) {
  const seat = q + 1;
  const dims = soloOutputDims(q);
  const h = dims.h;
  const youtubeTargetK = h >= 1080 ? YT_1080P30_MAX_K : YT_720P30_HIGH_K;
  return {
    role: 'solo',
    quadrant: seat,
    w: dims.w,
    h: dims.h,
    fps: dims.fps,
    bitrateK: dims.bitrateK,
    maxrateK: readSoloSeatInt(q, 'X264_MAXRATE_K', dims.bitrateK),
    bufsizeK: readSoloSeatInt(q, 'X264_BUFSIZE_K', dims.bitrateK * 2),
    audioBitrateK: dims.audioK,
    encoder: process.env.LIVE_GRID_ENCODER || 'libx264',
    preset: process.env.LIVE_GRID_X264_PRESET || 'ultrafast',
    youtubeTargetK,
    meetsYoutubeTarget: dims.bitrateK >= youtubeTargetK,
  };
}

/**
 * Full 1+4 encode contract for /live-grid/status and benchmark logs.
 * @param {object} [runtime] — optional { mainRunning, soloRunning: boolean[4], focusConfig }
 */
function buildEncodeContractSnapshot(runtime = {}) {
  const main = mainEncodeSnapshot();
  const solos = [0, 1, 2, 3].map((q) => ({
    ...soloEncodeSnapshot(q),
    running: runtime.soloRunning?.[q] ?? null,
    ffmpegActive: runtime.soloRunning?.[q] ?? null,
  }));
  const activeSolos = solos.filter((_, i) => runtime.soloRunning?.[i] !== false);
  const soloVideoK = solos.reduce((sum, s) => sum + (runtime.soloRunning?.[s.quadrant - 1] ? s.bitrateK : 0), 0);
  const mainVideoK = runtime.mainRunning !== false ? main.bitrateK : 0;
  const focus = soloFocusSeat();
  return {
    template: '1grid_4solos',
    focusSeat: focus,
    heroMode: !!runtime.focusConfig,
    main: {
      ...main,
      running: runtime.mainRunning ?? null,
      meetsYoutubeTarget: main.bitrateK >= YT_1080P30_MAX_K,
    },
    solos,
    totals: {
      configuredVideoBitrateK: main.bitrateK + solos.reduce((s, x) => s + x.bitrateK, 0),
      activeVideoBitrateK: mainVideoK + soloVideoK,
      encoderCount: (runtime.mainRunning !== false ? 1 : 0)
        + solos.filter((s) => runtime.soloRunning?.[s.quadrant - 1]).length,
    },
    passHints: {
      allSolosUniform: new Set(solos.map((s) => `${s.w}x${s.h}@${s.bitrateK}k`)).size === 1,
      allMeetYoutube1080p: main.bitrateK >= YT_1080P30_MAX_K && solos.every((s) => s.meetsYoutubeTarget),
    },
  };
}

function applyMainEncodeEnv(overrides = {}) {
  if (overrides.bitrateK != null) process.env.LIVE_GRID_BITRATE_K = String(overrides.bitrateK);
  if (overrides.maxrateK != null) process.env.LIVE_GRID_X264_MAXRATE_K = String(overrides.maxrateK);
  if (overrides.bufsizeK != null) process.env.LIVE_GRID_X264_BUFSIZE_K = String(overrides.bufsizeK);
  if (overrides.w != null) process.env.LIVE_GRID_OUTPUT_W = String(overrides.w);
  if (overrides.h != null) process.env.LIVE_GRID_OUTPUT_H = String(overrides.h);
  if (overrides.fps != null) process.env.LIVE_GRID_FPS = String(overrides.fps);
  process.env.LIVE_GRID_MAIN_ENCODE = 'on';
}

function applyUniformSoloEncodeEnv(overrides = {}, seats = [1, 2, 3, 4]) {
  for (const seat of seats) {
    if (overrides.bitrateK != null) process.env[`LIVE_GRID_SOLO_${seat}_BITRATE_K`] = String(overrides.bitrateK);
    if (overrides.maxrateK != null) process.env[`LIVE_GRID_SOLO_${seat}_X264_MAXRATE_K`] = String(overrides.maxrateK);
    if (overrides.bufsizeK != null) process.env[`LIVE_GRID_SOLO_${seat}_X264_BUFSIZE_K`] = String(overrides.bufsizeK);
    if (overrides.w != null) process.env[`LIVE_GRID_SOLO_${seat}_OUTPUT_W`] = String(overrides.w);
    if (overrides.h != null) process.env[`LIVE_GRID_SOLO_${seat}_OUTPUT_H`] = String(overrides.h);
    if (overrides.fps != null) process.env[`LIVE_GRID_SOLO_${seat}_FPS`] = String(overrides.fps);
    if (overrides.audioK != null) process.env[`LIVE_GRID_SOLO_${seat}_AUDIO_BITRATE_K`] = String(overrides.audioK);
  }
  if (overrides.bitrateK != null) process.env.LIVE_GRID_SOLO_BITRATE_K = String(overrides.bitrateK);
  if (overrides.w != null) process.env.LIVE_GRID_SOLO_OUTPUT_W = String(overrides.w);
  if (overrides.h != null) process.env.LIVE_GRID_SOLO_OUTPUT_H = String(overrides.h);
}

function applyProfileEnvToProcess(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value == null || value === '') continue;
    process.env[key] = String(value);
  }
}

function getBenchmarkStepSpec(step) {
  const n = Number(step);
  const spec = BENCHMARK_STEPS[n];
  if (!spec) throw new Error(`benchmark step must be 0–4 (got ${step})`);
  return { step: n, ...spec };
}

function applyBenchmarkStepEnv(step) {
  const spec = getBenchmarkStepSpec(step);
  const loaded = loadProfileEnv(spec.profile);
  if (!loaded.env) throw new Error(`profile load failed: ${loaded.path} — ${loaded.error || 'missing'}`);

  if (spec.clearFocus) clearSoloFocusEnv();

  applyProfileEnvToProcess(loaded.env);

  if (spec.mainOverrides) applyMainEncodeEnv(spec.mainOverrides);
  if (spec.soloOverrides) applyUniformSoloEncodeEnv(spec.soloOverrides, spec.soloSeats);

  process.env.LIVE_GRID_MAIN_ENCODE = spec.mainEncode === false ? 'off' : 'on';
  process.env.LIVE_GRID_SOLO_STREAMS = spec.soloSeats.length ? 'on' : 'off';

  if (spec.soloSeats.length === 4) {
    delete process.env.LIVE_GRID_SOLO_FOCUS;
  } else if (spec.soloSeats.length === 1) {
    process.env.LIVE_GRID_SOLO_FOCUS = String(spec.soloSeats[0]);
  }

  return {
    ...spec,
    profilePath: loaded.path,
    encodeContract: buildEncodeContractSnapshot({
      mainRunning: spec.mainEncode,
      soloRunning: [1, 2, 3, 4].map((s) => spec.soloSeats.includes(s)),
    }),
  };
}

module.exports = {
  CONFIG_DIR,
  YT_1080P30_MAX_K,
  YT_720P30_HIGH_K,
  BENCHMARK_PROFILES,
  BENCHMARK_STEPS,
  loadProfileEnv,
  mainEncodeSnapshot,
  soloEncodeSnapshot,
  buildEncodeContractSnapshot,
  applyMainEncodeEnv,
  applyUniformSoloEncodeEnv,
  applyProfileEnvToProcess,
  getBenchmarkStepSpec,
  applyBenchmarkStepEnv,
};
