/**
 * Broadcast ops snapshot — dashboard control room (CPD-1026–1028)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const OK_FILE = path.join(REPO_ROOT, 'logs', 'start_24h_grid.ok');
const WAITER_LOG = path.join(REPO_ROOT, 'logs', 'start_24h_grid.log');

const ENV_KEYS = [
  'STREAM_SCHEDULER',
  'LIVE_GRID_WINDOW',
  'LIVE_TV_WINDOW',
  'LIVE_GRID_PROGRAM_MODE',
  'LIVE_GRID_PLATFORM_BENCH',
  'LIVE_GRID_AVATAR_PIP',
  'LIVE_GRID_PRIVACY',
  'LIVE_GRID_ALLOWLIST_ENFORCE',
  'LIVE_GRID_DUAL_BROADCAST',
];

function tailFile(filePath, maxLines = 40) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-maxLines);
}

function countActiveJobs(persistedJobs = {}) {
  const done = new Set(['published', 'done', 'completed', 'failed', 'killed', '']);
  return Object.values(persistedJobs).filter((j) => j?.stage && !done.has(j.stage)).length;
}

function probeProcess(pattern) {
  try {
    execSync(`pgrep -f ${JSON.stringify(pattern)}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function readEnvSnapshot() {
  const out = {};
  for (const key of ENV_KEYS) out[key] = process.env[key] ?? null;
  return out;
}

function buildOpsSnapshot({ persistedJobs, gridRunning, tvRunning, health } = {}) {
  const assemblyBusy = probeProcess('tmp/asm_');
  const rtmpPush = probeProcess('ffmpeg.*rtmp://');
  const activeJobs = countActiveJobs(persistedJobs);
  const gridLive = !!gridRunning;
  const tvLive = !!tvRunning;

  const blockers = [];
  if (gridLive) blockers.push('Live Grid is broadcasting — end stream before restart/deploy');
  if (assemblyBusy) blockers.push('Assembly ffmpeg running');
  if (activeJobs > 0) blockers.push(`${activeJobs} active pipeline job(s)`);
  if (rtmpPush && !gridLive && !tvLive) blockers.push('ffmpeg pushing RTMP (unknown source)');

  return {
    activeJobs,
    assemblyBusy,
    rtmpPush,
    gridLive,
    tvLive,
    safeToRestart: blockers.length === 0,
    blockers,
    waiter: {
      okFile: fs.existsSync(OK_FILE),
      okPath: OK_FILE,
      logTail: tailFile(WAITER_LOG),
    },
    env: readEnvSnapshot(),
    server: health ? {
      version: health.version,
      gitHash: health.gitHash,
      gitBranch: health.gitBranch,
      uptime: health.uptime,
    } : null,
  };
}

function listEligibleGridFiles() {
  const { listMp4Files, isAllowedFilePath } = require('../live_grid/file_sources');
  const roots = [
    path.join(REPO_ROOT, 'output'),
    path.join(REPO_ROOT, 'tmp', 'live_grid'),
    path.join(REPO_ROOT, 'assets'),
  ];
  const seen = new Set();
  const files = [];
  for (const dir of roots) {
    for (const { f, mtime } of listMp4Files(dir)) {
      if (!isAllowedFilePath(f) || seen.has(f)) continue;
      seen.add(f);
      const rel = path.relative(REPO_ROOT, f);
      files.push({
        path: rel,
        abs: f,
        name: path.basename(f),
        mtime,
        root: path.basename(path.dirname(f)) === 'live_grid' ? 'tmp/live_grid' : path.basename(dir),
      });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function arm24hMeasurement() {
  const envPath = path.join(REPO_ROOT, '.env');
  fs.mkdirSync(path.dirname(OK_FILE), { recursive: true });
  fs.writeFileSync(OK_FILE, `${new Date().toISOString()}\n`);

  if (fs.existsSync(envPath)) {
    let text = fs.readFileSync(envPath, 'utf8');
    if (/^LIVE_GRID_WINDOW=/m.test(text)) {
      text = text.replace(/^LIVE_GRID_WINDOW=.*/m, 'LIVE_GRID_WINDOW=00:00-24:00');
    } else {
      text += '\nLIVE_GRID_WINDOW=00:00-24:00\n';
    }
    if (!/^LIVE_GRID_PLATFORM_BENCH=/m.test(text)) text += 'LIVE_GRID_PLATFORM_BENCH=on\n';
    if (!/^LIVE_GRID_AVATAR_PIP=/m.test(text)) text += 'LIVE_GRID_AVATAR_PIP=auto\n';
    fs.writeFileSync(envPath, text);
  }

  return {
    okFile: true,
    window: '00:00-24:00',
    note: 'Waiter script will safe_restart + start grid when pipeline is idle',
  };
}

module.exports = {
  buildOpsSnapshot,
  listEligibleGridFiles,
  arm24hMeasurement,
  OK_FILE,
  WAITER_LOG,
};
