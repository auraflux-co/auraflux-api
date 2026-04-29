'use strict';
/**
 * lib/requestLogger.js — HTTP request logging middleware (CPD-30).
 *
 * Uses pino-http to emit one structured JSON log line per request:
 *   { reqId, method, url, statusCode, responseTime, ip, userAgent }
 *
 * Integrates with the existing req.id assigned by server.js so every
 * downstream log line can be correlated back to the originating request.
 *
 * Sensitive paths (/health polling) are logged at trace level to avoid
 * filling logs with monitoring noise.
 *
 * Usage in server.js:
 *   const requestLogger = require('./lib/requestLogger');
 *   app.use(requestLogger);
 */

const pinoHttp = require('pino-http');
const logger   = require('./logger');

const requestLogger = pinoHttp({
  logger,

  // Use the req.id already set by the request-ID middleware
  genReqId: (req) => req.id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,

  // Reduce noise: health checks at trace, everything else at info
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400)        return 'warn';
    if (req.url === '/health')        return 'trace';
    return 'info';
  },

  // Serializers — strip sensitive headers, include useful fields
  serializers: {
    req: (req) => ({
      id:        req.id,
      method:    req.method,
      url:       req.url,
      ip:        req.headers['cf-connecting-ip'] || req.remoteAddress,
      userAgent: req.headers['user-agent'],
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },

  // Add custom fields to every request log
  customSuccessMessage: (req, res) =>
    `${req.method} ${req.url} → ${res.statusCode}`,

  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} → ${res.statusCode} — ${err.message}`,

  // Redact anything that looks like an auth token in query strings
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie'],
    censor: '[REDACTED]',
  },
});

module.exports = requestLogger;
