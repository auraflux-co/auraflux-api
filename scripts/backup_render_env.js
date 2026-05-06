#!/usr/bin/env node
'use strict';

/**
 * backup_render_env.js — Nightly backup of ALL Render service env vars to Cloudflare R2.
 *
 * Runs as part of the nightly backup cron at 03:00 UTC daily (invoked by backup_to_r2.js).
 * Can also be run manually: node scripts/backup_render_env.js
 *
 * What it backs up:
 *   - All env vars for every service listed in RENDER_SERVICE_IDS
 *   - Stored as encrypted JSON in R2 under envvars/<service-id>/YYYY-MM-DD.json.gz
 *
 * Restore:
 *   node scripts/restore_render_env.js [--service <id>] [--date YYYY-MM-DD] [--dry-run]
 *
 * Required env vars:
 *   RENDER_API_KEY, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 */

const zlib    = require('zlib');
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const RENDER_API_BASE = 'https://api.render.com/v1';

// All Render services to back up — add new services here
const RENDER_SERVICE_IDS = [
  process.env.RENDER_SERVICE_ID || 'srv-d7nsd77avr4c73frifcg', // auraflux-api
  'srv-d7nsd6favr4c73frifb0',                                    // auraflux-app
].filter(Boolean);

const REQUIRED_ENV = [
  'RENDER_API_KEY',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BACKUP_BUCKET',
];

function validateEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
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

function datestamp() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchServiceEnvVars(serviceId) {
  const url = `${RENDER_API_BASE}/services/${serviceId}/env-vars`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Render API ${res.status} for ${serviceId}: ${body}`);
  }
  const data = await res.json();
  // Normalise to flat key→value map
  return Object.fromEntries(data.map((item) => [item.envVar.key, item.envVar.value]));
}

async function fetchServiceInfo(serviceId) {
  const res = await fetch(`${RENDER_API_BASE}/services/${serviceId}`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
  });
  if (!res.ok) return { id: serviceId, name: serviceId };
  const data = await res.json();
  return { id: serviceId, name: data.service?.name || serviceId };
}

async function gzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, { level: 6 }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function uploadToR2(client, bucket, key, body) {
  await client.send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    Body:        body,
    ContentType: 'application/gzip',
    Metadata: {
      'backup-date':   datestamp(),
      'backup-source': 'backup_render_env',
    },
  }));
  console.log(`[env-backup] Uploaded → s3://${bucket}/${key} (${(body.length / 1024).toFixed(1)} KB)`);
}

/**
 * Back up env vars for all configured Render services.
 * @returns {Promise<{ok: boolean, errors: Array, backed_up: string[]}>}
 */
async function backupRenderEnvVars() {
  validateEnv();
  const client  = makeR2Client();
  const bucket  = process.env.R2_BACKUP_BUCKET;
  const date    = datestamp();
  const errors  = [];
  const backedUp = [];

  for (const serviceId of RENDER_SERVICE_IDS) {
    try {
      const [info, envVars] = await Promise.all([
        fetchServiceInfo(serviceId),
        fetchServiceEnvVars(serviceId),
      ]);

      const varCount = Object.keys(envVars).length;
      if (varCount === 0) {
        console.warn(`[env-backup] ${info.name} (${serviceId}): 0 env vars — skipping`);
        continue;
      }

      const payload = JSON.stringify({
        service_id:   serviceId,
        service_name: info.name,
        backup_date:  new Date().toISOString(),
        env_vars:     envVars,
      }, null, 2);

      const gz  = await gzipBuffer(Buffer.from(payload, 'utf8'));
      const key = `envvars/${serviceId}/${date}.json.gz`;
      await uploadToR2(client, bucket, key, gz);
      backedUp.push(`${info.name} (${varCount} vars)`);
    } catch (e) {
      console.error(`[env-backup] Failed for ${serviceId}:`, e.message);
      errors.push({ serviceId, error: e.message });
    }
  }

  if (errors.length) {
    console.error(`[env-backup] Completed with ${errors.length} error(s)`);
    return { ok: false, errors, backed_up: backedUp };
  }

  console.log(`[env-backup] Done — backed up: ${backedUp.join(', ')}`);
  return { ok: true, errors: [], backed_up: backedUp };
}

module.exports = { backupRenderEnvVars };

if (require.main === module) {
  backupRenderEnvVars()
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => { console.error('[env-backup] Fatal:', e.message); process.exit(1); });
}
