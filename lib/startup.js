'use strict';
/**
 * lib/startup.js — server startup checks and cleanup
 *
 * Called once at process start from server.js. Validates required env vars,
 * cleans orphaned temp files, verifies directory write permissions, and
 * rescues jobs that were left in 'running' state by a previous process exit.
 */

const fs   = require('fs');
const path = require('path');

/**
 * Validate required environment variables — exits with code 1 if any are missing.
 *
 * @param {string[]} required  — list of env var names
 */
function validateRequiredEnv(required) {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('\n❌ FATAL: Missing required environment variables:');
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error('\nPlease add these to your .env file and restart.\n');
    process.exit(1);
  }
  console.log('✅ All required environment variables present');
}

/**
 * Remove temp files older than 24 hours from tmpDir on startup.
 *
 * @param {string} tmpDir
 */
function cleanupOrphanedTempFiles(tmpDir) {
  const maxAge = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;
  try {
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > maxAge) { fs.unlinkSync(fp); cleaned++; }
      } catch (_) { /* already deleted or inaccessible */ }
    }
    if (cleaned > 0) console.log(`🧹 Cleaned up ${cleaned} orphaned temp file(s)`);
  } catch (e) {
    console.error(`⚠️  Temp file cleanup failed: ${e.message}`);
  }
}

/**
 * Verify a directory is writable — exits with code 1 if not.
 *
 * @param {string} dirPath
 * @param {string} dirName  — human label for error messages
 */
function validateDirWritable(dirPath, dirName) {
  try {
    const testFile = path.join(dirPath, `.writetest_${Date.now()}`);
    fs.writeFileSync(testFile, 'permission_test');
    fs.unlinkSync(testFile);
    console.log(`✅ ${dirName} directory is writable`);
  } catch (e) {
    console.error(`\n❌ FATAL: ${dirName} directory is not writable: ${dirPath}`);
    console.error(`   Error: ${e.message}`);
    console.error('   Fix permissions and restart.\n');
    process.exit(1);
  }
}

/**
 * Rescue jobs left in 'running' state by a previous process exit (CPD-139).
 *
 * Any job whose job_spec.status is 'running' and whose updated_at is older
 * than STALE_SECS was being processed in-memory when the server last died.
 * We can't safely resume from an arbitrary portal mid-flight, so we mark
 * them 'failed' with a clear restart reason so operators can retry via the
 * dashboard or the job auto-retry on next submit.
 *
 * Safe to call before routes are mounted — uses the DB pool directly.
 * Runs asynchronously so it never blocks server listen().
 */
