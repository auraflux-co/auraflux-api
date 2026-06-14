/**
 * AuraFlux Structured Error Logger
 *
 * Provides:
 *   - Structured JSON error logging to logs/errors.jsonl
 *   - Retry logic with exponential backoff for external API calls
 *   - Fallback image helper for broken story images
 *   - Error rate monitoring (rolling 5-minute window)
 *
 * Usage:
 *   const { logError, withRetry, getFallbackImage, getErrorRate } = require('./lib/error_logger');
 *
 *   // Log an error
 *   logError('ESPN_FETCH', err, { url, attempt: 1 });
 *
 *   // Retry an async function up to 3 times with backoff
 *   const data = await withRetry(() => fetch(url), { label: 'ESPN_FETCH', retries: 3 });
 *
 *   // Get a fallback image URL if story image is broken
 *   const imgUrl = getFallbackImage(story.image, story.category);
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, '../logs');
const ERROR_LOG = path.join(LOG_DIR, 'errors.jsonl');
const MAX_LOG_SIZE_MB = 10; // Rotate when log exceeds 10MB

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Error Rate Monitoring ───────────────────────────────────────────────────

const errorWindow = []; // Rolling array of { ts, label }
const WINDOW_MS = 5 * 60 * 1000; // 5-minute window

function recordError(label) {
  const now = Date.now();
  errorWindow.push({ ts: now, label });
  // Prune old entries
  while (errorWindow.length > 0 && errorWindow[0].ts < now - WINDOW_MS) {
    errorWindow.shift();
  }
}

/**
 * Get error rate stats for the last 5 minutes.
 * @returns {{ total: number, byLabel: Object, windowMs: number }}
 */
function getErrorRate() {
  const now = Date.now();
  const recent = errorWindow.filter((e) => e.ts >= now - WINDOW_MS);
  const byLabel = {};
  recent.forEach((e) => {
    byLabel[e.label] = (byLabel[e.label] || 0) + 1;
  });
  return { total: recent.length, byLabel, windowMs: WINDOW_MS };
}

// ── Log Rotation ────────────────────────────────────────────────────────────

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(ERROR_LOG)) return;
    const stats = fs.statSync(ERROR_LOG);
    if (stats.size > MAX_LOG_SIZE_MB * 1024 * 1024) {
      const rotated = ERROR_LOG.replace('.jsonl', `_${Date.now()}.jsonl`);
      fs.renameSync(ERROR_LOG, rotated);
      console.log(`[error_logger] Rotated log to ${path.basename(rotated)}`);
    }
  } catch (e) {
    // Non-fatal — don't crash on log rotation failure
  }
}

// ── Core Logger ─────────────────────────────────────────────────────────────

/**
 * Log a structured error entry to logs/errors.jsonl
 *
 * @param {string} label       - Short identifier e.g. 'ESPN_FETCH', 'PUPPETEER_TIMEOUT'
 * @param {Error|string} err   - The error object or message
 * @param {Object} [context]   - Additional context (url, attempt, endpoint, etc.)
 */
function logError(label, err, context = {}) {
  recordError(label);
  rotateIfNeeded();

  const entry = {
    ts: new Date().toISOString(),
    label,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    context,
  };

  try {
    fs.appendFileSync(ERROR_LOG, JSON.stringify(entry) + '\n');
  } catch (writeErr) {
    // Fallback to console if file write fails
    console.error('[error_logger] Failed to write log:', writeErr.message);
  }

  // Always echo to console as well
  console.error(`[${label}] ${entry.message}`, context);
}

// ── Retry with Exponential Backoff ──────────────────────────────────────────

/**
 * Retry an async function with exponential backoff.
 *
 * @param {Function} fn          - Async function to retry: () => Promise<T>
 * @param {Object} [options]
 * @param {string} [options.label]    - Label for error logging (default: 'RETRY')
 * @param {number} [options.retries]  - Max retry attempts (default: 3)
 * @param {number} [options.baseMs]   - Base delay in ms (default: 500)
 * @param {number} [options.maxMs]    - Max delay cap in ms (default: 10000)
 * @param {Function} [options.onRetry] - Called on each retry: (attempt, err) => void
 * @returns {Promise<T>}
 */
