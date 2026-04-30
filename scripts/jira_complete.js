#!/usr/bin/env node
/**
 * scripts/jira_complete.js
 *
 * Called by Aider (or manually) after completing a task to:
 *   1. Transition the Jira ticket to "Done"
 *   2. Post a comment with the commit SHA and branch
 *
 * Usage:
 *   node scripts/jira_complete.js <ISSUE-KEY> [<commit-sha>] [<comment>]
 *
 * Examples:
 *   node scripts/jira_complete.js CPD-5 abc1234
 *   node scripts/jira_complete.js CPD-6 abc1234 "Tests passing — 11/11 green"
 *
 * Env vars required:
 *   ATLASSIAN_EMAIL       e.g. robert@businessrocket.ai
 *   ATLASSIAN_API_TOKEN   Atlassian API token
 */

'use strict';

const https = require('https');
const { execSync } = require('child_process');

const CLOUD_ID = 'ea8459c4-1608-4cb7-a40c-e0fd9af73932';
const EMAIL = process.env.ATLASSIAN_EMAIL;
const TOKEN = process.env.ATLASSIAN_API_TOKEN;

// Transition IDs (verified 2026-04-28)
const TRANSITION_DONE = '31';

const [, , issueKey, commitSha, ...commentParts] = process.argv;

if (!issueKey) {
  console.error('Usage: node scripts/jira_complete.js <ISSUE-KEY> [<commit-sha>] [<comment>]');
  process.exit(1);
}

if (!EMAIL || !TOKEN) {
  console.error('jira_complete: ATLASSIAN_EMAIL or ATLASSIAN_API_TOKEN not set — skipping.');
  process.exit(0);
}

const AUTH = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

// ── HTTP helper ──────────────────────────────────────────────────────────────

function jiraRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.atlassian.com',
        path: urlPath,
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

// ── Build comment body (ADF) ─────────────────────────────────────────────────

function buildComment(sha, extraComment, branch) {
  const lines = [];
  lines.push(`✅ **Completed by Cursor/Aider** — ${new Date().toISOString().slice(0, 10)}`);
  if (sha) lines.push(`**Commit:** \`${sha}\``);
  if (branch) lines.push(`**Branch:** \`${branch}\``);
  if (extraComment) lines.push(`**Note:** ${extraComment}`);
  lines.push(`**Repo:** https://github.com/auraflux-co/auraflux-api`);

  // Build minimal ADF paragraph block
  return {
    version: 1,
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Resolve commit SHA if not provided
  let sha = commitSha;
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      sha = 'unknown';
    }
  }

  // Resolve branch
  let branch = 'unknown';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
  } catch {}

  const extraComment = commentParts.join(' ');

  console.log(`jira_complete: transitioning ${issueKey} → Done...`);

  // Transition to Done
  const transRes = await jiraRequest(
    'POST',
    `/ex/jira/${CLOUD_ID}/rest/api/3/issue/${issueKey}/transitions`,
    { transition: { id: TRANSITION_DONE } }
  );

  if (transRes.status === 204) {
    console.log(`jira_complete: ${issueKey} → Done ✅`);
  } else {
    console.warn(`jira_complete: transition failed for ${issueKey} — ${transRes.status}`);
  }

  // Post comment
  const commentBody = buildComment(sha, extraComment, branch);
  const commentRes = await jiraRequest(
    'POST',
    `/ex/jira/${CLOUD_ID}/rest/api/3/issue/${issueKey}/comment`,
    { body: commentBody }
  );

  if (commentRes.status === 201) {
    console.log(`jira_complete: comment posted to ${issueKey} ✅`);
  } else {
    console.warn(`jira_complete: comment failed for ${issueKey} — ${commentRes.status}`);
  }
}

main().catch((err) => {
  console.error('jira_complete error:', err.message);
  process.exit(1);
});
