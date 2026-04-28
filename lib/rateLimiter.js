'use strict';
/**
 * lib/rateLimiter.js — AuraFlux rate limiting middleware (CPD-29).
 *
 * Tiered limits by endpoint sensitivity:
 *   - strict:  AI generation / video assembly — expensive compute, low abuse tolerance
 *   - api:     General API calls — standard protection
 *   - publish: Publish actions — moderate, but costs money per call
 *   - webhook: Jira/inbound webhooks — generous but bounded
 *   - health:  /health — effectively unlimited (monitoring tools)
 *
 * All limits are per-IP, sliding window.
 * In production (NODE_ENV=production), limits are enforced.
 * In development/test, limits are logged but not blocked (skip: true).
 *
 * Override any window/max with env vars:
 *   RATE_LIMIT_STRICT_MAX, RATE_LIMIT_API_MAX, RATE_LIMIT_PUBLISH_MAX
 */

const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';

function makeLimit({ windowMs, max, name, skip = false }) {
  return rateLimit({
    windowMs,
    max: parseInt(process.env[`RATE_LIMIT_${name.toUpperCase()}_MAX`] || String(max), 10),
    standardHeaders: true,   // Return RateLimit-* headers
    legacyHeaders: false,
    skip: isDev ? () => { return false; } : undefined,
    handler: (req, res) => {
      console.warn(`[rate-limit] ${name} limit hit — ip=${req.ip} path=${req.path}`);
      res.status(429).json({
        ok: false,
        error: 'Too many requests — please slow down',
        retryAfter: Math.ceil(windowMs / 1000),
        limit: name,
      });
    },
    keyGenerator: (req) => {
      // Trust Cloudflare CF-Connecting-IP over X-Forwarded-For
      return req.headers['cf-connecting-ip'] || req.ip;
    },
  });
}

// ── Limit tiers ───────────────────────────────────────────────────────────────

/**
 * Strict: AI generation, video assembly, thumbnail generation.
 * Max 10 requests / 1 minute per IP.
 * Prevents runaway compute costs from a single bad actor.
 */
const strictLimit = makeLimit({ windowMs: 60_000, max: 10, name: 'strict' });

/**
 * Publish: /publish, /generate-publish-copy, Upload-Post proxy calls.
 * Max 20 requests / 1 minute per IP.
 */
const publishLimit = makeLimit({ windowMs: 60_000, max: 20, name: 'publish' });

/**
 * API: General job control, status checks, gate management.
 * Max 120 requests / 1 minute per IP (2 req/s).
 */
const apiLimit = makeLimit({ windowMs: 60_000, max: 120, name: 'api' });

/**
 * Webhook: Jira webhook, admin triggers.
 * Max 30 requests / 1 minute per IP — generous but bounded.
 */
const webhookLimit = makeLimit({ windowMs: 60_000, max: 30, name: 'webhook' });

/**
 * Health: /health endpoint — effectively unlimited for monitoring tools.
 * Max 300 requests / 1 minute per IP (5 req/s).
 */
const healthLimit = makeLimit({ windowMs: 60_000, max: 300, name: 'health' });

module.exports = {
  strictLimit,
  publishLimit,
  apiLimit,
  webhookLimit,
  healthLimit,
};
