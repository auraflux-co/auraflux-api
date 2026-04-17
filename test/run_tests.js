'use strict';

/**
 * Test runner — executes all test suites in order.
 * Run with: npm run test:all
 */

const { execFileSync } = require('child_process');

const suites = [
  { name: 'FFmpeg Utilities',      module: './ffmpeg_utils.test' },
  { name: 'Pipeline QA',           module: './pipeline_qa.test' },
  { name: 'Pipeline Adversarial',  module: './pipeline_adversarial.test' },
];

let allPassed = true;

for (const suite of suites) {
  console.log(`\n── ${suite.name} ─────────────────────────────────────`);
  try {
    execFileSync(process.execPath, [require.resolve(suite.module)], { stdio: 'inherit' });
  } catch {
    allPassed = false;
  }
}

process.exit(allPassed ? 0 : 1);
