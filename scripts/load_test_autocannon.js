#!/usr/bin/env node
'use strict';

/**
 * Load test against GET /health only — does not trigger HeyGen.
 *
 * Usage:
 *   API must be running (e.g. localhost:3000).
 *   npm run load-test:health
 *
 * Env:
 *   LOAD_TEST_URL  — default http://127.0.0.1:3000/health
 *   LOAD_TEST_CONNECTIONS — default 20
 *   LOAD_TEST_DURATION_SEC  — default 15
 */

const autocannon = require('autocannon');

const url = process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/health';
const connections = parseInt(process.env.LOAD_TEST_CONNECTIONS || '20', 10);
const duration = parseInt(process.env.LOAD_TEST_DURATION_SEC || '15', 10);

console.log(`autocannon → ${url} (connections=${connections}, duration=${duration}s)\n`);

const instance = autocannon(
  { url, connections, duration },
  (err, result) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(autocannon.printResult(result));
  }
);

autocannon.track(instance, { renderProgressBar: true });
