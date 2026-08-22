#!/usr/bin/env node
'use strict';

/**
 * scripts/backup_render_env.js
 *
 * Two responsibilities:
 *
 *   1. backupRenderEnvVars()  — called nightly by backup_to_r2.js
 *      Reads process.env (the running server's live env) and pushes a snapshot
 *      to R2 under:
 *        <R2_BACKUP_BUCKET>/envvars/<serviceId>/<YYYY-MM-DD>.json.gz
 *        <R2_BACKUP_BUCKET>/envvars/<serviceId>/latest.json.gz   ← always current
 *
 *   2. CLI restore mode — run directly:
 *        node scripts/backup_render_env.js --restore
 *      Downloads latest.json.gz from R2 for each service and pushes all vars
 *      to Render via PUT /env-vars (full replace, so nothing is left missing).
 *
 * WHY R2 and not .env:
 *   .env on disk relies on the agent or Rob remembering to update it.
 *   R2 is updated automatically every night by the running server — it always
 *   reflects the actual live set, including vars added/changed through the
 *   Render dashboard without touching any code.
 *
 * Bootstrap (what you need if EVERYTHING is wiped):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET,
 *   RENDER_API_KEY — keep these five in 1Password / your password manager.
 *   Everything else restores from R2 automatically.
 *
 * Required env vars for backup:   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 * Required env vars for restore:  same as above + RENDER_API_KEY
 */

const zlib = require('zlib');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// ── Services to back up / restore ────────────────────────────────────────────
// Add or remove service IDs + names as the infrastructure changes.
const SERVICES = [
  { id: 'srv-d7nsd77avr4c73frifcg', name: 'auraflux-api' },
  // auraflux-app moved to Vercel (app.auraflux.co) — env vars live in Vercel dashboard
];

// Vars that exist locally or in CI but must never be pushed to production Render.
const SKIP_KEYS = new Set([
  'RENDER_API_KEY',
  'NEW_RELIC_APP_NAME',
  'NEW_RELIC_LICENSE_KEY',
  'NEW_RELIC_USER_KEY',
  'GATE_TEST_MODE',
  'ATLASSIAN_API_TOKEN',
  'ATLASSIAN_DOMAIN',
  'ATLASSIAN_EMAIL',
  'JIRA_PROJECT_KEY',
  'JIRA_WEBHOOK_SECRET',
  'CONFLUENCE_SPACE_KEY',
  'DASHBOARD_PORT',
]);

