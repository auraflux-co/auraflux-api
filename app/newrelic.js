'use strict';

/**
 * New Relic APM config for auraflux-app (Next.js)
 * CPD-177 — mirrors the API agent config in /newrelic.js
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'AuraFlux-App'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  agent_enabled: !!process.env.NEW_RELIC_LICENSE_KEY,
  distributed_tracing: { enabled: true },
  host: 'collector.newrelic.com',
  port: 443,
  ssl: true,
  logging: {
    level: 'info',
    filepath: 'stdout',
  },
  allow_all_headers: true,
  application_logging: {
    forwarding: { enabled: true },
    local_decorating: { enabled: false },
  },
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 'apdex_f',
    record_sql: 'off',
  },
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },
  custom_insights_events: { enabled: true },
  slow_sql: { enabled: false },
};
