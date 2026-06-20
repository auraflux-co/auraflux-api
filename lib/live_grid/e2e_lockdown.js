'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const E2E_PROFILE_PATH = path.join(ROOT, 'config', 'live_grid_profile_e2e.json');
const BASELINE_PATH = path.join(ROOT, 'config', 'live_grid_profile_baseline.json');

function loadE2eProfile() {
  return JSON.parse(fs.readFileSync(E2E_PROFILE_PATH, 'utf8'));
}

function loadBaselineProfile() {
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/** Merged env lock: baseline + e2e extras (e2e wins on conflict). */
function mergedEnvLock() {
  const e2e = loadE2eProfile();
  const baseline = loadBaselineProfile();
  return { ...(baseline.env || {}), ...(e2e.envExtra || {}) };
}

function readEnvFile(envPath = path.join(ROOT, '.env')) {
  const out = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}

function checkEnvLockdown(envPath) {
  const want = mergedEnvLock();
  const file = readEnvFile(envPath);
  const mismatches = [];
  for (const [k, v] of Object.entries(want)) {
    if (file[k] !== v) mismatches.push({ key: k, want: v, got: file[k] ?? null });
  }
  return {
    ok: mismatches.length === 0,
    profile: loadE2eProfile().name,
    mismatches,
    fix: mismatches.length ? 'bash scripts/live_grid_e2e_lockdown.sh apply && pm2 restart broadcast-sidecar --update-env' : null,
  };
}

function checkEcosystemLockdown() {
  const e2e = loadE2eProfile();
  const locked = e2e.ecosystemLocked || {};
  const ecoPath = path.join(ROOT, 'ecosystem.config.js');
  const src = fs.readFileSync(ecoPath, 'utf8');
  const mismatches = [];
  for (const [k, v] of Object.entries(locked)) {
    const pattern = new RegExp(`${k}:\\s*['"]${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    if (!pattern.test(src)) {
      mismatches.push({ key: k, want: v, got: 'missing or different in ecosystem.config.js broadcast-sidecar' });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function ffmpegHasDrawtext(bin) {
  try {
    const filters = execFileSync(bin, ['-filters'], { encoding: 'utf8', timeout: 8000 });
    return String(filters).includes(' drawtext ');
  } catch {
    return false;
  }
}

function checkFfmpegDrawtext(envPath) {
  const file = readEnvFile(envPath);
  const bin = file.FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg';
  const ok = ffmpegHasDrawtext(bin);
  return {
    ok,
    bin,
    fix: ok ? null : 'brew install ffmpeg-full && set FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg in .env',
  };
}

function checkGoLiveConfig() {
  const e2e = loadE2eProfile();
  const cfgPath = path.join(ROOT, e2e.goLiveConfig || 'config/live_grid_go_live.json');
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, path: cfgPath, error: 'missing go-live config' };
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const issues = [];
  if (!cfg.seo?.title) issues.push('missing seo.title template');
  if (!cfg.operatorLocks?.length) issues.push('missing operatorLocks');
  return { ok: issues.length === 0, path: cfgPath, operatorLocks: cfg.operatorLocks?.length || 0, issues };
}

function checkRuntimeMaster() {
  const e2e = loadE2eProfile();
  const checks = e2e.runtimeChecks || {};
  let masterLine = '';
  try {
    masterLine = execFileSync('bash', ['-lc', "pgrep -fl 'ffmpeg.*tee.*preview/index.m3u8' | head -1 || true"], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
  } catch (_) {}

  if (!masterLine) {
    return { ok: true, skipped: true, reason: 'master not running' };
  }

  const issues = [];
  for (const forbidden of checks.forbidMasterEncoder || []) {
    if (masterLine.includes(forbidden)) issues.push(`master uses forbidden encoder ${forbidden}`);
  }
  if (checks.masterEncoder === 'videotoolbox' && !masterLine.includes('h264_videotoolbox')) {
    issues.push('master not using h264_videotoolbox');
  }
  if (checks.forbidSquarePad && masterLine.includes('pad=1080:1080')) {
    issues.push('master square-pads RTMP');
  }
  if (checks.requireRtmpSize && !masterLine.includes(`-s ${checks.requireRtmpSize}`)) {
    issues.push(`master missing -s ${checks.requireRtmpSize}`);
  }
  return { ok: issues.length === 0, masterLine: masterLine.slice(0, 120), issues };
}

function buildLockedStartPayload() {
  const e2e = loadE2eProfile();
  const goLivePath = path.join(ROOT, e2e.goLiveConfig || 'config/live_grid_go_live.json');
  const cfg = JSON.parse(fs.readFileSync(goLivePath, 'utf8'));
  const base = { ...(e2e.startPayload || {}) };
  base.programMode = cfg.programMode || 'grid';
  const locks = cfg.operatorLocks || [];
  if (locks.length) {
    base._resumeRuntime = {
      operatorMode: cfg.operatorMode !== false,
      operatorLocks: locks,
      programMode: cfg.programMode || 'grid',
      audioMode: 'auto',
    };
  }
  if (base._stickTemplateLocks) {
    base._stickTemplateLocks = true;
  }
  return base;
}

function runE2eLockdown(opts = {}) {
  const envPath = opts.envPath || path.join(ROOT, '.env');
  const env = checkEnvLockdown(envPath);
  const ecosystem = checkEcosystemLockdown();
  const ffmpeg = checkFfmpegDrawtext(envPath);
  const goLive = checkGoLiveConfig();
  const runtime = opts.skipRuntime ? { ok: true, skipped: true } : checkRuntimeMaster();

  const blocking = [];
  if (!env.ok) blocking.push('env lockdown drift');
  if (!ecosystem.ok) blocking.push('ecosystem lockdown drift');
  if (!ffmpeg.ok) blocking.push('ffmpeg missing drawtext');
  if (!goLive.ok) blocking.push('go-live config invalid');

  return {
    ok: blocking.length === 0,
    blocking,
    readyForGoLive: blocking.length === 0,
    env,
    ecosystem,
    ffmpeg,
    goLive,
    runtime,
    startPayload: buildLockedStartPayload(),
    profile: loadE2eProfile().name,
  };
}

module.exports = {
  E2E_PROFILE_PATH,
  loadE2eProfile,
  mergedEnvLock,
  checkEnvLockdown,
  checkEcosystemLockdown,
  checkFfmpegDrawtext,
  checkGoLiveConfig,
  checkRuntimeMaster,
  buildLockedStartPayload,
  runE2eLockdown,
};
