'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { upsertEnvFile } = require('../lib/env_persist');

describe('upsertEnvFile', () => {
  let tmpDir;
  let envPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-persist-'));
    envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, 'FOO=1\nLIVE_GRID_BROADCAST_ID=old\nBAR=2\n');
    delete process.env._ENV_PERSIST_TEST;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('updates existing keys in place', () => {
    upsertEnvFile(envPath, { LIVE_GRID_BROADCAST_ID: 'newId123' }, { syncProcessEnv: false });
    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).toContain('LIVE_GRID_BROADCAST_ID=newId123');
    expect(text).not.toContain('old');
    expect(text).toContain('FOO=1');
    expect(text).toContain('BAR=2');
  });

  test('appends new keys', () => {
    upsertEnvFile(envPath, { LIVE_GRID_WATCH_URL: 'https://youtube.com/live/x' }, { syncProcessEnv: false });
    expect(fs.readFileSync(envPath, 'utf8')).toContain('LIVE_GRID_WATCH_URL=https://youtube.com/live/x');
  });
});
