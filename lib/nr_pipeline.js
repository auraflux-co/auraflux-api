'use strict';
/**
 * Fire-and-forget New Relic custom insights events for end-to-end pipeline tracing.
 * Safe when newrelic is not loaded (e.g. unit tests, poller without agent).
 *
 * NRQL: query each event type as a table (e.g. ScriptGenerationComplete).
 * Every event that includes `jobId` also gets `canonicalJobId` (script_* when linked
 * from a semantic row) so NRQL can group one run without knowing which id the caller used.
 */

const { resolveCanonicalJobId } = require('./db');

function nrPipelineEvent(eventType, attributes = {}) {
  try {
    if (typeof newrelic !== 'undefined') {
      const attrs = { ...attributes };
      if (attrs.jobId && typeof attrs.jobId === 'string') {
        attrs.canonicalJobId = resolveCanonicalJobId(attrs.jobId);
      }
      newrelic.recordCustomEvent(eventType, {
        timestamp: Date.now(),
        env: process.env.NODE_ENV || 'development',
        service: process.env.NR_PIPELINE_SERVICE || 'auraflux-api',
        ...attrs,
      });
    }
  } catch (_e) {
    /* non-fatal */
  }
}

module.exports = { nrPipelineEvent };
