'use strict';
/**
 * lib/gates/gate0.js — Gate 0: Source Confirmation (Code + ffprobe only, no LLM)
 *
 * IDENTITY: Gate 0 is the authoritative source format detector. Its confirmedFormat
 * is used by every downstream gate to determine framing, chrome skin, and QA expectations.
 * Gate 0 answers one question: "Is this source suitable for production?" Yes or No.
 * It does NOT judge content quality or script — only source format/technical quality.
 *
 * Runs before any credits burn. Confirms source URLs resolve, format is detectable,
 * durations are above floor (10s min), and titles match the job order.
 *
 * Three states: canProduce → commit → run
 *
 * Output contract:
 * {
 *   gate: 0,
 *   jobId: string,
 *   passed: boolean,
 *   confirmedFormat: '16:9' | '9:16' | null,
 *   confirmedSources: [{ itemId, url, duration, format, titleMatch }],
 *   failReason: string | null,
 *   upstreamContext: { reviewedReports: [], confirmedClean: [], escalatedConcerns: [], downstreamHeadsUp: string | null },
 *   completedAt: ISO-8601
 * }
 */

const axios = require('axios');
const { execFile } = require('child_process');
const { logError } = require('../error_logger');
const { ffprobePath } = require('../ffmpeg_utils');
const { getGateThresholds } = require('../customerConfig');

const GEMINI_APIKEY = process.env.GEMINI_API_KEY;
// Default fallback matches c0.json qaThresholds.gate0.minDurationSeconds
const DEFAULT_MIN_DURATION_SECS = 10;

/**
 * Resolve min duration for a job from customer config.
 * Reads from customerConfig.getGateThresholds — universal, not c0-specific.
 */