async function withRetry(fn, options = {}) {
  const { label = 'RETRY', retries = 3, baseMs = 500, maxMs = 10000, onRetry = null } = options;

  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt > retries) break;

      const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
      logError(label, err, { attempt, retriesLeft: retries - attempt + 1, delayMs: delay });

      if (onRetry) onRetry(attempt, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // All retries exhausted — log final failure
  logError(`${label}_EXHAUSTED`, lastErr, { totalAttempts: retries + 1 });
  throw lastErr;
}

// ── Fallback Images ─────────────────────────────────────────────────────────

// Category → fallback image path (served from /assets/)
const FALLBACK_IMAGES = {
  sports: '/assets/fallback_sports.jpg',
  nba: '/assets/fallback_nba.jpg',
  nfl: '/assets/fallback_nfl.jpg',
  news: '/assets/fallback_news.jpg',
  politics: '/assets/fallback_news.jpg',
  technology: '/assets/fallback_tech.jpg',
  entertainment: '/assets/fallback_entertainment.jpg',
  default: '/assets/fallback_default.jpg',
};

/**
 * Return a fallback image URL if the provided URL is missing/broken.
 *
 * @param {string|null} imageUrl  - Original image URL (may be null/undefined)
 * @param {string} [category]     - Content category for category-specific fallback
 * @returns {string}              - Valid image URL (original or fallback)
 */
function getFallbackImage(imageUrl, category = 'default') {
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
    return imageUrl;
  }
  const cat = (category || 'default').toLowerCase();
  return FALLBACK_IMAGES[cat] || FALLBACK_IMAGES.default;
}

/**
 * Validate an image URL by making a HEAD request.
 * Returns the original URL if valid, fallback if not.
 *
 * @param {string} imageUrl
 * @param {string} [category]
 * @returns {Promise<string>}
 */
async function validateImageUrl(imageUrl, category = 'default') {
  if (!imageUrl) return getFallbackImage(null, category);

  return new Promise((resolve) => {
    try {
      const lib = imageUrl.startsWith('https') ? require('https') : require('http');
      const req = lib.request(imageUrl, { method: 'HEAD', timeout: 3000 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve(imageUrl);
        } else {
          logError('IMAGE_VALIDATION', `HTTP ${res.statusCode}`, { imageUrl, category });
          resolve(getFallbackImage(null, category));
        }
      });
      req.on('error', (err) => {
        logError('IMAGE_VALIDATION', err, { imageUrl, category });
        resolve(getFallbackImage(null, category));
      });
      req.on('timeout', () => {
        req.destroy();
        logError('IMAGE_VALIDATION_TIMEOUT', 'HEAD request timed out', { imageUrl, category });
        resolve(getFallbackImage(null, category));
      });
      req.end();
    } catch (err) {
      logError('IMAGE_VALIDATION', err, { imageUrl, category });
      resolve(getFallbackImage(null, category));
    }
  });
}

// ── Express Middleware ───────────────────────────────────────────────────────

/**
 * Express error middleware — attach to app with app.use(errorMiddleware)
 * Logs all unhandled Express errors to the structured log.
 */
function errorMiddleware(err, req, res, next) {
  logError('EXPRESS_UNHANDLED', err, {
    method: req.method,
    url: req.url,
    body: req.body,
  });
  res.status(500).json({ ok: false, error: 'Internal server error', label: 'EXPRESS_UNHANDLED' });
}

/**
 * Get recent errors from the log file (last N lines).
 * @param {number} [n=50]
 * @returns {Array<Object>}
 */
function getRecentErrors(n = 50) {
  try {
    if (!fs.existsSync(ERROR_LOG)) return [];
    const lines = fs.readFileSync(ERROR_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch (err) {
    return [];
  }
}

module.exports = {
  logError,
  withRetry,
  getFallbackImage,
  validateImageUrl,
  getErrorRate,
  getRecentErrors,
  errorMiddleware,
  ERROR_LOG,
};
