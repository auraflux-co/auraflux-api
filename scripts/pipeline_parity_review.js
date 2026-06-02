#!/usr/bin/env node
'use strict';

/**
 * pipeline_parity_review.js — AuraFlux Pipeline Parity & Codebase Health Review
 *
 * Compares the three dispatch paths (developer_api, jobs_c1/dashboard, BullMQ worker)
 * and checks that each implements the same pipeline contract.
 *
 * Run:  node scripts/pipeline_parity_review.js
 * Output: logs/pipeline_parity_review_<date>.md
 *
 * What it checks:
 *   1. Assembly wired after portal1 on all paths
 *   2. clipSpec forwarded from payload into jobSpec
 *   3. productionProfile resolved on all paths
 *   4. portal3b mismatch_fixable override present
 *   5. format/captions/effects/audioOpts wired from payload
 *   6. Feature gates present on all portal extension workers
 *   7. Route mounting — every lib/routes/*.js required in server.js
 *   8. Env vars — every process.env.X in lib/ appears in .env.example
 *   9. Test coverage — every lib/services/*.js has a matching test/
 *  10. Sentry alerts on hard-fail paths
 */

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'logs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function pass(msg)    { return { status: '✅', msg }; }
function fail(msg)    { return { status: '❌', msg }; }
function warn(msg)    { return { status: '⚠️ ', msg }; }

// ── Checks ────────────────────────────────────────────────────────────────────

function checkAssemblyWired() {
  const results = [];
  const paths = {
    'developer_api.js':   readFile('lib/routes/developer_api.js'),
    'jobs_c1.js':         readFile('lib/routes/jobs_c1.js'),
    'queue/worker.js':    readFile('lib/queue/worker.js'),
  };

  for (const [file, src] of Object.entries(paths)) {
    if (!src) { results.push(fail(`${file} not found`)); continue; }
    const hasAssembly = src.includes('assembleForJob') || src.includes('pipeline_assembly') || src.includes('runAssemblyAndPostProcess');
    results.push(hasAssembly
      ? pass(`${file}: assembly wired`)
      : fail(`${file}: assembly NOT called — jobs will have no video output`));
  }
  return results;
}

function checkClipSpecForwarded() {
  const src = readFile('lib/routes/jobs_c1.js');
  if (!src) return [fail('jobs_c1.js not found')];
  return [src.includes('clipSpec')
    ? pass('jobs_c1.js: clipSpec forwarded into jobSpec')
    : fail('jobs_c1.js: clipSpec NOT forwarded — trim points silently dropped')];
}

function checkProductionProfileResolved() {
  const files = {
    'jobs_c1.js':      readFile('lib/routes/jobs_c1.js'),
    'queue/worker.js': readFile('lib/queue/worker.js'),
  };
  const results = [];
  for (const [file, src] of Object.entries(files)) {
    if (!src) { results.push(fail(`${file} not found`)); continue; }
    results.push(src.includes('resolveProductionProfile') || src.includes('productionProfile')
      ? pass(`${file}: productionProfile resolved`)
      : warn(`${file}: productionProfile may not be resolved — check manually`));
  }
  return results;
}

function checkPortal3bOverride() {
  const src = readFile('lib/routes/jobs_c1.js') || readFile('lib/services/pipeline_assembly.js');
  if (!src) return [warn('jobs_c1.js and pipeline_assembly.js not found — check portal3b override manually')];
  return [src.includes('mismatch_fixable') || src.includes('isPass')
    ? pass('portal3b mismatch_fixable override present')
    : warn('portal3b mismatch_fixable override not detected — verify manually')];
}

function checkEffectsWired() {
  const src = readFile('lib/routes/jobs_c1.js');
  if (!src) return [fail('jobs_c1.js not found')];
  const fields = ['effects', 'captions', 'audioOpts', 'format'];
  return fields.map(f => src.includes(f)
    ? pass(`jobs_c1.js: '${f}' wired from payload`)
    : warn(`jobs_c1.js: '${f}' may not be wired — verify manually`));
}

function checkFeatureGates() {
  const extDir = path.join(ROOT, 'lib', 'portals');
  if (!fs.existsSync(extDir)) return [warn('lib/portals/ not found')];
  const extFiles = fs.readdirSync(extDir).filter(f => f.endsWith('_ext.js'));
  return extFiles.map(f => {
    const src = fs.readFileSync(path.join(extDir, f), 'utf8');
    return src.includes('isFeatureEnabled')
      ? pass(`${f}: isFeatureEnabled gate present`)
      : fail(`${f}: isFeatureEnabled gate MISSING — portal extension runs for all plans`);
  });
}

