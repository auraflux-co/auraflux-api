'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `cwn-canonical-${process.pid}-${Date.now()}.db`);
process.env.CWN_DB_PATH = tmpDb;

const db = require('../lib/db');

function resetTables() {
  const d = db.getDb();
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('DELETE FROM gate_results');
  d.exec('DELETE FROM job_metrics');
  d.exec('DELETE FROM gate_fixes');
  d.exec('DELETE FROM why_ledger');
  d.exec('DELETE FROM heygen_renders');
  d.exec('DELETE FROM publish_results');
  d.exec('DELETE FROM assembly_jobs');
  d.exec('DELETE FROM jobs');
  d.exec('PRAGMA foreign_keys = ON');
}

const TIMELINE_LOG = path.join(__dirname, '..', 'logs', 'job_run_timeline.jsonl');

afterAll(() => {
  db.closeDb();
  try {
    fs.unlinkSync(tmpDb);
  } catch (_e) { /* ignore */ }
  try {
    fs.unlinkSync(TIMELINE_LOG);
  } catch (_e) { /* ignore */ }
});

describe('db canonical job id spine', () => {
  beforeEach(() => {
    db.closeDb();
    try {
      fs.unlinkSync(tmpDb);
    } catch (_e) { /* ignore */ }
    db.initDb();
    resetTables();
  });

  test('resolveCanonicalJobId follows script_job_id from semantic row', () => {
    const now = Date.now();
    db.saveJob('c0_sem_test', { contentType: 'news', status: 'pending', createdAt: now });
    db.saveJob('script_xyz_test', { contentType: 'news', status: 'pending', createdAt: now });
    db.getDb().prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run('script_xyz_test', 'c0_sem_test');

    expect(db.resolveCanonicalJobId('c0_sem_test')).toBe('script_xyz_test');
    expect(db.resolveCanonicalJobId('script_xyz_test')).toBe('script_xyz_test');
  });

  test('saveGateResult writes gate_results under canonical id', () => {
    const now = Date.now();
    db.saveJob('c0_sem2', { contentType: 'news', status: 'pending', createdAt: now });
    db.saveJob('script_link2', { contentType: 'news', status: 'pending', createdAt: now });
    db.getDb().prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run('script_link2', 'c0_sem2');

    db.saveGateResult('c0_sem2', 'gate1', { passed: true, score: 7 });
    const rows = db.getDb().prepare('SELECT job_id, gate FROM gate_results').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe('script_link2');
    expect(rows[0].gate).toBe('gate1');
  });

  test('getGateResults merges rows across linked ids; last row wins per gate', () => {
    const now = Date.now();
    db.saveJob('c0_merge', { contentType: 'news', status: 'pending', createdAt: now });
    db.saveJob('script_merge', { contentType: 'news', status: 'pending', createdAt: now });
    db.getDb().prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run('script_merge', 'c0_merge');

    const ts = Date.now();
    db.getDb().prepare(`
      INSERT INTO gate_results (job_id, gate, passed, score, result, created_at)
      VALUES ('c0_merge', 'gate0', 1, 1, ?, ?)
    `).run(JSON.stringify({ passed: true, score: 1, jobId: 'c0_merge' }), ts);
    db.getDb().prepare(`
      INSERT INTO gate_results (job_id, gate, passed, score, result, created_at)
      VALUES ('script_merge', 'gate0', 1, 9, ?, ?)
    `).run(JSON.stringify({ passed: true, score: 9, jobId: 'script_merge' }), ts + 1);

    const gr = db.getGateResults('c0_merge');
    expect(gr.gate0.score).toBe(9);
  });

  test('getPrimaryJobSpecRowId prefers script row with job_spec', () => {
    const now = Date.now();
    db.saveJob('c0_spec', { contentType: 'news', status: 'pending', createdAt: now });
    db.saveJob('script_spec', { contentType: 'news', status: 'pending', createdAt: now });
    db.getDb().prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run('script_spec', 'c0_spec');
    const specObj = { jobId: 'c0_spec', scriptJobId: 'script_spec', customerId: 'c0', state: { gateResults: {} } };
    db.getDb().prepare('UPDATE jobs SET job_spec = ? WHERE id = ?').run(JSON.stringify(specObj), 'script_spec');

    expect(db.getPrimaryJobSpecRowId('script_spec')).toBe('script_spec');
    expect(db.getPrimaryJobSpecRowId('c0_spec')).toBe('script_spec');
  });
});

describe('pipeline_events emit + job_run_timeline', () => {
  const pipelineBus = require('../lib/pipeline_events');

  beforeEach(() => {
    try {
      fs.unlinkSync(TIMELINE_LOG);
    } catch (_e) { /* ignore */ }
    db.closeDb();
    try {
      fs.unlinkSync(tmpDb);
    } catch (_e) { /* ignore */ }
    db.initDb();
    resetTables();
  });

  test('emit enriches canonicalJobId and appends job_run_timeline.jsonl', () => {
    const now = Date.now();
    db.saveJob('c0_tl', { contentType: 'news', status: 'pending', createdAt: now });
    db.saveJob('script_tl', { contentType: 'news', status: 'pending', createdAt: now });
    db.getDb().prepare('UPDATE jobs SET script_job_id = ? WHERE id = ?').run('script_tl', 'c0_tl');
    pipelineBus.emit('gate:pass', { jobId: 'c0_tl', gate: 'gate1', score: 90, outcome: 'pass' });
    expect(fs.existsSync(TIMELINE_LOG)).toBe(true);
    const line = fs.readFileSync(TIMELINE_LOG, 'utf8').trim().split('\n').filter(Boolean).pop();
    const row = JSON.parse(line);
    expect(row.type).toBe('gate:pass');
    expect(row.canonicalJobId).toBe('script_tl');
    expect(row.jobId).toBe('c0_tl');
  });

  test('timeline file omits large segmentUrls (listeners still receive full emit elsewhere)', () => {
    const now = Date.now();
    db.saveJob('solo_tl', { contentType: 'news', status: 'pending', createdAt: now });
    const urls = Array.from({ length: 40 }, (_, i) => `https://example.com/seg${i}.mp4`);
    pipelineBus.emit('heygen:all_complete', {
      jobId: 'solo_tl',
      contentType: 'news',
      segmentUrls: urls,
      card: { x: 1 },
      segmentData: Array.from({ length: 10 }, (_, i) => ({ i }))
    });
    const line = fs.readFileSync(TIMELINE_LOG, 'utf8').trim().split('\n').filter(Boolean).pop();
    const row = JSON.parse(line);
    expect(row.type).toBe('heygen:all_complete');
    expect(row.segmentUrls).toEqual({ count: 40, _omitted: true });
    expect(row.segmentData).toMatchObject({ count: 10, _omitted: true });
    expect(row.card).toEqual({ _omitted: true });
  });

  test('getJobSpec includes observability paths', () => {
    const now = Date.now();
    db.saveJob('obs_spec', { contentType: 'news', status: 'pending', createdAt: now });
    const specObj = { jobId: 'obs_spec', customerId: 'c0', state: { gateResults: {} } };
    db.getDb().prepare('UPDATE jobs SET job_spec = ? WHERE id = ?').run(JSON.stringify(specObj), 'obs_spec');
    const { getJobSpec } = require('../lib/job_spec');
    const got = getJobSpec('obs_spec');
    expect(got.observability.jobRunTimeline).toBe('logs/job_run_timeline.jsonl');
    expect(got.observability.pipelineEventsLog).toBe('logs/pipeline_events.jsonl');
    expect(got.observability.canonicalJobId).toBe('obs_spec');
  });
});
