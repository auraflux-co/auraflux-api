'use strict';
/**
 * lib/pipeline_events.js
 *
 * Singleton EventEmitter for CWN pipeline stage transitions.
 * Both the HeyGen poller and server.js import the same instance
 * (same Node process = same object reference).
 *
 * Events emitted:
 *   heygen:all_complete  { jobId, contentType, segmentUrls[] }   — all HeyGen segments done
 *   gate2:complete       { jobId, contentType, score, outcome }   — Gate 2 QA finished
 *   gate2:fail           { jobId, score }                         — Gate 2 hard fail
 *   assembly:triggered   { jobId, assemblyId }                    — auto-assembly fired
 *   gate3:complete       { jobId, score, outcome }                — Gate 3 QA finished
 *
 * Usage:
 *   const pipelineBus = require('./pipeline_events');
 *   pipelineBus.emit('heygen:all_complete', { jobId, contentType, segmentUrls });
 *   pipelineBus.on('heygen:all_complete', (data) => { ... });
 */

const { EventEmitter } = require('events');

const pipelineBus = new EventEmitter();
pipelineBus.setMaxListeners(20); // headroom for multiple listeners per event

module.exports = pipelineBus;
