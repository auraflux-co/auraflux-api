#!/usr/bin/env node
'use strict';
/**
 * Offline smoke: pipeline_events emit + appendJobTimelineEvent + roo_bridge attachToBus.
 * Does not start the server or call external APIs. Uses a temp SQLite DB and appends
 * to logs/pipeline_events.jsonl and logs/job_run_timeline.jsonl (same paths as prod).
 *
 *   node scripts/offline_pipeline_observability_smoke.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmpDb = path.join(os.tmpdir(), `cwn-offline-smoke-${process.pid}-${Date.now()}.db`);
process.env.CWN_DB_PATH = tmpDb;

const logsDir = path.join(root, 'logs');
const PIPELINE_EVENTS = path.join(logsDir, 'pipeline_events.jsonl');
const JOB_TIMELINE = path.join(logsDir, 'job_run_timeline.jsonl');

const marker = `offline_smoke_${process.pid}_${Date.now()}`;

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function readFromOffset(p, offset) {
  try {
    const buf = fs.readFileSync(p);
    return buf.subarray(offset).toString('utf8');
  } catch {
    return '';
  }
}

function markerTimelineLines(s) {
  return s
    .split('\n')
    .filter(Boolean)
    .filter((ln) => ln.includes(`"jobId":"${marker}"`) || ln.includes(marker));
}

async function main() {
  fs.mkdirSync(logsDir, { recursive: true });
  const peStart = fileSize(PIPELINE_EVENTS);
  const tlStart = fileSize(JOB_TIMELINE);

  const db = require(path.join(root, 'lib', 'db'));
  db.closeDb();
  try {
    fs.unlinkSync(tmpDb);
  } catch (_e) {
    /* ignore */
  }
  db.initDb();

  const bus = require(path.join(root, 'lib', 'pipeline_events'));
  const { attachToBus } = require(path.join(root, 'lib', 'roo_bridge'));
  attachToBus(bus);

  db.saveJob(marker, { contentType: 'news', status: 'pending', createdAt: Date.now() });

  bus.emit('job:rollback', {
    jobId: marker,
    before: 'published',
    after: 'assembled',
    message: 'offline smoke rollback'
  });
  bus.emit('job:advance', {
    jobId: marker,
    from: 'script_ready',
    to: 'gate1_forced',
    message: 'offline smoke advance'
  });
  bus.emit('heygen:poll_tick', {
    jobId: marker,
    attempt: 2,
    allComplete: false,
    pending: 1,
    failed: 0,
    total: 3
  });
  bus.emit('heygen:poll_terminal', {
    jobId: marker,
    outcome: 'timeout',
    reason: 'offline_smoke'
  });
  bus.emit('publish:failed_validation', {
    jobId: marker,
    code: 'smoke_validation',
    message: 'intentional smoke'
  });
  bus.emit('publish:poll_tick', {
    jobId: marker,
    request_id: 'req_smoke',
    attempt: 1,
    maxAttempts: 10,
    uploadPostStatus: 'processing'
  });
  bus.emit('publish:poll_terminal', {
    jobId: marker,
    request_id: 'req_smoke',
    outcome: 'timeout',
    attempts: 10,
    maxAttempts: 10
  });
  bus.emit('publish:platform_done', {
    jobId: marker,
    platform: 'youtube',
    request_id: 'req_smoke',
    outcome: 'completed'
  });
  bus.emit('publish:all_done', {
    jobId: marker,
    anySuccess: true,
    allFailed: false,
    platforms: { youtube: { attempted: true, failed: false, hasJobId: true } }
  });
  bus.emit('pipeline:retry_attempt', {
    jobId: marker,
    gate: 5,
    stage: 'upload_post_youtube',
    attempt: 2,
    maxAttempts: 3
  });

  bus.appendJobTimelineEvent('heygen:poll_tick', {
    jobId: marker,
    attempt: 99,
    allComplete: false,
    pending: 1,
    failed: 0,
    total: 2
  });

  const peDelta = readFromOffset(PIPELINE_EVENTS, peStart);
  const tlDelta = readFromOffset(JOB_TIMELINE, tlStart);

  const requiredPeTypes = [
    'job:rollback',
    'job:advance',
    'heygen:poll_tick',
    'heygen:poll_terminal',
    'publish:failed_validation',
    'publish:poll_tick',
    'publish:poll_terminal',
    'publish:platform_done',
    'publish:all_done',
    'pipeline:retry_attempt'
  ];
  const missingPe = requiredPeTypes.filter((t) => !peDelta.includes(`"type":"${t}"`));
  if (missingPe.length) {
    console.error('FAIL: pipeline_events.jsonl missing types:', missingPe.join(', '));
    console.error('--- delta (tail) ---\n', peDelta.slice(-4000));
    process.exit(1);
  }

  const requiredTlTypes = [
    'job:rollback',
    'job:advance',
    'heygen:poll_tick',
    'heygen:poll_terminal',
    'publish:failed_validation',
    'publish:poll_tick',
    'publish:poll_terminal',
    'publish:platform_done',
    'publish:all_done',
    'pipeline:retry_attempt'
  ];
  const missingTl = requiredTlTypes.filter((t) => !tlDelta.includes(`"type":"${t}"`));
  if (missingTl.length) {
    console.error('FAIL: job_run_timeline.jsonl missing types:', missingTl.join(', '));
    console.error('--- delta (tail) ---\n', tlDelta.slice(-4000));
    process.exit(1);
  }

  // appendJobTimelineEvent should add one extra heygen:poll_tick (attempt 99) to timeline only
  const tlHeygenTicks = tlDelta.split('\n').filter((ln) => ln.includes('"type":"heygen:poll_tick"'));
  if (tlHeygenTicks.length < 2) {
    console.error('FAIL: expected >=2 heygen:poll_tick lines in timeline delta (emit + append)');
    process.exit(1);
  }
  const hasAppend99 = tlHeygenTicks.some((ln) => ln.includes('"attempt":99'));
  if (!hasAppend99) {
    console.error('FAIL: appendJobTimelineEvent line with attempt 99 not found');
    process.exit(1);
  }

  const markerLines = markerTimelineLines(tlDelta);
  if (markerLines.length < 10) {
    console.error('FAIL: expected multiple timeline rows for marker job');
    process.exit(1);
  }

  db.closeDb();
  try {
    fs.unlinkSync(tmpDb);
  } catch (_e) {
    /* ignore */
  }

  console.log('OK: offline_pipeline_observability_smoke — pipeline_events + timeline + appendJobTimelineEvent');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
