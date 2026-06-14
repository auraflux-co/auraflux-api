'use strict';
/**
 * Append-only EchoMimic pod + render metrics (local JSONL).
 * Used by scripts/echomimic_pod_report.js for failure rates and latency baselines.
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'echomimic_pod_metrics.jsonl');

function record(event, fields = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const row = {
      ts: new Date().toISOString(),
      provider: process.env.ECHOMIMIC_GPU_PROVIDER || 'runpod',
      podId: process.env.ECHOMIMIC_POD_ID || null,
      ...fields,
      event
    };
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.warn(`[echomimic-metrics] log failed: ${e.message}`);
  }
}

function startTimer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

module.exports = { record, startTimer, LOG_FILE };
