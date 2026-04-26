#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.CWN_DB_PATH
  ? path.resolve(process.env.CWN_DB_PATH)
  : path.join(ROOT, 'data', 'cwn.db');

const GATE_MODULES = {
  gate0: require(path.join(ROOT, 'lib', 'gates', 'gate0')),
  gate1: require(path.join(ROOT, 'lib', 'gates', 'gate1')),
  gate2: require(path.join(ROOT, 'lib', 'gates', 'gate2')),
  gate3a: require(path.join(ROOT, 'lib', 'gates', 'gate3a')),
  gate3b: require(path.join(ROOT, 'lib', 'gates', 'gate3b')),
  gate4: require(path.join(ROOT, 'lib', 'gates', 'gate4')),
  gate5: require(path.join(ROOT, 'lib', 'gates', 'gate5'))
};

const {
  buildGateStatusSnapshot,
  validateGateContractConsistency
} = require(path.join(ROOT, 'lib', 'job_spec_contracts'));

function loadLatestJobSpecs(limit = 100) {
  if (!fs.existsSync(DB_PATH)) return [];
  const db = new Database(DB_PATH, { readonly: true });
  let rows = db.prepare(`
    SELECT id, job_spec
    FROM jobs
    WHERE stage IN ('script_ready', 'all_sent', 'awaiting_manual_segments', 'assembling')
      AND job_spec IS NOT NULL
      AND TRIM(CAST(job_spec AS TEXT)) != ''
      AND CAST(job_spec AS TEXT) != 'null'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
  if (rows.length === 0) {
    rows = db.prepare(`
    SELECT id, job_spec
    FROM jobs
    WHERE job_spec IS NOT NULL
      AND TRIM(CAST(job_spec AS TEXT)) != ''
      AND CAST(job_spec AS TEXT) != 'null'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
  }
  db.close();

  const specs = [];
  for (const row of rows) {
    try {
      const spec = JSON.parse(row.job_spec);
      if (spec && typeof spec === 'object') specs.push(spec);
    } catch (_e) {}
  }
  return specs;
}

function sampleSpec(specs) {
  if (specs.length > 0) return specs[0];
  return {
    jobId: 'sample',
    customerId: 'c0',
    templateId: 'long-form',
    contentType: 'nba',
    order: {
      formType: 'long',
      contentType: 'nba',
      output: { aspectRatio: '16:9', format: '16:9', resolution: '1920x1080' },
      inputs: { items: [{ title: 'Sample item' }] }
    },
    designSpec: {
      voice: { lockedIntro: 'Sample intro', lockedOutro: 'Goodnight and good luck.' },
      sceneStructure: {
        sceneHeaders: ['INTRO', 'GAME1_INTRO', 'GAME1_NARRATION', 'GAME1_RECAP', 'GAME1_REACTION', 'OUTRO'],
        expectedClipCount: 1
      },
      qaThresholds: {}
    },
    deliverySpec: { platforms: ['youtube'] },
    state: { gateResults: {}, savedOutputs: {} }
  };
}

function runGateModuleContractChecks(spec) {
  const issues = [];
  const warnings = [];

  for (const [gate, mod] of Object.entries(GATE_MODULES)) {
    for (const fn of ['canProduce', 'commit', 'run']) {
      if (typeof mod[fn] !== 'function') {
        issues.push(`${gate} missing ${fn}()`);
      }
    }
    if (typeof mod.commit === 'function') {
      try {
        const out = mod.commit(spec);
        const summary = out && (out.committed || out.summary);
        if (!summary || !String(summary).trim()) {
          warnings.push(`${gate} commit() returned empty summary`);
        }
      } catch (e) {
        warnings.push(`${gate} commit() threw on sample spec: ${e.message}`);
      }
    }
    if (typeof mod.canProduce === 'function') {
      try {
        const out = mod.canProduce(spec);
        if (!out || typeof out.ready !== 'boolean') {
          issues.push(`${gate} canProduce() did not return { ready: boolean }`);
        }
      } catch (e) {
        warnings.push(`${gate} canProduce() threw on sample spec: ${e.message}`);
      }
    }
  }

  return { issues, warnings };
}

function main() {
  const specs = loadLatestJobSpecs(120);
  const spec = sampleSpec(specs);

  const gateModuleChecks = runGateModuleContractChecks(spec);
  const contractChecks = specs.map((s) => ({
    jobId: s.jobId || 'unknown',
    check: validateGateContractConsistency(s),
    status: buildGateStatusSnapshot(s)
  }));

  const legacyMissingContracts = contractChecks.filter((r) =>
    !r.check.ok &&
    Array.isArray(r.check.issues) &&
    r.check.issues.length === 1 &&
    r.check.issues[0] === 'state.gateContracts.gates missing'
  );
  const failingContracts = contractChecks.filter((r) =>
    !legacyMissingContracts.some((l) => l.jobId === r.jobId) && !r.check.ok
  );
  const warnings = [
    ...gateModuleChecks.warnings,
    ...legacyMissingContracts.map((r) => `${r.jobId}: legacy job missing gateContracts (non-blocking)`),
    ...contractChecks.flatMap((r) => (r.check.warnings || []).map((w) => `${r.jobId}: ${w}`))
  ];
  const issues = [
    ...gateModuleChecks.issues,
    ...failingContracts.flatMap((r) => (r.check.issues || []).map((i) => `${r.jobId}: ${i}`))
  ];

  console.log('[gate-contract-check] specs scanned:', specs.length);
  console.log('[gate-contract-check] failing specs:', failingContracts.length);
  if (warnings.length) {
    console.log('[gate-contract-check] warnings:');
    warnings.slice(0, 80).forEach((w) => console.log('  -', w));
  }
  if (issues.length) {
    console.log('[gate-contract-check] issues:');
    issues.slice(0, 120).forEach((i) => console.log('  -', i));
  } else {
    console.log('[gate-contract-check] PASS: no blocking contract conflicts found');
  }

  process.exit(issues.length ? 1 : 0);
}

main();

