#!/usr/bin/env node
'use strict';

/**
 * restore_render_env.js — Restore Render service env vars from R2 backup.
 *
 * Usage:
 *   node scripts/restore_render_env.js                          # latest backup, all services
 *   node scripts/restore_render_env.js --date 2026-05-04        # specific date
 *   node scripts/restore_render_env.js --service srv-xxxx       # one service only
 *   node scripts/restore_render_env.js --dry-run                # preview only, no writes
 *   node scripts/restore_render_env.js --list                   # list available backups
 *
 * Required env vars:
 *   RENDER_API_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 */

const zlib = require('zlib');
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const RENDER_API_BASE = 'https://api.render.com/v1';

const RENDER_SERVICE_IDS = [
  process.env.RENDER_SERVICE_ID || 'srv-d7nsd77avr4c73frifcg',
  'srv-d7nsd6favr4c73frifb0',
].filter(Boolean);

const REQUIRED_ENV = [
  'RENDER_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BACKUP_BUCKET',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, list: false, date: null, service: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--list')    opts.list    = true;
    if (args[i] === '--date')    opts.date    = args[++i];
    if (args[i] === '--service') opts.service = args[++i];
  }
  return opts;
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function gunzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function listBackups(client, bucket, serviceId) {
  const prefix = `envvars/${serviceId}/`;
  const res = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (res.Contents || [])
    .map((o) => ({ key: o.Key, date: o.Key.replace(prefix, '').replace('.json.gz', ''), lastModified: o.LastModified }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function fetchBackup(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buf  = await streamToBuffer(res.Body);
  const json = await gunzipBuffer(buf);
  return JSON.parse(json.toString('utf8'));
}

async function getCurrentEnvVars(serviceId) {
  const res = await fetch(`${RENDER_API_BASE}/services/${serviceId}/env-vars`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Render API ${res.status}`);
  const data = await res.json();
  return Object.fromEntries(data.map((item) => [item.envVar.key, item.envVar.value]));
}

async function putEnvVars(serviceId, merged) {
  const payload = Object.entries(merged).map(([key, value]) => ({ key, value }));
  const res = await fetch(`${RENDER_API_BASE}/services/${serviceId}/env-vars`, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${process.env.RENDER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Render PUT ${res.status}: ${body}`);
  }
  return res.json();
}

async function restoreService(client, bucket, serviceId, targetDate, dryRun) {
  const backups = await listBackups(client, bucket, serviceId);
  if (!backups.length) {
    console.warn(`[env-restore] No backups found for ${serviceId}`);
    return;
  }

  const target = targetDate
    ? backups.find((b) => b.date === targetDate)
    : backups[0]; // latest

  if (!target) {
    console.error(`[env-restore] No backup for date ${targetDate} — available: ${backups.map((b) => b.date).join(', ')}`);
    return;
  }

  console.log(`[env-restore] Restoring ${serviceId} from backup: ${target.key}`);

  const backup  = await fetchBackup(client, bucket, target.key);
  const current = await getCurrentEnvVars(serviceId);

  // Merge: backup values win, but keep any keys present on Render not in backup
  const merged  = { ...current, ...backup.env_vars };
  const changed = Object.keys(backup.env_vars).filter((k) => current[k] !== backup.env_vars[k]);
  const added   = changed.filter((k) => !(k in current));
  const updated = changed.filter((k) => k in current);

  console.log(`  Backup has   : ${Object.keys(backup.env_vars).length} vars`);
  console.log(`  Current has  : ${Object.keys(current).length} vars`);
  console.log(`  After merge  : ${Object.keys(merged).length} vars`);
  console.log(`  New keys     : ${added.length > 0 ? added.join(', ') : 'none'}`);
  console.log(`  Updated keys : ${updated.length > 0 ? updated.join(', ') : 'none'}`);

  if (dryRun) {
    console.log('[env-restore] DRY RUN — no changes written');
    return;
  }

  await putEnvVars(serviceId, merged);
  console.log(`[env-restore] ✅ ${serviceId} restored (${Object.keys(merged).length} vars)`);
}

async function main() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const opts   = parseArgs();
  const client = makeR2Client();
  const bucket = process.env.R2_BACKUP_BUCKET;

  const services = opts.service
    ? [opts.service]
    : RENDER_SERVICE_IDS;

  if (opts.list) {
    for (const serviceId of services) {
      const backups = await listBackups(client, bucket, serviceId);
      console.log(`\n${serviceId}:`);
      backups.forEach((b) => console.log(`  ${b.date}  (${b.key})`));
    }
    return;
  }

  for (const serviceId of services) {
    try {
      await restoreService(client, bucket, serviceId, opts.date, opts.dryRun);
    } catch (e) {
      console.error(`[env-restore] Failed for ${serviceId}:`, e.message);
    }
  }
}

main().catch((e) => { console.error('[env-restore] Fatal:', e.message); process.exit(1); });