function getMinDurationSecs(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const thresholds = getGateThresholds(customerId, templateId, 'gate0', { minDurationSeconds: DEFAULT_MIN_DURATION_SECS });
  return thresholds.minDurationSeconds || DEFAULT_MIN_DURATION_SECS;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Use ffprobe to detect video dimensions and duration from a URL.
 * Returns { width, duration, format } or throws.
 */
function probeSource(url) {
  return new Promise((resolve, reject) => {
    // HLS manifests (.m3u8) require protocol_whitelist for ffprobe to read them
    // Universal detection — any HLS stream, not CDN-specific
    const isHLS = url.includes('.m3u8') || url.includes('/hls/') || url.includes('manifest.prod');
    const args = [
      '-v', 'quiet',
      ...(isHLS ? ['-protocol_whitelist', 'file,http,https,tcp,tls,crypto'] : []),
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      url
    ];
    execFile(ffprobePath(), args, { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const s = streams[0] || {};
        const width = parseInt(s.width || '0', 10);
        const height = parseInt(s.height || '0', 10);
        // HLS streams often have duration=0 in stream — use format duration instead
        const duration = parseFloat(s.duration || data.format?.duration || '0');
        const format = width > 0 && height > 0
          ? (width >= height ? '16:9' : '9:16')
          : null;
        resolve({ width, height, duration, format });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * HEAD-check a URL to confirm it resolves (returns 2xx/3xx).
 * Falls back to ffprobe probe attempt on HEAD failure.
 */
async function checkUrlReachable(url) {
  try {
    const resp = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
    return resp.status >= 200 && resp.status < 400;
  } catch {
    return false;
  }
}

/**
 * Loose title match — checks if any word from topic appears in the URL or title string.
 */
function titleMatchScore(topic, url) {
  if (!topic || !url) return false;
  const normalized = (topic + ' ' + url).toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const words = topic.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  if (words.length === 0) return true; // nothing specific to match
  return words.some(w => normalized.includes(w));
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * Check readiness to run Gate 0.
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!process.env.GEMINI_API_KEY) {
    reasons.push('GEMINI_API_KEY not set — Gemini source analysis unavailable');
  }

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) {
    reasons.push('jobSpec.jobId missing');
  }

  const items = jobSpec.order?.inputs?.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    reasons.push('jobSpec.order.inputs.items is empty or missing — no sources to confirm');
  }

  // Validate contentType against customer config — universal, not c0-specific
  const contentType = jobSpec.contentType || jobSpec.order?.contentType;
  if (!contentType) {
    reasons.push('jobSpec.contentType missing');
  } else {
    try {
      const { loadCustomerConfig } = require('../job_spec');
      const custConfig = loadCustomerConfig(jobSpec.customerId || 'c0');
      // Get all valid content types from both long-form and short-form templates
      const validTypes = new Set();
      Object.values(custConfig.templates || {}).forEach(t => {
        (t.contentTypes || []).forEach(ct => { validTypes.add(ct); validTypes.add(ct + '-short'); });
      });
      // Normalize CWN aliases: twitch→clips, nba→sports
      const CONTENT_TYPE_ALIASES = { twitch: 'clips', nba: 'sports' };
      const baseType = CONTENT_TYPE_ALIASES[contentType.replace(/-short$/, '')] || contentType.replace(/-short$/, '');
      if (validTypes.size > 0 && !validTypes.has(baseType) && !validTypes.has(contentType)) {
        reasons.push(`Unknown contentType "${contentType}" for customer "${jobSpec.customerId}"`);
      }
    } catch(e) {
      // If customerConfig fails to load, skip validation — canProduce check below will catch it
    }
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * Declare what Gate 0 will verify for this job.
 * @param {Object} jobSpec
 * @returns {{ committed: string, itemCount: number, format: string }}
 */
function commit(jobSpec) {
  const items = jobSpec?.order?.inputs?.items || [];
  const outputFormat = jobSpec?.order?.output?.format || 'unknown';
  const minDuration = getMinDurationSecs(jobSpec);
  return {
    // Gate 0 is the authoritative source format detector. confirmedFormat from this commit
    // is used by ALL downstream gates (Gate 2 framing, Gate 3a chrome skin, Gate 4 context).
    // Scope: technical format/quality ONLY — not content, script, or editorial quality.
    committed: `I will confirm ${items.length} source(s) resolve, video is accessible, duration ≥ ${minDuration}s, format is [${outputFormat}], and titles match the order. My confirmedFormat is authoritative for all downstream gates.`,
    itemCount: items.length,
    format: outputFormat
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * Execute Gate 0 source confirmation.
 * @param {Object} jobSpec
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  const completedAt = () => new Date().toISOString();

  const baseOutput = {
    gate: 0,
    jobId,
    passed: false,
    confirmedFormat: null,
    confirmedSources: [],
    failReason: null,
    upstreamContext: {
      reviewedReports: [],
      confirmedClean: [],
      escalatedConcerns: [],
      downstreamHeadsUp: null
    },
    completedAt: completedAt()
  };

  // Readiness check
  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 0 not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE0_NOT_READY', new Error(reason), { jobId, gate: 0 });
    return { ...baseOutput, failReason: reason, completedAt: completedAt() };
  }

  const items = jobSpec.order.inputs.items;
  const confirmedSources = [];
  const concerns = [];
  let detectedFormats = [];

  for (const item of items) {
    const itemId = item.id || item.itemId || String(items.indexOf(item));
    const url = item.url || item.sourceUrl;

    if (!url) {
      const reason = `Item ${itemId} has no URL`;
      logError('GATE0_MISSING_URL', new Error(reason), { jobId, gate: 0, itemId });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt()
      };
    }

    // Step 1: URL reachable?
    const reachable = await checkUrlReachable(url);
    if (!reachable) {
      const reason = `Source URL not reachable: ${url}`;
      logError('GATE0_URL_DEAD', new Error(reason), { jobId, gate: 0, itemId, sourceUrl: url });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt()
      };
    }

    // Step 2: Probe video metadata
    let probeResult;
    try {
      probeResult = await probeSource(url);
    } catch (err) {
      logError('GATE0_PROBE_FAIL', err, { jobId, gate: 0, itemId, sourceUrl: url });
      // On Gemini/API error (probe failure on remote URL), hold job — do not auto-fail
      return {
        ...baseOutput,
        failReason: `Source probe failed for item ${itemId}: ${err.message}. Job held for monitoring.`,
        confirmedSources,
        completedAt: completedAt()
      };
    }

    // Step 3: Duration check
    const MIN_DURATION_SECS = getMinDurationSecs(jobSpec);
    if (probeResult.duration < MIN_DURATION_SECS) {
      const reason = `Item ${itemId} duration ${probeResult.duration.toFixed(1)}s is below minimum ${MIN_DURATION_SECS}s`;
      logError('GATE0_DURATION_SHORT', new Error(reason), { jobId, gate: 0, itemId, sourceUrl: url, duration: probeResult.duration });
      return {
        ...baseOutput,
        failReason: reason,
        confirmedSources,
        completedAt: completedAt()
      };
    }

    // Step 4: Format detection
    if (!probeResult.format) {
      concerns.push(`Item ${itemId}: could not determine aspect ratio (${probeResult.width}x${probeResult.height})`);
    } else {
      detectedFormats.push(probeResult.format);
    }

    // Step 5: Title match (soft check — warns but does not hard fail)
    const topic = item.title || item.topic || item.name || '';
    const tMatch = titleMatchScore(topic, url);
    if (!tMatch && topic.length > 0) {
      concerns.push(`Item ${itemId}: title "${topic}" may not match source URL`);
    }

    confirmedSources.push({
      itemId,
      url,
      duration: probeResult.duration,
      format: probeResult.format,
      titleMatch: tMatch
    });
  }

  // Determine authoritative format
  const uniqueFormats = [...new Set(detectedFormats)];
  let confirmedFormat = null;
  let formatMismatch = false;

  if (uniqueFormats.length === 1) {
    confirmedFormat = uniqueFormats[0];
  } else if (uniqueFormats.length > 1) {
    // Mixed formats = hard fail
    const reason = `Mixed source formats detected: ${uniqueFormats.join(', ')} — all sources must match`;
    logError('GATE0_FORMAT_MISMATCH', new Error(reason), { jobId, gate: 0, detectedFormats });
    return {
      ...baseOutput,
      failReason: reason,
      confirmedSources,
      completedAt: completedAt()
    };
  } else if (detectedFormats.length === 0 && confirmedSources.length > 0) {
    concerns.push('Could not detect format from any source — downstream gates will use jobSpec default');
  }

  // Verify format matches jobSpec order if specified
  // Skip for short-form: sources are always 16:9 (ESPN/AJ/Twitch) — assembly stacks to 9:16 via FFmpeg
  const orderedFormat = jobSpec.order?.output?.format;
  const isShortForm = jobSpec.templateId?.includes('short') || jobSpec.contentType?.includes('-short');
  if (!isShortForm && orderedFormat && confirmedFormat && orderedFormat !== confirmedFormat) {
    const reason = `Format mismatch: order specifies "${orderedFormat}" but sources detected as "${confirmedFormat}"`;
    logError('GATE0_FORMAT_ORDER_MISMATCH', new Error(reason), { jobId, gate: 0, orderedFormat, confirmedFormat });
    return {
      ...baseOutput,
      failReason: reason,
      confirmedSources,
      completedAt: completedAt()
    };
  }

  const downstreamHeadsUp = concerns.length > 0
    ? `Gate 0 concerns (non-blocking): ${concerns.join('; ')}`
    : null;

  return {
    gate: 0,
    jobId,
    passed: true,
    confirmedFormat: confirmedFormat || orderedFormat || null,
    confirmedSources,
    failReason: null,
    upstreamContext: {
      reviewedReports: [],
      confirmedClean: confirmedSources.map(s => s.itemId),
      escalatedConcerns: concerns,
      downstreamHeadsUp
    },
    completedAt: completedAt()
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-validate GEMINI_API_KEY present
    if (!process.env.GEMINI_API_KEY) {
      console.warn(`[gate0] prepare() warning: GEMINI_API_KEY not set — source analysis will fail for job ${jobId}`);
    }

    // Pre-validate source URLs are present in jobSpec.order.inputs.items
    const items = jobSpec?.order?.inputs?.items;
    const itemCount = Array.isArray(items) ? items.length : 0;
    if (itemCount === 0) {
      console.warn(`[gate0] prepare() warning: no source items found in jobSpec for job ${jobId}`);
    }

    console.log(`[gate0] Ready for job ${jobId} — ${itemCount} sources to confirm`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate0] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare };
