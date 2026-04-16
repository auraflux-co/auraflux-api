// lib/directives.js
// Red 4 hotfix 12 — Directive sidecar architecture
// Directives are first-class server-side artifacts stored at
// data/directives/{jobId}.json. Validated by Zod at write time and load time.
// The script textarea NEVER contains directive JSON; spoken text only.

'use strict';

const fs = require('fs');
const path = require('path');
const { validateScript } = require('./chromeDirectives');

const DIRECTIVES_DIR = path.join(__dirname, '..', 'data', 'directives');

// Ensure the directives directory exists at startup
if (!fs.existsSync(DIRECTIVES_DIR)) {
  fs.mkdirSync(DIRECTIVES_DIR, { recursive: true });
}

/**
 * Write a directive object to data/directives/{jobId}.json after validation.
 * Throws if validation fails — caller must handle the error and surface it
 * to the dashboard / response so the operator sees the specific Zod path.
 *
 * @param {string} jobId - The job ID this directive belongs to
 * @param {object} directive - The directive object (must conform to ScriptSchema)
 * @returns {string} - The absolute path to the written file
 * @throws {Error} - If validation fails or write fails
 */
function writeDirectiveForJob(jobId, directive) {
  const validation = validateScript(directive);
  if (!validation.ok) {
    const err = new Error('Directive failed Zod validation: ' + validation.errors.join('; '));
    err.code = 'DIRECTIVE_VALIDATION_FAILED';
    err.validatorErrors = validation.errors;
    throw err;
  }
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(directive, null, 2), 'utf8');
  console.log(`[directives] Wrote directive for job ${jobId} → ${filePath} (${directive.scenes.length} scenes, ${directive.storyList.length} stories)`);
  return filePath;
}

/**
 * Load and re-validate a directive for the given job ID.
 * Re-validation at load time catches the case where a directive file was
 * written by an older version of the schema OR was hand-edited and corrupted.
 *
 * @param {string} jobId - The job ID to load the directive for
 * @returns {object} - The validated directive object
 * @throws {Error} - If the file is missing, unreadable, or fails validation
 */
function loadDirectiveForJob(jobId) {
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  if (!fs.existsSync(filePath)) {
    const err = new Error(`Directive file not found for job ${jobId}: ${filePath}`);
    err.code = 'DIRECTIVE_NOT_FOUND';
    throw err;
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    const err = new Error(`Failed to read directive file ${filePath}: ${e.message}`);
    err.code = 'DIRECTIVE_READ_FAILED';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`Directive file ${filePath} is not valid JSON: ${e.message}`);
    err.code = 'DIRECTIVE_PARSE_FAILED';
    throw err;
  }
  const validation = validateScript(parsed);
  if (!validation.ok) {
    const err = new Error(`Directive file ${filePath} failed Zod validation: ${validation.errors.join('; ')}`);
    err.code = 'DIRECTIVE_VALIDATION_FAILED';
    err.validatorErrors = validation.errors;
    throw err;
  }
  return parsed;
}

/**
 * Check if a directive exists for the given job ID without loading it.
 * Used by the assembly path to decide whether to use directive chrome or
 * fall through to the legacy Fix 5/7 reactive chrome state machine.
 *
 * @param {string} jobId
 * @returns {boolean}
 */
function hasDirectiveForJob(jobId) {
  if (!jobId) return false;
  const filePath = path.join(DIRECTIVES_DIR, `${jobId}.json`);
  return fs.existsSync(filePath);
}

/**
 * Extract the human-readable spoken text from a directive object.
 * This is what gets pasted into the dashboard script textarea — operators
 * see only the words Bobby G speaks, no chrome metadata, no JSON.
 *
 * Format: each avatar scene becomes a block separated by === {scene.id} ===
 * markers (matching the existing plain-text format that parseSegments_v2 expects).
 * source_clip scenes become === {scene.id} ===\n[CLIP PLAYS HERE] blocks.
 *
 * @param {object} directive - Validated directive object
 * @returns {string} - Plain text script suitable for the dashboard textarea
 */
function extractSpokenTextFromDirective(directive) {
  if (!directive || !Array.isArray(directive.scenes)) return '';
  return directive.scenes.map(scene => {
    if (scene.type === 'source_clip') {
      return `=== ${scene.id} ===\n[CLIP PLAYS HERE]`;
    }
    return `=== ${scene.id} ===\n${scene.spokenText || ''}`;
  }).join('\n\n');
}

/**
 * Prune directive files older than 7 days. Called on server startup.
 * Keeps the directives directory from growing forever.
 */
function pruneOldDirectives() {
  if (!fs.existsSync(DIRECTIVES_DIR)) return;
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (const fname of fs.readdirSync(DIRECTIVES_DIR)) {
    if (!fname.endsWith('.json')) continue;
    const fpath = path.join(DIRECTIVES_DIR, fname);
    try {
      const stat = fs.statSync(fpath);
      if (stat.mtimeMs < sevenDaysAgo) {
        fs.unlinkSync(fpath);
        pruned++;
      }
    } catch (e) {
      // Skip files we can't stat
    }
  }
  if (pruned > 0) {
    console.log(`[directives] Pruned ${pruned} directive file(s) older than 7 days`);
  }
}

module.exports = {
  writeDirectiveForJob,
  loadDirectiveForJob,
  hasDirectiveForJob,
  extractSpokenTextFromDirective,
  pruneOldDirectives,
  DIRECTIVES_DIR
};
