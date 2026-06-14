/**
 * lib/logger.js — AuraFlux structured logger (Pino).
 *
 * Central logger for all pipeline modules.
 * Provides structured JSON logging in production, pretty-print in dev.
 *
 * Usage (module-level):
 *   const logger = require('./logger');
 *   logger.info({ jobId, stage: 'gate1' }, 'Portal 1 passed');
 *   logger.error({ gate: 1, score: 45 }, 'Portal 1 hard fail');
 *
 * Usage (request-scoped child logger — carries req.id through):
 *   const log = require('./logger').child({ reqId: req.id });
 *   log.info({ jobId }, 'Processing job');
 *
 * Log levels (set via LOG_LEVEL env var):
 *   trace | debug | info (default) | warn | error | fatal
 *
 * In production (Render): JSON output consumed by New Relic log forwarding.
 * In development: colorized pretty-print via pino-pretty.
 */

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: {
    service: 'auraflux-api',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname,service,env',
          },
        }
      : undefined,
});

module.exports = logger;
