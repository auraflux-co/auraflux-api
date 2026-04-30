'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'AuraFlux'],
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
    record_sql: 'obfuscated',
  },
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },
  custom_insights_events: { enabled: true },
  slow_sql: { enabled: true },
};
