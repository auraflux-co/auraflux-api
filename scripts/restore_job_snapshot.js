#!/usr/bin/env node
'use strict';
/**
 * Restore job card from data/job_snapshots/<jobId>/card.json into jobs.json + SQLite.
 * Usage: node scripts/restore_job_snapshot.js script_twitch_1782513992551
 */
const fs = require('fs');
const path = require('path');

const jobId = process.argv[2];
if (!jobId) {
  console.error('Usage: node scripts/restore_job_snapshot.js <jobId>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const snapCard = path.join(root, 'data', 'job_snapshots', jobId, 'card.json');
if (!fs.existsSync(snapCard)) {
  console.error('Missing snapshot:', snapCard);
  process.exit(1);
}

const card = JSON.parse(fs.readFileSync(snapCard, 'utf8'));
card.savedAt = new Date().toISOString();

const jobsPath = path.join(root, 'data', 'jobs.json');
const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
jobs[jobId] = { ...jobs[jobId], ...card };
fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2));

const db = require('../lib/db');
db.saveJob(jobId, jobs[jobId]);

console.log('Restored', jobId, '→ jobs.json + SQLite');
console.log('  stage:', jobs[jobId].stage);
console.log('  output:', jobs[jobId].outputPath || jobs[jobId].filename);