async function rescueInterruptedJobs() {
  // CPD-195/CPD-891: assembly with LUT+captions+intro/outro can exceed 10 min on Render.
  // 1800s (30 min) avoids falsely killing in-progress assembly jobs; heartbeat updates DB
  // every 30s so genuinely orphaned jobs are still caught.
  // Override with ASSEMBLY_STALE_THRESHOLD_S env var.
  const STALE_SECS = parseInt(process.env.ASSEMBLY_STALE_THRESHOLD_S || '1800', 10);
  try {
    const db = require('./db/postgres');
    const stale = await db.loadRunningJobs(STALE_SECS);
    if (stale.length === 0) return;

    console.log(`[startup] Found ${stale.length} interrupted job(s) — marking failed (CPD-266: E2E will auto-retry on interrupted_by_restart)`);
    await Promise.all(
      stale.map(({ id, spec }) => {
        // CPD-175/CPD-218: If the job already has a video URL, assembly succeeded before
        // the server died. Mark as 'assembled' (not 'failed').
        // CPD-218: Also propagate assembledVideoUrl → outputUrl so E2E runner and dashboard
        // can resolve the video. Without this, jobs rescued to 'assembled' state have no
        // outputUrl and the E2E poller times out waiting for a terminal result.
        const hasOutput = !!(spec.outputUrl || spec.assembledVideoUrl || spec.assembledPath);
        const rescuedOutputUrl = spec.outputUrl || spec.assembledVideoUrl || null;
        const rescued = {
          ...spec,
          status: hasOutput ? 'assembled' : 'failed',
          ...(hasOutput && rescuedOutputUrl ? { outputUrl: rescuedOutputUrl } : {}),
          failedPortal: hasOutput ? null : (spec.currentPortal || 'unknown'),
          failReason: hasOutput ? 'publish_interrupted_by_restart' : 'interrupted_by_restart',
          rescuedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return db.updateJobSpec(id, rescued).catch((e) =>
          console.error(`[startup] rescueInterruptedJobs: failed to update ${id}: ${e.message}`)
        );
      })
    );
    console.log(`[startup] ✅ Rescued ${stale.length} interrupted job(s)`);
  } catch (e) {
    // Non-fatal — DB may not be ready yet on the very first cold start
    console.warn(`[startup] rescueInterruptedJobs: ${e.message}`);
  }
}

/**
 * CPD-218 (long-term fix): Scan for jobs stuck in 'assembled' status that have
 * an outputUrl but never reached 'published'. This happens when a server crash
 * interrupted the pipeline after assembly but before the publish portal ran.
 *
 * For these jobs we promote status to 'published' directly — the video is ready
 * and the customer can access it. This avoids requiring a full portal resume queue.
 *
 * Called once at startup, ~5 seconds after rescueInterruptedJobs.
 * Safe to call at any time — idempotent (only acts on 'assembled' jobs).
 */
async function promoteAssembledJobs() {
  try {
    const db   = require('./db/postgres');
    const { rows } = await db.query(
      `SELECT id, job_spec FROM jobs
       WHERE job_spec IS NOT NULL
         AND job_spec->>'status' = 'assembled'
         AND job_spec->>'outputUrl' IS NOT NULL
         AND job_spec->>'outputUrl' != ''
       ORDER BY updated_at ASC LIMIT 20`
    );
    if (!rows || rows.length === 0) return;

    console.log(`[startup] Found ${rows.length} assembled job(s) with outputUrl — promoting to staged + grading`);

    // Promote to 'staged' (not 'published') so jobs land in the review queue
    // rather than being auto-published without portal QA completing.
    // Run the grader so grade/gradeResult are populated before the customer sees them.
    let gradeJob;
    try { ({ gradeJob } = require('./services/job_grader')); } catch (_) { /* non-fatal */ }

    await Promise.all(
      rows.map(async (row) => {
        const id  = row.id;
        let spec  = row.job_spec;
        if (typeof spec === 'string') {
          try { spec = JSON.parse(spec); } catch (_) { return; }
        }

        // Run grader if available
        if (gradeJob) {
          try {
            const gr = gradeJob({ ...spec, status: 'complete' });
            spec.grade       = gr.grade;
            spec.gradeResult = { ...gr, gradedAt: new Date().toISOString() };
          } catch (_) { /* non-fatal */ }
        }

        const updated = {
          ...spec,
          status:    'staged',
          updatedAt: new Date().toISOString(),
          failReason: null,
          _promotedFromAssembled: true,
        };
        return db.updateJobSpec(id, updated).catch((e) =>
          console.error(`[startup] promoteAssembledJobs: failed to promote ${id}: ${e.message}`)
        );
      })
    );
    console.log(`[startup] ✅ Promoted ${rows.length} assembled job(s) to staged`);
  } catch (e) {
    console.warn(`[startup] promoteAssembledJobs: ${e.message}`);
  }
}

/**
 * Run all startup checks for a server instance.
 *
 * @param {{ requiredEnv: string[], tmpDir: string, outputDir: string }} opts
 */
function runStartupChecks({ requiredEnv = [], tmpDir, outputDir } = {}) {
  validateRequiredEnv(requiredEnv);
  cleanupOrphanedTempFiles(tmpDir);
  validateDirWritable(tmpDir, 'tmp');
  validateDirWritable(outputDir, 'output');
}

module.exports = {
  validateRequiredEnv,
  cleanupOrphanedTempFiles,
  validateDirWritable,
  runStartupChecks,
  rescueInterruptedJobs,
  promoteAssembledJobs,
};
