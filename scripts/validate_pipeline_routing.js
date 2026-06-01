#!/usr/bin/env node
'use strict';
/**
 * validate_pipeline_routing.js
 *
 * Pre-commit routing validator. Checks that known template paths resolve
 * correctly through the pipeline without running a full job.
 *
 * Exits 0 if all checks pass, non-zero if any check fails.
 *
 * Run manually: node scripts/validate_pipeline_routing.js [--verbose]
 *
 * CPD-475: Initial version — structural checks only.
 * When lib/pipeline_routing.js is extracted, import it here for
 * symbol-level routing assertions.
 */

const fs   = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');
const ROOT    = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    const result = fn();
    if (result !== false) {
      if (VERBOSE) console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.error(`  ❌ ${label}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ ${label} — ${err.message}`);
    failed++;
  }
}

function fileExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// ── 1. Required pipeline files present ───────────────────────────────────────
check('assembly_service.js exists',       () => fileExists('lib/assembly_service.js'));
check('assembly_postprocess.js exists',   () => fileExists('lib/assembly_postprocess.js'));
check('developer_api.js exists',          () => fileExists('lib/routes/developer_api.js'));
check('job_grader.js exists',             () => fileExists('lib/services/job_grader.js'));

// ── 2. Assembly semaphore is present (CPD-479) ────────────────────────────────
check('assembly semaphore defined', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/assembly_service.js'), 'utf8');
  return src.includes('_withAssemblySemaphore') && src.includes('_assemblySemaphoreHeld');
});

// ── 3. Chrome pass accepts needsPortraitReframe (CPD-479) ────────────────────
check('_applyChrome accepts needsPortraitReframe', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/assembly_service.js'), 'utf8');
  return src.includes('needsPortraitReframe');
});

// ── 4. -threads flag is present in assembly (CPD-479) ────────────────────────
check('-threads 2 present in assembly_service', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/assembly_service.js'), 'utf8');
  return src.includes("'-threads', '2'");
});
check('-threads 2 present in assembly_postprocess', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/assembly_postprocess.js'), 'utf8');
  return src.includes("'-threads', '2'");
});

// ── 5. developer_api.js passes needsPortraitReframe to all chrome call sites ─
check('developer_api.js passes needsPortraitReframe (3 call sites)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/routes/developer_api.js'), 'utf8');
  const matches = (src.match(/needsPortraitReframe/g) || []).length;
  return matches >= 3;
});

// ── 6. Known-good template IDs referenced in run_11 script ──────────────────
const RUN11 = path.join(ROOT, 'scripts/run_11_template_matrix.py');
if (fileExists('scripts/run_11_template_matrix.py')) {
  const py = fs.readFileSync(RUN11, 'utf8');
  const expectedTemplates = [
    'tiktok_clutch',
    'youtube_deep_dive',
    'reaction_cut',
    'irl_story_time',
    'montage_hype_reel',
    'quick_guide',
  ];
  for (const tpl of expectedTemplates) {
    check(`template "${tpl}" present in run_11`, () => py.includes(tpl));
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
if (VERBOSE || failed > 0) {
  console.log(`\n  Pipeline routing: ${passed}/${total} checks passed`);
}
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
