'use strict';

// ── Jira queue helpers ────────────────────────────────────────────────────────
// Thin read/write wrappers around data/jira_queue.json.
// Used by the Mac-side poller and the /api/jira-webhook route.

const fs = require('fs');
const path = require('path');

const JIRA_QUEUE_FILE = path.join(__dirname, '..', 'data', 'jira_queue.json');
const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || '';

function readJiraQueue() {
  try {
    return JSON.parse(fs.readFileSync(JIRA_QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJiraQueue(queue) {
  fs.writeFileSync(JIRA_QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

module.exports = { JIRA_QUEUE_FILE, JIRA_WEBHOOK_SECRET, readJiraQueue, writeJiraQueue };
