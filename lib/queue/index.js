'use strict';
/**
 * lib/queue/index.js — BullMQ job queue (CPD-324)
 *
 * Replaces the fragile in-process setImmediate pattern in jobs_c1.js.
 * Jobs are stored in Redis so they survive server restarts and deploys.
 *
 * Queue name: 'pipeline'
 * Job data:   { jobSpec, meta: { submittedAt, customerId } }
 *
 * Usage:
 *   const { pipelineQueue } = require('./queue');
 *   await pipelineQueue.add(jobSpec.jobId, { jobSpec });
 */

const { Queue, Worker, QueueEvents } = require('bullmq');

const QUEUE_NAME = 'pipeline';

// ── Connection config ──────────────────────────────────────────────────────────

function redisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set — cannot start job queue');
  }

  // Parse redis[s]://[:password@]host[:port][/db]
  const parsed = new URL(url);
  const conn = {
    host:     parsed.hostname,
    port:     parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    username: parsed.username || undefined,
    db:       parsed.pathname ? parseInt(parsed.pathname.slice(1) || '0', 10) : 0,
    tls:      parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck:     false,
  };
  // Remove undefined keys
  Object.keys(conn).forEach((k) => conn[k] === undefined && delete conn[k]);
  return conn;
}

// ── Singleton queue (shared across the process) ───────────────────────────────

let _queue = null;

function getPipelineQueue() {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: redisConnection(),
      defaultJobOptions: {
        attempts:    3,
        backoff:     { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 200 },
        removeOnFail:     { count: 500 },
      },
    });
  }
  return _queue;
}

module.exports = { getPipelineQueue, redisConnection, QUEUE_NAME, Queue, Worker, QueueEvents };
