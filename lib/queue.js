'use strict';
// lib/queue.js — BullMQ queue definitions for the CWN pipeline.
// Queue definitions only — no workers wired yet.
// Redis connection is lazy: only created when a queue method is first called.
// If Redis is not running, this module loads without crashing.

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
  PIPELINE:    'cwn-pipeline',
  HEYGEN_POLL: 'cwn-heygen-poll',
  ASSEMBLY:    'cwn-assembly',
};

// ── Queue factories ───────────────────────────────────────────────────────────

function _makeQueue(name) {
  const conn = getRedisConnection();
  if (!conn) {
    console.warn(`[queue] Redis unavailable — queue "${name}" not created`);
    return null;
  }
  return new Queue(name, { connection: conn });
}

function getPipelineQueue() { return _makeQueue(QUEUES.PIPELINE);    }
function getHeyGenQueue()   { return _makeQueue(QUEUES.HEYGEN_POLL); }
function getAssemblyQueue() { return _makeQueue(QUEUES.ASSEMBLY);    }

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  QUEUES,
  getRedisConnection,
  getPipelineQueue,
  getHeyGenQueue,
  getAssemblyQueue,
};
