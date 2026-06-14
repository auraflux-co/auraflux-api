#!/usr/bin/env node
'use strict';

/**
 * backup_to_r2.js — Nightly backup of SQLite DB and JSON state files to Cloudflare R2.
 *
 * Runs as a Render cron job at 03:00 UTC daily.
 * Can also be run manually: node scripts/backup_to_r2.js
 *
 * What it backs up:
 *   - data/cwn.db         → SQLite hot backup (consistent snapshot via VACUUM INTO)
 *   - data/*.json         → Runtime state files (jobs, counters, upload status, etc.)
 *
 * R2 layout:
 *   auraflux-backups/sqlite/cwn-YYYY-MM-DD.db.gz
 *   auraflux-backups/data/cwn-data-YYYY-MM-DD.tar.gz
 *
 * Retention: R2 lifecycle rule (set in Cloudflare dashboard) auto-deletes after 30 days.
 *
 * Required env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const zlib    = require('zlib');
const { execSync } = require('child_process');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { backupRenderEnvVars } = require('./backup_render_env');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_PATH  = path.join(DATA_DIR, 'cwn.db');

// ── Config ────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BACKUP_BUCKET'];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[backup] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function makeR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function datestamp() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function gzipFile(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), path.basename(inputPath) + '.gz');
    const src  = fs.createReadStream(inputPath);
    const dest = fs.createWriteStream(outPath);
    const gz   = zlib.createGzip({ level: 6 });
    src.pipe(gz).pipe(dest);
    dest.on('finish', () => resolve(outPath));
    dest.on('error', reject);
    src.on('error', reject);
  });
}

function tarGzFiles(files, outputPath) {
  // Filter to only existing files
  const existing = files.filter((f) => fs.existsSync(f));
  if (!existing.length) throw new Error('No files to archive');
  const fileList = existing.map((f) => path.relative(ROOT_DIR, f)).join(' ');
  execSync(`tar -czf ${outputPath} -C ${ROOT_DIR} ${fileList}`, { stdio: 'pipe' });
  return outputPath;
}

async function uploadToR2(client, bucket, key, filePath) {
  const body = fs.readFileSync(filePath);
  const cmd  = new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        body,
    ContentType: 'application/gzip',
    Metadata: {
      'backup-date':   datestamp(),
      'backup-source': 'auraflux-api',
      'file-size':     String(body.length),
    },
  });
  await client.send(cmd);
  const sizeMB = (body.length / 1024 / 1024).toFixed(2);
  console.log(`[backup] Uploaded s3://${bucket}/${key} (${sizeMB} MB)`);
}

async function makeSQLiteBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.warn('[backup] cwn.db not found — skipping SQLite backup');
    return null;
  }
  // VACUUM INTO creates a clean consistent copy (no WAL journal needed)
  const tmpDb = path.join(os.tmpdir(), `cwn-backup-${datestamp()}.db`);
  try {
    execSync(`sqlite3 ${DB_PATH} "VACUUM INTO '${tmpDb}'"`, { stdio: 'pipe' });
  } catch {
    // Fallback: plain file copy (safe if WAL is not active)
    fs.copyFileSync(DB_PATH, tmpDb);
  }
  const gzPath = await gzipFile(tmpDb);
  fs.unlinkSync(tmpDb);
  return gzPath;
}

async function makeDataBackup() {
  const jsonFiles = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(DATA_DIR, f));

  if (!jsonFiles.length) {
    console.warn('[backup] No JSON files in data/ — skipping data backup');
    return null;
  }

  const outPath = path.join(os.tmpdir(), `cwn-data-${datestamp()}.tar.gz`);
  tarGzFiles(jsonFiles, outPath);
  return outPath;
}

// ── Postgres dump (pg_dump via system binary) ─────────────────────────────────

async function makePostgresBackup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[backup] DATABASE_URL not set — skipping Postgres backup');
    return null;
  }

  // Check pg_dump is available (installed as postgresql-client in Dockerfile)
  try {
    execSync('pg_dump --version', { stdio: 'pipe' });
  } catch {
    console.warn('[backup] pg_dump not found — skipping Postgres backup (install postgresql-client)');
    return null;
  }

  const outPath = path.join(os.tmpdir(), `auraflux-pg-${datestamp()}.dump`);
  try {
    // --format=custom produces a compressed binary dump usable with pg_restore
    execSync(`pg_dump --format=custom --no-password --file="${outPath}" "${dbUrl}"`, {
      stdio: 'pipe',
      env: { ...process.env, PGPASSWORD: '' }, // password is in the URL
      timeout: 120_000,
    });
  } catch (e) {
    throw new Error(`pg_dump failed: ${e.stderr?.toString().trim() || e.message}`);
  }

  // Gzip for storage efficiency (custom format is already compressed, but gzip on top for R2 consistency)
  const gzPath = await gzipFile(outPath);
  fs.unlinkSync(outPath);
  return gzPath;
}

// ── Cleanup old backups (belt-and-suspenders alongside R2 lifecycle rules) ───

async function pruneOldBackups(client, bucket, prefix, keepDays = 35) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);

  const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const objects = (list.Contents || []).filter((o) => new Date(o.LastModified) < cutoff);

  if (!objects.length) return;

  await client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: { Objects: objects.map((o) => ({ Key: o.Key })), Quiet: true },
  }));
  console.log(`[backup] Pruned ${objects.length} old backups under ${prefix}`);
}

// ── Pipeline event emission (New Relic alerting hook) ────────────────────────

function emitBackupEvent(status, details = {}) {
  const event = {
    eventType:   'AuraFluxBackup',
    status,
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    ...details,
  };

  // Write to pipeline_status.json so monitoring.js can pick it up
  const statusPath = path.join(ROOT_DIR, 'logs', 'pipeline_status.json');
  try {
    const existing = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : {};
    existing.lastBackup = event;
    fs.writeFileSync(statusPath, JSON.stringify(existing, null, 2));
  } catch (e) {
    console.warn('[backup] Could not write status file:', e.message);
  }

  // Log structured event for New Relic log-based alerting
  console.log(JSON.stringify({ ...event, level: status === 'success' ? 'info' : 'error' }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Run the full backup cycle. Exported so server.js can call it via node-cron.
 * When called as a CLI script it calls process.exit(); when imported it does not.
 * @param {boolean} [exitOnComplete=false]
 * @returns {Promise<{ ok: boolean, errors: Array }>}
 */
