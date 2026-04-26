'use strict';
// lib/queue.js — BullMQ queue definitions for the AuraFlux pipeline.
// Queue definitions only — no workers wired yet.
// Redis connection is lazy: only created when a queue method is first called.
// If Redis is not running, this module loads without crashing.
//
// Every job added to any queue MUST carry jobId as a first-class field.
// Use addGateJob() to enforce this invariant.

const { Queue, QueueEvents } = require('bullmq');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ── Redis connection (lazy) ───────────────────────────────────────────────────

let _connection = null;

function getRedisConnection() {
  if (_connection) return _connection;

  // Dynamic require so the module loads even if ioredis is missing
  let IORedis;
  try {
    IORedis = require('ioredis');
  } catch (e) {
    console.error('[queue] ioredis not installed — BullMQ unavailable');
    return null;
  }

  try {
    _connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,  // Required by BullMQ
      lazyConnect: true,           // Don't connect until first command
      enableOfflineQueue: false,   // Fail fast if Redis is down
    });

    _connection.on('error', (err) => {
      // Log but don't crash — Redis unavailability is non-fatal during transition
      if (!err.message.includes('ECONNREFUSED')) {
        console.error('[queue] Redis error:', err.message);
      }
    });

    _connection.on('connect', () => {
      console.log('[queue] Redis connected:', REDIS_URL);
    });

  } catch (e) {
    console.error('[queue] Failed to create Redis connection:', e.message);
    return null;
  }

  return _connection;
}

// ── Queue names ───────────────────────────────────────────────────────────────

const QUEUES = {
  PIPELINE:    'auraflux:pipeline',
  GATE:        'auraflux:gate',
  HEYGEN_POLL: 'auraflux:heygen-poll',
  ASSEMBLY:    'auraflux:assembly',
  UPLOAD:      'auraflux:upload',
  MONITORING:  'auraflux:monitoring',
};

// ── Queue cache ───────────────────────────────────────────────────────────────

// Cache instantiated queues so we don't create duplicate BullMQ Queue instances
const _queues = {};

// ── Queue factories ───────────────────────────────────────────────────────────

function _makeQueue(name) {
  if (_queues[name]) return _queues[name];

  const conn = getRedisConnection();
  if (!conn) {
    console.warn(`[queue] Redis unavailable — queue "${name}" not created`);
    return null;
  }
  const q = new Queue(name, { connection: conn });
  _queues[name] = q;
  return q;
}

function getPipelineQueue()   { return _makeQueue(QUEUES.PIPELINE);    }
function getGateQueue()       { return _makeQueue(QUEUES.GATE);        }
function getHeyGenQueue()     { return _makeQueue(QUEUES.HEYGEN_POLL); }
function getAssemblyQueue()   { return _makeQueue(QUEUES.ASSEMBLY);    }
function getUploadQueue()     { return _makeQueue(QUEUES.UPLOAD);      }
function getMonitoringQueue() { return _makeQueue(QUEUES.MONITORING);  }

// Convenience accessor — get any queue by QUEUES key or queue name string
function getQueue(nameOrKey) {
  // If it's a QUEUES key (e.g. 'GATE'), resolve to queue name string first
  const resolved = QUEUES[nameOrKey] || nameOrKey;
  return _makeQueue(resolved);
}

// ── addGateJob — enforces jobId on every queue message ───────────────────────

/**
 * Add a gate job to a queue, enforcing that jobId is always present.
 *
 * @param {string} queueName — QUEUES key (e.g. 'GATE') or queue name string (e.g. 'auraflux:gate')
 * @param {string} gateName  — BullMQ job name (e.g. 'gate0', 'gate1')
 * @param {string} jobId     — AuraFlux jobId — REQUIRED
 * @param {object} payload   — additional data to include in the message
 * @returns {Promise<Job>}   — BullMQ Job instance
 */
async function addGateJob(queueName, gateName, jobId, payload) {
  if (!jobId) {
    throw new Error('[queue] addGateJob: jobId is required on all queue messages');
  }

  const queue = getQueue(queueName);
  if (!queue) {
    throw new Error(`[queue] addGateJob: queue "${queueName}" unavailable (Redis down?)`);
  }

  let canonicalJobId = jobId;
  try {
    const { resolveCanonicalJobId } = require('./db');
    canonicalJobId = resolveCanonicalJobId(jobId);
  } catch (_e) { /* db may be unavailable in some tests */ }

  return queue.add(gateName, { jobId, canonicalJobId, ...payload }, {
    jobId:   `${jobId}:${gateName}`,  // BullMQ job ID = auraflux jobId + gate name
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  QUEUES,
  getRedisConnection,
  getPipelineQueue,
  getGateQueue,
  getHeyGenQueue,
  getAssemblyQueue,
  getUploadQueue,
  getMonitoringQueue,
  getQueue,
  addGateJob,
  // Expose cache for introspection / testing
  get queues() { return _queues; },
};
