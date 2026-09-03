#!/usr/bin/env node
'use strict';

/**
 * weekly_disk_offload_to_r2.js
 *
 * Weekly laptop → R2 offload:
 *   1) Backup Cursor state.vscdb → R2, then reset local DB (when Cursor is quit)
 *   2) Archive finished C0 output media (reuses archive_local_media_to_r2.js --apply)
 *
 * Usage:
 *   node scripts/weekly_disk_offload_to_r2.js              # dry-run
 *   node scripts/weekly_disk_offload_to_r2.js --apply      # do work
 *   node scripts/weekly_disk_offload_to_r2.js --apply --quit-cursor
 *       # quit Cursor, backup+wipe DB, reopen (for launchd / manual)
 *
 * launchd: co.auraflux.weekly-disk-offload (Sunday 03:15 local)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const { uploadToR2, isR2Configured } = require('../lib/storage');

const APPLY = process.argv.includes('--apply');
const QUIT_CURSOR = process.argv.includes('--quit-cursor');
const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'weekly_disk_offload.jsonl');

const CURSOR_GS = path.join(
  os.homedir(),
  'Library/Application Support/Cursor/User/globalStorage'
);
const STATE_DB = path.join(CURSOR_GS, 'state.vscdb');

function logLine(obj) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(RUN_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`);
  console.log(JSON.stringify(obj));
}

function cursorRunning() {
  try {
    execSync('pgrep -x Cursor >/dev/null 2>&1');
    return true;
  } catch {
    return false;
  }
}

function quitCursor() {
  try {
    execSync(`osascript -e 'tell application "Cursor" to quit'`, { stdio: 'ignore' });
  } catch (_) { /* */ }
  try {
    execSync(`osascript -e 'quit app "Cursor"'`, { stdio: 'ignore' });
  } catch (_) { /* */ }
  for (let i = 0; i < 30; i++) {
    if (!cursorRunning()) return true;
    spawnSync('sleep', ['2']);
  }
  try {
    execSync('pkill -x Cursor', { stdio: 'ignore' });
  } catch (_) { /* */ }
  spawnSync('sleep', ['3']);
  return !cursorRunning();
}

function reopenCursor() {
  try {
    execSync('open -a Cursor', { stdio: 'ignore' });
  } catch (err) {
    logLine({ step: 'reopen_cursor', ok: false, error: String(err.message || err) });
  }
}

function sqliteBackup(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    execSync(`sqlite3 "${src}" ".backup '${dest}'"`, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    console.warn('[weekly-offload] sqlite3 .backup failed, falling back to cp:', err.message);
    fs.copyFileSync(src, dest);
  }
}

async function offloadCursorState() {
  if (!fs.existsSync(STATE_DB)) {
    return { skipped: true, reason: 'no_state_db' };
  }
  const st = fs.statSync(STATE_DB);
  const sizeGb = st.size / 1e9;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `local-archive/cursor-state/state-${stamp}.vscdb`;
  const tmpDir = path.join(ROOT, 'tmp', 'cursor-offload');
  const tmp = path.join(tmpDir, `state-${stamp}.vscdb`);

  if (!APPLY) {
    return { action: 'would_backup_and_reset', sizeGb: Number(sizeGb.toFixed(2)), key };
  }

  let uploadPath = STATE_DB;
  let usedTemp = false;

  if (cursorRunning()) {
    if (!QUIT_CURSOR) {
      // Hot backup while Cursor is open (does not reset local)
      console.log('[weekly-offload] Cursor running — sqlite backup then upload (no local reset without --quit-cursor)');
      sqliteBackup(STATE_DB, tmp);
      uploadPath = tmp;
      usedTemp = true;
      const driveUrl = await uploadToR2(uploadPath, path.basename(uploadPath), {
        folder: 'local-archive/cursor-state',
        key,
      });
      try { fs.unlinkSync(tmp); } catch (_) { /* */ }
      return {
        action: 'backed_up_only',
        reason: 'cursor_still_running_pass_quit_cursor_to_reset',
        driveUrl,
        key,
        sizeGb: Number(sizeGb.toFixed(2)),
      };
    }

    console.log('[weekly-offload] quitting Cursor before upload+reset…');
    const ok = quitCursor();
    if (!ok) {
      return { action: 'aborted', reason: 'quit_cursor_failed', sizeGb: Number(sizeGb.toFixed(2)) };
    }
  }

  // Cursor is quit — upload the live file (no 2× disk copy), then delete local
  console.log(`[weekly-offload] uploading ${sizeGb.toFixed(2)} GB to R2 key=${key}`);
  const driveUrl = await uploadToR2(uploadPath, path.basename(uploadPath), {
    folder: 'local-archive/cursor-state',
    key,
  });

  for (const f of ['state.vscdb', 'state.vscdb-wal', 'state.vscdb-shm', 'state.vscdb.backup']) {
    const p = path.join(CURSOR_GS, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const worker = path.join(CURSOR_GS, 'anysphere.cursor-agent-worker');
  if (fs.existsSync(worker)) fs.rmSync(worker, { recursive: true, force: true });
  for (const f of ['conversation-search.db', 'conversation-search.db-wal', 'conversation-search.db-shm']) {
    const p = path.join(CURSOR_GS, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (usedTemp) {
    try { fs.unlinkSync(tmp); } catch (_) { /* */ }
  }

  if (QUIT_CURSOR) reopenCursor();

  return {
    action: 'backed_up_and_reset',
    driveUrl,
    key,
    sizeGb: Number(sizeGb.toFixed(2)),
  };
}

function runCwnMediaArchive() {
  const script = path.join(__dirname, 'archive_local_media_to_r2.js');
  const args = APPLY ? ['--apply'] : [];
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdoutTail: (r.stdout || '').trim().split('\n').slice(-8).join('\n'),
    stderrTail: (r.stderr || '').trim().split('\n').slice(-5).join('\n'),
  };
}

async function main() {
  console.log(`[weekly-offload] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} quitCursor=${QUIT_CURSOR}`);
  if (!isR2Configured()) {
    console.error('[weekly-offload] R2 not configured');
    process.exit(1);
  }

  const cursor = await offloadCursorState();
  logLine({ step: 'cursor', ...cursor });

  const media = runCwnMediaArchive();
  logLine({ step: 'cwn_media', ...media });

  console.log('[weekly-offload] done');
}

main().catch((err) => {
  logLine({ step: 'fatal', error: String(err.stack || err) });
  console.error(err);
  process.exit(1);
});
