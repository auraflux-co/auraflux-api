'use strict';

/**
 * Live Grid preflight — run before GO LIVE or after sidecar restart.
 * Read-only checks: env baseline, RTMP encode plan, unit tests (optional).
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { describeEncodePlan } = require('./compositor');
const { checkRtmpLandscapeEncode } = require('./rtmp_landscape_guard');

const PROFILE_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_profile_baseline.json');

function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readEnvFile(envPath) {
  const out = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}

function checkEnvBaseline(envPath = path.join(__dirname, '..', '..', '.env')) {
  const profile = loadProfile();
  if (!profile?.env) {
    return { ok: true, skipped: true, reason: 'no profile' };
  }
  const file = readEnvFile(envPath);
  const mismatches = [];
  for (const [k, want] of Object.entries(profile.env)) {
    const got = file[k];
    if (got !== want) mismatches.push({ key: k, want, got: got ?? null });
  }
  const critical = ['LIVE_GRID_YOUTUBE_SQUARE_PAD', 'LIVE_GRID_OUTPUT_W', 'LIVE_GRID_OUTPUT_H',
    'LIVE_GRID_AUDIO_DIRECT', 'LIVE_GRID_UDP_RELAY', 'LIVE_GRID_ENCODER', 'LIVE_GRID_DUAL_BROADCAST'];
  for (const k of critical) {
    const extra = profile.env[k];
    if (extra && file[k] !== extra && !mismatches.find((m) => m.key === k)) {
      mismatches.push({ key: k, want: extra, got: file[k] ?? null });
    }
  }
  const squarePad = file.LIVE_GRID_YOUTUBE_SQUARE_PAD ?? 'off';
  if (squarePad === 'on') {
    mismatches.push({
      key: 'LIVE_GRID_YOUTUBE_SQUARE_PAD',
      want: 'off',
      got: 'on',
      note: 'square pad sends 1080×1080 to YouTube — caused bad VODs',
    });
  }
  return {
    ok: mismatches.length === 0,
    profile: profile.name,
    mismatches,
    fix: mismatches.length ? 'bash scripts/live_grid_baseline.sh apply && pm2 restart broadcast-sidecar --update-env' : null,
  };
}

function checkEncodePlan() {
  const output = process.env.LIVE_GRID_RTMP_URL || null;
  const localHls = path.join(__dirname, '..', '..', 'tmp', 'live_grid', 'preview', 'index.m3u8');
  const plan = describeEncodePlan({ output, localHlsPath: output ? localHls : null });
  const guard = checkRtmpLandscapeEncode({ output, localHlsPath: output ? localHls : null });
  return { ok: guard.ok !== false, plan, guard };
}

function checkFeatureLocks() {
  const profile = loadProfile();
  return {
    features: profile?.featuresLocked || [],
    code: profile?.codeLocked || [],
    doNotRevert: profile?.doNotRevertWithoutReason || [],
  };
}

function runUnitTests(root = path.join(__dirname, '..', '..')) {
  const files = [
    'test/live_grid_rtmp_landscape_guard.test.js',
    'test/live_grid_feed_guard.test.js',
    'test/live_grid_audio_pin.test.js',
    'test/live_grid_resume_state.test.js',
    'test/music_detector.test.js',
    'test/live_grid_brand_overlay.test.js',
  ];
  const results = [];
  let ok = true;
  for (const f of files) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const usesNodeTest = src.includes("require('node:test')");
    const cmd = usesNodeTest
      ? { bin: 'node', args: ['--test', abs] }
      : { bin: 'npx', args: ['jest', '--runInBand', '--silent', abs] };
    try {
      execFileSync(cmd.bin, cmd.args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
      results.push({ file: f, ok: true, runner: usesNodeTest ? 'node:test' : 'jest' });
    } catch (e) {
      ok = false;
      results.push({
        file: f,
        ok: false,
        runner: usesNodeTest ? 'node:test' : 'jest',
        error: String(e.stderr || e.stdout || e.message).slice(0, 500),
      });
    }
  }
  return { ok, results };
}

/** Full preflight report (safe while grid is off). */
function runPreflight(opts = {}) {
  const env = checkEnvBaseline(opts.envPath);
  const encode = checkEncodePlan();
  const locks = checkFeatureLocks();
  const tests = opts.skipTests ? { ok: true, skipped: true } : runUnitTests(opts.root);
  const blocking = [];
  if (!env.ok && !env.skipped) blocking.push('env baseline drift');
  if (!encode.ok) blocking.push(encode.guard?.error || 'RTMP encode plan');
  if (!tests.ok && !tests.skipped) blocking.push('unit tests failed');
  return {
    ok: blocking.length === 0,
    blocking,
    env,
    encode,
    locks,
    tests,
    readyForGoLive: blocking.length === 0,
  };
}

module.exports = {
  loadProfile,
  checkEnvBaseline,
  checkEncodePlan,
  checkFeatureLocks,
  runUnitTests,
  runPreflight,
};
