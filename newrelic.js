'use strict';

// Resolve app name defensively — New Relic v14 throws if the resolved name is
// an empty string, even when the config file provides a fallback, because its
// internal env-var reader can override the config with a blank value.
const _appName =
  (process.env.NEW_RELIC_APP_NAME || '').trim() || 'AuraFlux API';
const _licenseKey = (process.env.NEW_RELIC_LICENSE_KEY || '').trim();

exports.config = {
  app_name: [_appName],
  license_key: _licenseKey,
  agent_enabled: !!_licenseKey,
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
    record_sql: 'obfuscated',
  },
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },
  custom_insights_events: { enabled: true },
  slow_sql: { enabled: true },
};
