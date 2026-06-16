#!/usr/bin/env node
'use strict';
/**
 * CPD-1056 — Pipeline Parity regression matrix (run + log).
 *
 * Runs static hub checks, jest, API smoke, and optional post-deploy version probe.
 * Output: logs/cpd1056_regression_matrix.json
 *
 * Usage:
 *   node scripts/cpd1056_regression_matrix.js
 *   node scripts/cpd1056_regression_matrix.js --post-deploy --expect-commit=<sha>
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'logs', 'cpd1056_regression_matrix.json');

function loadDotenv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim();
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotenv();

const args = process.argv.slice(2);
const postDeploy = args.includes('--post-deploy');
const expectCommit = (args.find((a) => a.startsWith('--expect-commit=')) || '').split('=')[1] || null;
const apiBase = process.env.AURAFLUX_E2E_BASE || 'https://api.auraflux.co';

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
    ...opts,
  });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdout: (r.stdout || '').slice(-4000),
    stderr: (r.stderr || '').slice(-2000),
  };
}

function httpGet(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw.slice(0, 500); }
        resolve({ status: res.statusCode, body });
      });
    }).on('error', (e) => resolve({ status: 0, error: e.message }));
  });
}

const rows = [];

function row(id, layer, check, result, detail = '') {
  rows.push({ id, layer, check, result, detail, at: new Date().toISOString() });
  const mark = result === 'PASS' ? 'PASS' : result === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${id}  ${check}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`CPD-1056 regression matrix — ${postDeploy ? 'post-deploy' : 'pre-deploy'}`);
  console.log(`API: ${apiBase}\n`);

  const parity = run('node', ['scripts/pipeline_parity_review.js']);
  row('M-01', 'static', 'pipeline_parity_review.js', parity.ok ? 'PASS' : 'FAIL',
    parity.ok ? 'GREEN' : `exit ${parity.exitCode}`);

  const hub = run('node', ['scripts/hub_live_qa_render.js']);
  row('M-02', 'static', 'hub_live_qa_render.js', hub.ok ? 'PASS' : 'FAIL');

  const jest = run('npm', ['test', '--', '--testPathPatterns=job_spec_portals|approve_publish_readiness|clip_comp|r2_checkpoint|auto_production']);
  row('M-03', 'static', 'hub jest suite (26 tests)', jest.ok ? 'PASS' : 'FAIL');

  const smoke = run('node', ['scripts/smoke_test_render.js', apiBase]);
  row('M-04', 'api', `smoke_test_render ${apiBase}`, smoke.ok ? 'PASS' : 'FAIL');

  const health = await httpGet(`${apiBase}/health`);
  const version = health.body?.version || health.body?.serviceVersion || '?';
  const deployedAt = health.body?.deployedAt || health.body?.buildTime || null;
  const gitHash = health.body?.gitHash || health.body?.commit || null;
  row('M-05', 'api', 'GET /health version', health.status === 200 ? 'PASS' : 'FAIL',
    `v${version}${gitHash ? ` commit ${String(gitHash).slice(0, 8)}` : ''}`);

  if (postDeploy && expectCommit) {
    const match = gitHash && String(gitHash).startsWith(expectCommit.slice(0, 8));
    row('M-06', 'deploy', 'live commit matches deploy', match ? 'PASS' : 'FAIL',
      `expected ${expectCommit.slice(0, 8)}, got ${gitHash || 'unknown'}`);
  } else if (postDeploy) {
    row('M-06', 'deploy', 'live commit probe', gitHash ? 'PASS' : 'SKIP', gitHash || 'no gitHash in /health');
  }

  // Browse checklist — manual unless session log exists
  const browseLog = path.join(ROOT, 'logs', 'render_live_browse_session.json');
  if (fs.existsSync(browseLog)) {
    try {
      const b = JSON.parse(fs.readFileSync(browseLog, 'utf8'));
      for (const c of b.browseChecklist || []) {
        row(`M-B-${c.id}`, 'browse', c.path, c.status === 'PASS' ? 'PASS' : c.status === 'SKIP' ? 'SKIP' : c.status === 'BLOCKED' ? 'FAIL' : c.status, c.note || '');
      }
    } catch { /* ignore */ }
  }

  const hubJobLog = path.join(ROOT, 'logs', 'hub_staging_test_job.json');
  if (fs.existsSync(hubJobLog)) {
    try {
      const j = JSON.parse(fs.readFileSync(hubJobLog, 'utf8'));
      row('M-07', 'e2e', 'hub staging test job submit', j.jobId ? 'PASS' : 'FAIL', j.jobId || j.error || '');
      if (j.portals) row('M-08', 'e2e', 'resolveActivePortals on live job', j.portals.includes('portal4') ? 'PASS' : 'FAIL', j.portals);
      if (j.stagingPortal5 === false) row('M-09', 'e2e', 'staging portal5 inactive', 'PASS');
    } catch { /* ignore */ }
  }

  const failed = rows.filter((r) => r.result === 'FAIL').length;
  const report = {
    ticket: 'CPD-1056',
    epic: 'CPD-1037',
    phase: postDeploy ? 'post-deploy' : 'pre-deploy',
    runAt: new Date().toISOString(),
    apiBase,
    expectCommit,
    liveVersion: version,
    liveGitHash: gitHash,
    deployedAt,
    summary: { total: rows.length, pass: rows.filter((r) => r.result === 'PASS').length, skip: rows.filter((r) => r.result === 'SKIP').length, fail: failed },
    rows,
    verdict: failed === 0 ? 'PASS' : 'FAIL',
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(`Verdict: ${report.verdict} (${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.skip} skip)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