// ── R2 client ────────────────────────────────────────────────────────────────
function makeR2Client() {
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error('R2_ACCOUNT_ID not set');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// ── Render API helpers ────────────────────────────────────────────────────────
async function renderFetch(path, opts = {}) {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error('RENDER_API_KEY not set');
  const res = await fetch(`https://api.render.com/v1${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Render API ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// GET /services/{id}/env-vars — returns array of { envVar: { key, value } }
async function getServiceEnvVars(serviceId) {
  const rows = await renderFetch(`/services/${serviceId}/env-vars?limit=200`);
  return rows.map((r) => ({ key: r.envVar.key, value: r.envVar.value }));
}

// PUT /services/{id}/env-vars — replaces the full set
async function putServiceEnvVars(serviceId, envVars) {
  return renderFetch(`/services/${serviceId}/env-vars`, {
    method: 'PUT',
    body: JSON.stringify(envVars),
  });
}

// ── Gzip helpers ─────────────────────────────────────────────────────────────
function gzipJson(obj) {
  return new Promise((resolve, reject) => {
    zlib.gzip(JSON.stringify(obj, null, 2), (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

function gunzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, out) => (err ? reject(err) : resolve(JSON.parse(out.toString()))));
  });
}

// ── Backup: called nightly from backup_to_r2.js ──────────────────────────────
async function backupRenderEnvVars() {
  const r2 = makeR2Client();
  const bucket = process.env.R2_BACKUP_BUCKET;
  if (!bucket) {
    console.warn('[env-backup] R2_BACKUP_BUCKET not set — skipping env var backup');
    return { ok: true, skipped: true, errors: [] };
  }

  const date = new Date().toISOString().slice(0, 10);
  const errors = [];

  for (const svc of SERVICES) {
    try {
      // Snapshot current live env vars from Render API (requires RENDER_API_KEY)
      let vars;
      if (process.env.RENDER_API_KEY) {
        vars = await getServiceEnvVars(svc.id);
        vars = vars.filter((v) => !SKIP_KEYS.has(v.key));
      } else {
        // Fallback: snapshot process.env (works when called from the running server itself)
        vars = Object.entries(process.env)
          .filter(([k]) => !SKIP_KEYS.has(k) && !k.startsWith('npm_') && !k.startsWith('PATH'))
          .map(([key, value]) => ({ key, value }));
        console.log(`[env-backup] No RENDER_API_KEY — snapshotting process.env for ${svc.name}`);
      }

      const payload = {
        service: svc.name,
        serviceId: svc.id,
        snapshotDate: date,
        capturedAt: new Date().toISOString(),
        varCount: vars.length,
        vars,
      };

      const buf = await gzipJson(payload);

      // Upload dated snapshot + overwrite latest
      for (const key of [`envvars/${svc.id}/${date}.json.gz`, `envvars/${svc.id}/latest.json.gz`]) {
        await r2.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: buf,
          ContentType: 'application/json',
          ContentEncoding: 'gzip',
        }));
      }

      console.log(`[env-backup] ✅ ${svc.name} — ${vars.length} vars backed up to R2`);
    } catch (e) {
      console.error(`[env-backup] ❌ ${svc.name}: ${e.message}`);
      errors.push({ serviceId: svc.id, error: e.message });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Restore: run via CLI ──────────────────────────────────────────────────────
async function restoreRenderEnvVars({ dryRun = false } = {}) {
  const r2 = makeR2Client();
  const bucket = process.env.R2_BACKUP_BUCKET;
  if (!bucket) throw new Error('R2_BACKUP_BUCKET not set');

  for (const svc of SERVICES) {
    console.log(`\n[env-restore] Restoring ${svc.name} (${svc.id})...`);

    // Download latest snapshot from R2
    const r2Key = `envvars/${svc.id}/latest.json.gz`;
    let snapshot;
    try {
      const resp = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: r2Key }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      snapshot = await gunzipBuffer(Buffer.concat(chunks));
    } catch (e) {
      console.error(`[env-restore] ❌ Cannot download snapshot for ${svc.name}: ${e.message}`);
      console.error(`  R2 key: s3://${bucket}/${r2Key}`);
      continue;
    }

    console.log(`[env-restore] Snapshot from ${snapshot.snapshotDate} — ${snapshot.varCount} vars`);

    if (dryRun) {
      console.log('[env-restore] DRY RUN — vars that would be restored:');
      snapshot.vars.forEach((v) => {
        const masked = v.value.length > 6 ? v.value.slice(0, 4) + '...' : '***';
        console.log(`  ${v.key} = ${masked}`);
      });
      continue;
    }

    // Push full var set to Render
    const result = await putServiceEnvVars(svc.id, snapshot.vars);
    console.log(`[env-restore] ✅ ${svc.name} — ${result.length} vars restored to Render`);
    console.log(`  Render will redeploy ${svc.name} automatically.`);
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (args.includes('--restore')) {
    console.log(`\n🔄 Restoring Render env vars from R2${dryRun ? ' (DRY RUN)' : ''}...\n`);
    restoreRenderEnvVars({ dryRun })
      .then(() => console.log('\n✅ Restore complete.'))
      .catch((e) => { console.error('\n❌ Restore failed:', e.message); process.exit(1); });
  } else if (args.includes('--backup')) {
    console.log('\n📦 Backing up Render env vars to R2...\n');
    backupRenderEnvVars()
      .then((r) => {
        if (r.ok) console.log('\n✅ Backup complete.');
        else { console.error('\n❌ Backup had errors:', r.errors); process.exit(1); }
      })
      .catch((e) => { console.error('\n❌ Backup failed:', e.message); process.exit(1); });
  } else {
    console.log(`
Usage:
  node scripts/backup_render_env.js --backup            # snapshot current Render env → R2
  node scripts/backup_render_env.js --restore           # restore from R2 → Render (triggers redeploy)
  node scripts/backup_render_env.js --restore --dry-run # show what would be restored, no write

Bootstrap vars (keep in 1Password — everything else restores from R2):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET, RENDER_API_KEY
`);
    process.exit(0);
  }
}

module.exports = { backupRenderEnvVars, restoreRenderEnvVars };
