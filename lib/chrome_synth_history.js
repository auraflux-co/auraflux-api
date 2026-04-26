'use strict';
/**
 * lib/chrome_synth_history.js
 *
 * Tracks synth assembly verification results keyed by a SHA-1 hash of the
 * chrome config block (designSpec.chrome). Once a given overlay has been
 * successfully verified N times (default 3, configurable per customer via
 * customerConfig.chrome.synthVerifyThreshold), the prebuild synth check is
 * skipped for all subsequent jobs that share the same chrome fingerprint.
 *
 * History file: data/chrome_synth_history.json
 * Schema per entry:
 * {
 *   hash:          string   — SHA-1 of chrome config
 *   customerId:    string
 *   contentType:   string   — first content type that verified this hash
 *   successCount:  number
 *   threshold:     number   — N needed to skip future runs
 *   firstVerified: ISO-8601
 *   lastVerified:  ISO-8601
 *   lastJobId:     string
 *   lastOutputMb:  number   — file size of last successful synth output
 *   lastOutputPath: string | null — last synth assembly MP4 (for preview frames when synth is skipped)
 * }
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const HISTORY_PATH = path.join(__dirname, '..', 'data', 'chrome_synth_history.json');
const DEFAULT_THRESHOLD = 3;

// ── file I/O ─────────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return {};
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (e) {
    console.warn('[chrome_synth_history] Could not load history file:', e.message);
    return {};
  }
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (e) {
    console.warn('[chrome_synth_history] Could not save history file:', e.message);
  }
}

// ── hash ──────────────────────────────────────────────────────────────────────

/**
 * Produce a stable fingerprint for a chrome config object.
 * Only hashes the fields that actually affect rendered output.
 */
function chromeFingerprintHash(chrome) {
  const relevant = {
    templateFile:  chrome.templateFile  || null,
    skin:          chrome.skin          || null,
    accentColor:   chrome.accentColor   || null,
    accentColor2:  chrome.accentColor2  || null,
    showName:      chrome.showName      || null,
    categoryLabel: chrome.categoryLabel || null,
    logoPosition:  chrome.logoPosition  || null,
    logoSize:      chrome.logoSize      || null,
    layout:        chrome.layout        || null,
  };
  return crypto.createHash('sha1')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 12); // 12 hex chars — enough uniqueness, readable in logs
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if this chrome config has been verified enough times to skip synth.
 */
function shouldSkipSynth(chrome, customerId = 'c0', threshold = DEFAULT_THRESHOLD) {
  if (!chrome || typeof chrome !== 'object') return false;
  const hash    = chromeFingerprintHash(chrome);
  const history = loadHistory();
  const entry   = history[hash];
  if (!entry) return false;
  const needed = entry.threshold ?? threshold;
  return entry.successCount >= needed;
}

/**
 * Record a successful synth verification for this chrome config.
 */
function recordSuccess({ chrome, customerId = 'c0', contentType = 'unknown', jobId = '', outputMb = 0, threshold = DEFAULT_THRESHOLD }) {
  if (!chrome || typeof chrome !== 'object') return;
  const hash    = chromeFingerprintHash(chrome);
  const history = loadHistory();
  const now     = new Date().toISOString();
  const existing = history[hash] || {
    hash,
    customerId,
    contentType,
    successCount:  0,
    threshold,
    firstVerified: now,
    lastVerified:  null,
    lastJobId:     null,
    lastOutputMb:  null
  };
  existing.successCount  = (existing.successCount || 0) + 1;
  existing.lastVerified  = now;
  existing.lastJobId     = jobId;
  existing.lastOutputMb  = outputMb;
  history[hash] = existing;
  saveHistory(history);
  return existing;
}

/**
 * Reset the success count for a chrome config (e.g. after a chrome code change).
 * Called automatically when hash is not found — effectively a no-op for new hashes.
 */
function resetEntry(chrome) {
  if (!chrome || typeof chrome !== 'object') return;
  const hash    = chromeFingerprintHash(chrome);
  const history = loadHistory();
  delete history[hash];
  saveHistory(history);
}

/**
 * Return the full history entry for a chrome config, or null if unseen.
 */
function getEntry(chrome) {
  if (!chrome || typeof chrome !== 'object') return null;
  const hash = chromeFingerprintHash(chrome);
  return loadHistory()[hash] || null;
}

// ── Resolved-layout hash (customer JSON + content-type overrides) ───────────
// Prefer these for gate3a — they track the same fields FFmpeg burn uses.

function getEntryForHash(hash) {
  if (!hash || typeof hash !== 'string') return null;
  return loadHistory()[hash] || null;
}

function shouldSkipSynthForHash(hash, threshold = DEFAULT_THRESHOLD) {
  const entry = getEntryForHash(hash);
  if (!entry) return false;
  const needed = entry.threshold ?? threshold;
  return entry.successCount >= needed;
}

/**
 * @param {string} hash — from fingerprintResolvedChromeCfg()
 * @param {object} opts
 */
function recordSuccessForHash(hash, {
  customerId = 'c0',
  contentType = 'unknown',
  jobId = '',
  outputMb = 0,
  threshold = DEFAULT_THRESHOLD,
  lastOutputPath = null
} = {}) {
  if (!hash || typeof hash !== 'string') return;
  const history = loadHistory();
  const now = new Date().toISOString();
  const existing = history[hash] || {
    hash,
    customerId,
    contentType,
    successCount: 0,
    threshold,
    firstVerified: now,
    lastVerified: null,
    lastJobId: null,
    lastOutputMb: null,
    lastOutputPath: null
  };
  existing.successCount = (existing.successCount || 0) + 1;
  existing.lastVerified = now;
  existing.lastJobId = jobId;
  existing.lastOutputMb = outputMb;
  if (lastOutputPath) existing.lastOutputPath = lastOutputPath;
  history[hash] = existing;
  saveHistory(history);
  return existing;
}

function resetEntryForHash(hash) {
  if (!hash || typeof hash !== 'string') return;
  const history = loadHistory();
  delete history[hash];
  saveHistory(history);
}

module.exports = {
  chromeFingerprintHash,
  shouldSkipSynth,
  recordSuccess,
  resetEntry,
  getEntry,
  getEntryForHash,
  shouldSkipSynthForHash,
  recordSuccessForHash,
  resetEntryForHash,
  DEFAULT_THRESHOLD
};