async function runBackup(exitOnComplete = false) {
  console.log(`[backup] Starting nightly backup — ${new Date().toISOString()}`);
  const startMs = Date.now();
  validateEnv();

  const client = makeR2Client();
  const bucket = process.env.R2_BACKUP_BUCKET;
  const date   = datestamp();
  const errors = [];

  // 1. SQLite backup (job pipeline data on persistent disk)
  try {
    const sqliteGz = await makeSQLiteBackup();
    if (sqliteGz) {
      await uploadToR2(client, bucket, `sqlite/cwn-${date}.db.gz`, sqliteGz);
      fs.unlinkSync(sqliteGz);
      await pruneOldBackups(client, bucket, 'sqlite/');
    }
  } catch (e) {
    console.error('[backup] SQLite backup failed:', e.message);
    errors.push({ stage: 'sqlite', error: e.message });
  }

  // 2. Postgres backup (billing, credits, Stripe events, voice profiles)
  try {
    const pgGz = await makePostgresBackup();
    if (pgGz) {
      await uploadToR2(client, bucket, `postgres/auraflux-pg-${date}.dump.gz`, pgGz);
      fs.unlinkSync(pgGz);
      await pruneOldBackups(client, bucket, 'postgres/');
    }
  } catch (e) {
    console.error('[backup] Postgres backup failed:', e.message);
    errors.push({ stage: 'postgres', error: e.message });
  }

  // 3. JSON state files backup
  try {
    const dataGz = await makeDataBackup();
    if (dataGz) {
      await uploadToR2(client, bucket, `data/cwn-data-${date}.tar.gz`, dataGz);
      fs.unlinkSync(dataGz);
      await pruneOldBackups(client, bucket, 'data/');
    }
  } catch (e) {
    console.error('[backup] Data backup failed:', e.message);
    errors.push({ stage: 'data', error: e.message });
  }

  // 4. Marketing site snapshot (cloudflare/marketing/ → R2 under marketing/<date>.tar.gz)
  try {
    const mktgSrc = path.join(ROOT_DIR, 'cloudflare', 'marketing');
    if (fs.existsSync(mktgSrc)) {
      const tmpMktg = path.join(os.tmpdir(), `marketing-snapshot-${date}.tar.gz`);
      execSync(`tar -czf "${tmpMktg}" -C "${path.dirname(mktgSrc)}" marketing`, { stdio: 'pipe' });
      const mktgBuf = fs.readFileSync(tmpMktg);
      await uploadToR2(client, bucket, `marketing/marketing-${date}.tar.gz`, mktgBuf);
      fs.unlinkSync(tmpMktg);
      await pruneOldBackups(client, bucket, 'marketing/');
      console.log('[backup] Marketing site snapshot uploaded');
    }
  } catch (e) {
    console.error('[backup] Marketing snapshot failed:', e.message);
    errors.push({ stage: 'marketing', error: e.message });
  }

  // 5. Render env var backup (all services → R2 under envvars/<service-id>/<date>.json.gz)
  try {
    const envResult = await backupRenderEnvVars();
    if (!envResult.ok) {
      envResult.errors.forEach((e) => errors.push({ stage: `env-vars:${e.serviceId}`, error: e.error }));
    }
  } catch (e) {
    console.error('[backup] Render env var backup failed:', e.message);
    errors.push({ stage: 'env-vars', error: e.message });
  }

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  if (errors.length) {
    emitBackupEvent('failure', { errors, elapsedSec });
    console.error(`[backup] Completed with ${errors.length} error(s) in ${elapsedSec}s`);
    if (exitOnComplete) process.exit(1);
    return { ok: false, errors };
  } else {
    emitBackupEvent('success', { elapsedSec, bucket, date });
    console.log(`[backup] Backup complete in ${elapsedSec}s`);
    if (exitOnComplete) process.exit(0);
    return { ok: true, errors: [] };
  }
}

module.exports = { runBackup };

// Run directly when invoked as CLI
if (require.main === module) {
  runBackup(true).catch((e) => {
    console.error('[backup] Unhandled error:', e);
    process.exit(1);
  });
}