function checkRouteMounting() {
  const routeDir = path.join(ROOT, 'lib', 'routes');
  const serverSrc = readFile('server.js');
  if (!serverSrc) return [fail('server.js not found')];
  if (!fs.existsSync(routeDir)) return [warn('lib/routes/ not found')];

  const routeFiles = fs.readdirSync(routeDir).filter(f => f.endsWith('.js'));
  return routeFiles.map(f => {
    const name = f.replace('.js', '');
    const required = serverSrc.includes(`routes/${name}`) || serverSrc.includes(`'${name}'`) || serverSrc.includes(`"${name}"`);
    return required
      ? pass(`lib/routes/${f}: mounted in server.js`)
      : warn(`lib/routes/${f}: NOT found in server.js — may be unmounted`);
  });
}

function checkEnvVars() {
  const exampleSrc = readFile('.env.example') || '';
  const libDir = path.join(ROOT, 'lib');
  if (!fs.existsSync(libDir)) return [warn('lib/ not found')];

  const envVars = new Set();
  function scanDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { scanDir(path.join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      const matches = src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g);
      for (const m of matches) envVars.add(m[1]);
    }
  }
  scanDir(libDir);

  const results = [];
  for (const v of [...envVars].sort()) {
    results.push(exampleSrc.includes(v)
      ? pass(`${v}: documented in .env.example`)
      : fail(`${v}: NOT in .env.example — undocumented env var`));
  }
  return results;
}

function checkTestCoverage() {
  const servicesDir = path.join(ROOT, 'lib', 'services');
  const testDir = path.join(ROOT, 'test');
  if (!fs.existsSync(servicesDir)) return [warn('lib/services/ not found')];

  const services = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
  return services.map(f => {
    const name = f.replace('.js', '');
    const hasTest = fs.existsSync(path.join(testDir, `${name}.test.js`));
    return hasTest
      ? pass(`lib/services/${f}: test/${name}.test.js exists`)
      : warn(`lib/services/${f}: no matching test file`);
  });
}

function checkSentryOnHardFail() {
  const assemblyFiles = [
    'lib/services/pipeline_assembly.js',
    'lib/routes/jobs_c1.js',
    'lib/queue/worker.js',
  ];
  return assemblyFiles.map(f => {
    const src = readFile(f);
    if (!src) return warn(`${f}: not found`);
    const hasSentry = src.includes('Sentry') || src.includes('captureException') || src.includes('captureMessage');
    return hasSentry
      ? pass(`${f}: Sentry alert on failure`)
      : warn(`${f}: no Sentry call detected — failures may be silent`);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function runReview() {
  const date = new Date().toISOString().slice(0, 10);
  const sections = [
    { title: '1. Assembly Wired on All Dispatch Paths', results: checkAssemblyWired() },
    { title: '2. clipSpec Forwarded into jobSpec', results: checkClipSpecForwarded() },
    { title: '3. productionProfile Resolved', results: checkProductionProfileResolved() },
    { title: '4. portal3b mismatch_fixable Override', results: checkPortal3bOverride() },
    { title: '5. Effects / Captions / Format / AudioOpts Wired', results: checkEffectsWired() },
    { title: '6. Feature Gates on Portal Extension Workers', results: checkFeatureGates() },
    { title: '7. Route Mounting in server.js', results: checkRouteMounting() },
    { title: '8. Env Vars Documented in .env.example', results: checkEnvVars() },
    { title: '9. Test Coverage for lib/services/', results: checkTestCoverage() },
    { title: '10. Sentry Alerts on Hard-Fail Paths', results: checkSentryOnHardFail() },
  ];

  let failures = 0, warnings = 0, passes = 0;
  const lines = [
    `# AuraFlux Pipeline Parity & Codebase Health Review`,
    `**Date:** ${date}`,
    `**Script:** scripts/pipeline_parity_review.js`,
    '',
  ];

  for (const section of sections) {
    lines.push(`## ${section.title}`);
    for (const r of section.results) {
      lines.push(`- ${r.status} ${r.msg}`);
      if (r.status.includes('❌')) failures++;
      else if (r.status.includes('⚠️')) warnings++;
      else passes++;
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`## Summary`);
  lines.push(`- ✅ Passed: ${passes}`);
  lines.push(`- ⚠️  Warnings: ${warnings}`);
  lines.push(`- ❌ Failed: ${failures}`);
  lines.push('');
  if (failures > 0) {
    lines.push('**ACTION REQUIRED:** One or more critical checks failed. Create a Jira ticket for each ❌ before next deploy.');
  } else if (warnings > 0) {
    lines.push('**Review warnings manually.** No critical failures detected.');
  } else {
    lines.push('**All checks passed.** Codebase is healthy.');
  }

  const outPath = path.join(OUT_DIR, `pipeline_parity_review_${date}.md`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));

  console.log(lines.join('\n'));
  console.log(`\nReport written → ${outPath}`);
  return { failures, warnings, passes };
}

if (require.main === module) {
  const { failures } = runReview();
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { runReview };
