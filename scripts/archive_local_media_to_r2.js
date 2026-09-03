#!/usr/bin/env node
'use strict';

/**
 * archive_local_media_to_r2.js
 *
 * Move finished C0 production media off the Mac onto Cloudflare R2, then delete
 * local copies. Keeps code / data / brand assets. Clears regenerable tmp + old logs.
 *
 * Usage:
 *   node scripts/archive_local_media_to_r2.js              # dry-run
 *   node scripts/archive_local_media_to_r2.js --apply      # upload/verify + delete
 *   node scripts/archive_local_media_to_r2.js --apply --skip-tmp-logs
 *
 * Safe defaults:
 *   - Never deletes a file unless R2 is verified (existing driveUrl HEAD, or upload OK)
 *   - Skips files newer than 2 hours (likely in-flight)
 *   - Refuses if tmp/asm_* ffmpeg-looking processes are present
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { uploadToR2, isR2Configured } = require('../lib/storage');

const ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const TMP_DIR = path.join(ROOT, 'tmp');
const LOGS_DIR = path.join(ROOT, 'logs');
const JOBS_PATH = path.join(ROOT, 'data', 'jobs.json');
const MANIFEST_PATH = path.join(LOGS_DIR, 'local_media_archive_manifest.json');

const APPLY = process.argv.includes('--apply');
const SKIP_TMP_LOGS = process.argv.includes('--skip-tmp-logs');
const MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2h

function gb(n) {
  return `${(n / 1e9).toFixed(2)} GB`;
}

function loadJobs() {
  if (!fs.existsSync(JOBS_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}

function saveJobs(jobs) {
  // Preserve array vs object shape
  const raw = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8'));
  if (Array.isArray(raw)) {
    fs.writeFileSync(JOBS_PATH, JSON.stringify(jobs, null, 2));
    return;
  }
  const map = {};
  for (const j of jobs) {
    const id = j.id || j.jobId || j.cardId;
    if (id) map[id] = j;
  }
  fs.writeFileSync(JOBS_PATH, JSON.stringify(map, null, 2));
}

async function urlReachable(url) {
  if (!url || String(url).includes('localhost')) return false;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (res.ok) return true;
    // Some CDNs reject HEAD — try ranged GET
    const get = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
    });
    return get.ok || get.status === 206;
  } catch {
    return false;
  }
}

function assemblyBusy() {
  try {
    const out = execSync('pgrep -fl "tmp/asm_" || true', { encoding: 'utf8' });
    return Boolean(out.trim());
  } catch {
    return false;
  }
}

function listOutputMedia() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => /\.(mp4|mov|m4a|wav|webm)$/i.test(f))
    .map((f) => {
      const p = path.join(OUTPUT_DIR, f);
      const st = fs.statSync(p);
      return { path: p, name: f, size: st.size, mtimeMs: st.mtimeMs };
    });
}

function isFresh(mtimeMs) {
  return Date.now() - mtimeMs < MIN_AGE_MS;
}

async function archiveOrphan(file, manifest) {
  const key = `local-archive/c0-output/${file.name}`;
  const existing = manifest.orphans?.[file.name];
  if (existing?.driveUrl && (await urlReachable(existing.driveUrl))) {
    return { action: 'already_on_r2', driveUrl: existing.driveUrl };
  }
  if (!APPLY) return { action: 'would_upload', key, size: file.size };

  const driveUrl = await uploadToR2(file.path, file.name, {
    folder: 'local-archive/c0-output',
    key,
  });
  if (!(await urlReachable(driveUrl))) {
    throw new Error(`Uploaded but URL not reachable: ${driveUrl}`);
  }
  return { action: 'uploaded', driveUrl, key };
}

async function main() {
  console.log(`[archive] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (!isR2Configured()) {
    console.error('[archive] R2 env not configured');
    process.exit(1);
  }
  if (APPLY && assemblyBusy()) {
    console.error('[archive] Abort: tmp/asm_ process detected — wait for assembly to finish');
    process.exit(2);
  }

  const jobs = loadJobs();
  const media = listOutputMedia();
  const knownPaths = new Set();
  /** @type {{ at: string, mode: string, jobs: any[], orphans: Record<string, any>, deletedBytes: number, skipped: any[] }} */
  const results = {
    at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    jobs: [],
    orphans: {},
    deletedBytes: 0,
    skipped: [],
  };

  // ── Job-linked outputs (prefer existing driveUrl) ─────────────────────────
  for (const job of jobs) {
    const id = job.id || job.jobId || job.cardId;
    const localPath = job.outputPath || job.state?.savedOutputs?.assembledPath;
    const driveUrl = job.driveUrl || job.state?.savedOutputs?.driveUrl;
    if (!localPath || !fs.existsSync(localPath)) continue;
    knownPaths.add(path.resolve(localPath));

    const st = fs.statSync(localPath);
    if (isFresh(st.mtimeMs)) {
      results.skipped.push({ id, reason: 'fresh_<2h', path: localPath });
      continue;
    }

    let url = driveUrl;
    let action = 'verify_existing';
    if (!url || String(url).includes('localhost') || !(await urlReachable(url))) {
      if (!APPLY) {
        results.jobs.push({ id, action: 'would_reupload', path: localPath, size: st.size });
        continue;
      }
      action = 'reuploaded';
      url = await uploadToR2(localPath, path.basename(localPath), {
        folder: `outputs/${id}`,
        key: `outputs/${id}/${path.basename(localPath)}`,
      });
      if (!(await urlReachable(url))) {
        throw new Error(`Job ${id}: R2 URL not reachable after upload`);
      }
      job.driveUrl = url;
      job.state = job.state || {};
      job.state.savedOutputs = { ...(job.state.savedOutputs || {}), driveUrl: url };
    } else if (!(await urlReachable(url))) {
      results.skipped.push({ id, reason: 'driveUrl_unreachable', url });
      continue;
    }

    results.jobs.push({ id, action, driveUrl: url, path: localPath, size: st.size });
    if (APPLY) {
      fs.unlinkSync(localPath);
      results.deletedBytes += st.size;
      // Keep driveUrl; clear local path so UI uses R2
      if (job.outputPath === localPath) job.outputPath = null;
      if (job.state?.savedOutputs?.assembledPath === localPath) {
        job.state.savedOutputs.assembledPath = null;
        job.state.savedOutputs.localArchivedAt = new Date().toISOString();
      }
      job.localMediaArchivedAt = new Date().toISOString();
    }
  }

  // ── Orphan output media ───────────────────────────────────────────────────
  const prior = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { orphans: {} };

  for (const file of media) {
    if (knownPaths.has(path.resolve(file.path))) continue;
    if (isFresh(file.mtimeMs)) {
      results.skipped.push({ reason: 'fresh_<2h', path: file.path });
      continue;
    }
    try {
      const r = await archiveOrphan(file, prior);
      results.orphans[file.name] = {
        ...r,
        size: file.size,
        localPath: file.path,
      };
      if (APPLY && (r.action === 'uploaded' || r.action === 'already_on_r2')) {
        fs.unlinkSync(file.path);
        results.deletedBytes += file.size;
      }
    } catch (err) {
      results.skipped.push({ path: file.path, reason: err.message });
    }
  }

  // ── Regenerable tmp + old debug logs ──────────────────────────────────────
  let tmpCleared = 0;
  let logsCleared = 0;
  if (!SKIP_TMP_LOGS) {
    const tmpTargets = [
      'live_tv_cache',
      'composition_preview',
      'competitor_visual',
      '_cmp_smoke',
      '_freeze_debug',
      'manual_segments',
    ];
    for (const name of tmpTargets) {
      const p = path.join(TMP_DIR, name);
      if (!fs.existsSync(p)) continue;
      const size = duBytes(p);
      if (!APPLY) {
        console.log(`[archive] would clear tmp/${name} (${gb(size)})`);
      } else {
        fs.rmSync(p, { recursive: true, force: true });
        tmpCleared += size;
        results.deletedBytes += size;
        console.log(`[archive] cleared tmp/${name} (${gb(size)})`);
      }
    }

    // Old streamer_block / boundary_compare debug folders
    if (fs.existsSync(LOGS_DIR)) {
      for (const name of fs.readdirSync(LOGS_DIR)) {
        if (!/^(streamer_block_|boundary_compare_|_boundary_)/.test(name)) continue;
        const p = path.join(LOGS_DIR, name);
        const st = fs.statSync(p);
        if (!st.isDirectory()) continue;
        const size = duBytes(p);
        if (!APPLY) {
          console.log(`[archive] would clear logs/${name} (${gb(size)})`);
        } else {
          fs.rmSync(p, { recursive: true, force: true });
          logsCleared += size;
          results.deletedBytes += size;
        }
      }
    }
  }

  if (APPLY) {
    saveJobs(jobs);
    const manifestOut = {
      updatedAt: new Date().toISOString(),
      jobs: results.jobs,
      orphans: { ...(prior.orphans || {}), ...results.orphans },
      deletedBytes: results.deletedBytes,
      tmpCleared,
      logsCleared,
    };
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifestOut, null, 2));
    console.log(`[archive] wrote ${MANIFEST_PATH}`);
  }

  console.log('\n[archive] summary');
  console.log(`  jobs handled: ${results.jobs.length}`);
  console.log(`  orphans handled: ${Object.keys(results.orphans).length}`);
  console.log(`  skipped: ${results.skipped.length}`);
  console.log(`  ${APPLY ? 'deleted' : 'would delete'}: ${gb(results.deletedBytes || estimateWouldDelete(results, tmpCleared, logsCleared))}`);
  if (results.skipped.length) {
    console.log('  skipped detail:', JSON.stringify(results.skipped.slice(0, 10), null, 2));
  }
}

function estimateWouldDelete(results, tmpCleared, logsCleared) {
  let n = tmpCleared + logsCleared;
  for (const j of results.jobs) n += j.size || 0;
  for (const o of Object.values(results.orphans)) n += o.size || 0;
  return n;
}

function duBytes(p) {
  try {
    const out = execSync(`du -sk "${p}"`, { encoding: 'utf8' });
    return parseInt(out.split(/\s+/)[0], 10) * 1024;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error('[archive] FAILED', err);
  process.exit(1);
});
