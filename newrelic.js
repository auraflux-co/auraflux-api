'use strict';
/**
 * New Relic agent configuration — AuraFlux API
 *
 * All values can be overridden by environment variables.
 * The license key and app name MUST be set on Render:
 *   NEW_RELIC_LICENSE_KEY  (Settings → Environment)
 *   NEW_RELIC_APP_NAME     (Settings → Environment)
 *
 * Docs: https://docs.newrelic.com/docs/agents/nodejs-agent/installation-configuration/nodejs-agent-configuration
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'AuraFlux'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY || '',

  logging: {
    // 'info' reduces log noise on Render; 'debug' for troubleshooting NR itself
    level: 'info',
    // Write to stdout so Render captures it (no file system path needed)
    filepath: 'stdout',
  },

  // Distributed tracing — links NR spans across async portal calls
  distributed_tracing: {
    enabled: true,
  },

  // Capture full error details including stack trace for unhandled rejections
  error_collector: {
    enabled: true,
    ignore_status_codes: [404, 401, 403],
  },

  // Transaction tracing — captures slow requests (> 4s) automatically
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 4000, // ms
    record_sql: 'obfuscated', // never log raw SQL with user data
  },

  // Custom attributes on transactions (jobId, portal, etc. added via nrEvent)
  custom_insights_events: {
    enabled: true,
    max_samples_stored: 10000,
  },

  // Disable browser monitoring injection (we're a pure API, no HTML)
  browser_monitoring: {
    enable: false,
  },

  // Allow the agent to attach custom attributes from nrPipelineEvent calls
  allow_all_headers: true,
  attributes: {
    enabled: true,
  },
};
