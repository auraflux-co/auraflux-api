// MOVED FROM: server.js:222 (StageTimer class, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics)
// CWN production pipeline performance metrics

'use strict';

const fs   = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Global metrics store: { jobId: { stages: [], totalTime: X } }
const jobMetrics = {};

// ── Stage Timer for Performance Metrics ────────────────────────────
// Tracks wall time, token usage, and results for each production stage
class StageTimer {
  constructor(jobId, stageName) {
    this.jobId = jobId;
    this.stageName = stageName;
    this.startTime = Date.now();
    this.metrics = {
      stage: stageName,
      startedAt: new Date().toISOString(),
      wallTimeMs: null,
      wallTimeSec: null
    };
  }

  // Add custom data to metrics (tokens, file sizes, pass/fail, etc.)
  addData(key, value) {
    this.metrics[key] = value;
    return this;
  }

  // Complete the stage and calculate duration
  end() {
    const endTime = Date.now();
    this.metrics.wallTimeMs = endTime - this.startTime;
    this.metrics.wallTimeSec = (this.metrics.wallTimeMs / 1000).toFixed(2);
    this.metrics.completedAt = new Date().toISOString();
    return this.metrics;
  }
}

function initJobMetrics(jobId) {
  jobMetrics[jobId] = {
    jobId,
    startedAt: new Date().toISOString(),
    stages: [],
    totalTimeMs: null,
    totalTimeSec: null
  };
}

function addStageMetrics(jobId, stageMetrics) {
  if (!jobMetrics[jobId]) initJobMetrics(jobId);
  jobMetrics[jobId].stages.push(stageMetrics);
  console.log(`[metrics:${jobId}] ${stageMetrics.stage} completed in ${stageMetrics.wallTimeSec}s`);
}

function finalizeJobMetrics(jobId) {
  if (!jobMetrics[jobId]) return;

  const firstStage = jobMetrics[jobId].stages[0];
  const lastStage = jobMetrics[jobId].stages[jobMetrics[jobId].stages.length - 1];

  if (firstStage && lastStage) {
    const start = new Date(firstStage.startedAt).getTime();
    const end = new Date(lastStage.completedAt).getTime();
    jobMetrics[jobId].totalTimeMs = end - start;
    jobMetrics[jobId].totalTimeSec = (jobMetrics[jobId].totalTimeMs / 1000).toFixed(2);
    jobMetrics[jobId].completedAt = lastStage.completedAt;
  }

  // Save to file
  const metricsFile = path.join(OUTPUT_DIR, `run_metrics_${jobId}.json`);
  try {
    fs.writeFileSync(metricsFile, JSON.stringify(jobMetrics[jobId], null, 2));
    console.log(`[metrics:${jobId}] ✅ Metrics saved: ${metricsFile}`);
    console.log(`[metrics:${jobId}] Total pipeline time: ${jobMetrics[jobId].totalTimeSec}s`);
  } catch (e) {
    console.error(`[metrics:${jobId}] Failed to save metrics: ${e.message}`);
  }

  // Also write each stage to SQLite job_metrics table
  try {
    const { saveMetric } = require('./db');
    if (typeof saveMetric === 'function') {
      jobMetrics[jobId].stages.forEach(stage => {
        saveMetric(jobId, stage.stage, stage.wallTimeMs, stage);
      });
    }
  } catch(e) {
    // Non-fatal — metrics DB write failure never blocks pipeline
  }

  return jobMetrics[jobId];
}

module.exports = { StageTimer, jobMetrics, initJobMetrics, addStageMetrics, finalizeJobMetrics };
