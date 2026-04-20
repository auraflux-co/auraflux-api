'use strict';

/**
 * Test runner — runs the full Jest suite (all `*.test.js` files under `test/` per package.json jest.testMatch).
 * Run with: npm run test:all
 *
 * Do not execute individual test files with plain `node` — they rely on Jest globals (test, expect).
 */

const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const jestBin = require.resolve('jest/bin/jest');

try {
  execFileSync(process.execPath, [jestBin, '--runInBand'], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
} catch (e) {
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
