'use strict';
/**
 * lib/startup.js — server startup checks and cleanup
 *
 * Called once at process start from server.js. Validates required env vars,
 * cleans orphaned temp files, and verifies directory write permissions.
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
};
