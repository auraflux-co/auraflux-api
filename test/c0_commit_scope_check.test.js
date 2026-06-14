'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '../scripts/c0_commit_scope_check.sh');

function run(staged, env = {}) {
  return execFileSync('bash', [SCRIPT, staged], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runStatus(staged, env = {}) {
  try {
    run(staged, env);
    return 0;
  } catch (e) {
    return e.status || 1;
  }
}

describe('c0_commit_scope_check', () => {
  it('passes for C0-native staged paths', () => {
    assert.equal(runStatus('lib/live_grid/manager.js\n'), 0);
    assert.equal(runStatus('cwn_production.html\nlib/live_grid/manager.js\n'), 0);
  });

  it('blocks app/ paths', () => {
    assert.equal(runStatus('app/page.tsx\n'), 1);
  });

  it('blocks lib/portals without portable override', () => {
    assert.equal(runStatus('lib/portals/portal5.js\n'), 1);
    assert.equal(runStatus('lib/portals/portal5.js\n', { C0_PORTABLE: '1' }), 0);
  });

  it('passes STATUS.md-only commits', () => {
    assert.equal(runStatus('STATUS.md\n'), 0);
  });
});
