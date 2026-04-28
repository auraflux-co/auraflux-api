#!/usr/bin/env node
/**
 * scripts/jira_sync.js
 *
 * Pulls CPD Jira tickets labelled "aider" with status "To Do" and appends
 * them as a dated task section to docs/ops/OVERNIGHT_TASKS.md so Aider can
 * execute them in the next overnight run.
 *
 * After writing the section it transitions each pulled ticket to "In Progress"
 * so the same ticket is never double-queued.
 *
 * Usage (called automatically by overnight_runner.sh before Aider starts):
 *   node scripts/jira_sync.js
 *
 * Env vars required (must exist in .env or shell):
 *   ATLASSIAN_EMAIL       e.g. robert@businessrocket.ai
 *   ATLASSIAN_API_TOKEN   Atlassian API token
 *   ATLASSIAN_DOMAIN      e.g. robertsworkspace-18914505.atlassian.net
 *   JIRA_PROJECT_KEY      e.g. CPD
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const CLOUD_ID = 'ea8459c4-1608-4cb7-a40c-e0fd9af73932';
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.ATLASSIAN_API_TOKEN;
const PROJECT = process.env.JIRA_PROJECT_KEY || 'CPD';
const REPO_DIR = path.join(__dirname, '..');
const OVERNIGHT_FILE = path.join(REPO_DIR, 'docs', 'ops', 'OVERNIGHT_TASKS.md');

// Transition IDs for this project (verified 2026-04-28)
const TRANSITION_IN_PROGRESS = '21';

if (!EMAIL || !TOKEN) {
  console.error('jira_sync: ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN not set — skipping Jira sync.');
  process.exit(0);
}

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ── HTTP helper ──────────────────────────────────────────────────────────────

function jiraRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.atlassian.com',
        path,
        method,
        headers: {
          Authorization: `Basic ${AUTH}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Fetch tickets ────────────────────────────────────────────────────────────

async function fetchAiderTickets() {
  const jql = encodeURIComponent(
    `project = ${PROJECT} AND labels = "aider" AND status = "To Do" ORDER BY priority ASC, created ASC`
  );
  const res = await jiraRequest(
    'GET',
    `/ex/jira/${CLOUD_ID}/rest/api/3/search?jql=${jql}&maxResults=20&fields=summary,description,priority,labels`
  );
  if (res.status !== 200) {
    console.error('jira_sync: failed to fetch tickets:', res.status, JSON.stringify(res.body));
    return [];
  }
  return res.body.issues || [];
}

// ── Transition ticket to In Progress ─────────────────────────────────────────

async function transitionTicket(issueKey, transitionId) {
  const res = await jiraRequest(
    'POST',
    `/ex/jira/${CLOUD_ID}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id: transitionId } }
  );
  if (res.status !== 204) {
    console.warn(`jira_sync: could not transition ${issueKey} — ${res.status}`);
  }
}

// ── Extract plain text from Atlassian Document Format ────────────────────────

function adfToText(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  const lines = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'text') lines.push(node.text || '');
    if (node.type === 'hardBreak' || node.type === 'paragraph') lines.push('\n');
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(doc);
  return lines.join('').trim();
}

// ── Write task section to OVERNIGHT_TASKS.md ─────────────────────────────────

function writeOvernightSection(tickets) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '',
    `---`,
    '',
    `## 🟡 ${today} Jira Sync — PENDING`,
    '',
    `Tasks pulled from CPD tickets labelled \`aider\` at ${new Date().toISOString()}.`,
    `Work through them IN ORDER. Commit each before starting the next.`,
    `After all done: update MORNING_BRIEFING.md, mark [x] below, run git push origin HEAD.`,
    '',
    '---',
    '',
  ];

  tickets.forEach((issue, i) => {
    const key = issue.key;
    const summary = issue.fields.summary;
    const description = adfToText(issue.fields.description);
    const priority = issue.fields.priority?.name || 'Medium';

    lines.push(`### [ ] Task ${i + 1} — [${key}] ${summary}`);
    lines.push('');
    lines.push(`**Jira:** https://robertsworkspace-18914505.atlassian.net/browse/${key}`);
    lines.push(`**Priority:** ${priority}`);
    lines.push('');
    if (description) {
      lines.push(description);
      lines.push('');
    }
    lines.push(`**When done:** Commit with message referencing ${key}, then run:`);
    lines.push(`\`\`\`bash`);
    lines.push(`node scripts/jira_complete.js ${key} "<your commit sha>"`);
    lines.push(`\`\`\``);
    lines.push('');
    lines.push('---');
    lines.push('');
  });

  const existing = fs.readFileSync(OVERNIGHT_FILE, 'utf8');
  // Insert just before the first existing --- separator (top of file, after header)
  const insertMarker = '\n---\n';
  const insertAt = existing.indexOf(insertMarker);
  let updated;
  if (insertAt === -1) {
    updated = existing + lines.join('\n');
  } else {
    updated = existing.slice(0, insertAt) + lines.join('\n') + existing.slice(insertAt);
  }
  fs.writeFileSync(OVERNIGHT_FILE, updated, 'utf8');
  console.log(`jira_sync: wrote ${tickets.length} task(s) to OVERNIGHT_TASKS.md`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('jira_sync: fetching CPD tickets labelled "aider" with status "To Do"...');
  const tickets = await fetchAiderTickets();

  if (tickets.length === 0) {
    console.log('jira_sync: no aider-labelled tickets found — nothing to queue.');
    return;
  }

  console.log(`jira_sync: found ${tickets.length} ticket(s): ${tickets.map((t) => t.key).join(', ')}`);

  writeOvernightSection(tickets);

  for (const issue of tickets) {
    await transitionTicket(issue.key, TRANSITION_IN_PROGRESS);
    console.log(`jira_sync: transitioned ${issue.key} → In Progress`);
  }

  console.log('jira_sync: done.');
}

main().catch((err) => {
  console.error('jira_sync error:', err.message);
  process.exit(1);
});
