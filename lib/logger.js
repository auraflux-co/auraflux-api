/**
 * lib/logger.js
 * 
 * Shared Pino logger for all CWN pipeline modules.
 * Provides structured logging with levels, timestamps, and pretty-printing in dev.
 * 
 * Usage:
 *   const logger = require('./logger');
 *   logger.info({ jobId, stage: 'gate1' }, 'Gate 1 passed');
 *   logger.error({ gate: 1, score: 45, directive: 'REGENERATE_SCRIPT' }, 'Gate 1 hard fail');
 */

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { 
        target: 'pino-pretty', 
        options: { 
          colorize: true, 
          translateTime: 'SYS:standard', 
          ignore: 'pid,hostname' 
        } 
      }
    : undefined
});

module.exports = logger;
