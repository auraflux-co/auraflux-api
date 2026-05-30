'use strict';
/**
 * lib/routes/admin_assistant.js — CPD-411
 *
 * POST /api/admin/assistant
 *
 * Gemini-powered Admin Assistant: answers operational questions and can create
 * Jira tickets with an optional Cursor SDK agent handoff.
 *
 * Auth: requireAuth + requireRole(ROLES.SUPERADMIN)
 */

const path   = require('path');
const fs     = require('fs');
const router = require('express').Router();

const { requireAuth, requireRole, ROLES } = require('../auth');
const { callGemini }                      = require('../services/gemini');
const { logError }                        = require('../error_logger');

const ATLASSIAN_BASE  = `https://${process.env.ATLASSIAN_DOMAIN || 'aurafluxco.atlassian.net'}`;
const JIRA_PROJECT    = process.env.JIRA_PROJECT_KEY || 'CPD';
const RENDER_API_KEY  = process.env.RENDER_API_KEY   || '';
const RENDER_SVC_ID   = process.env.RENDER_SERVICE_ID || 'srv-d7nsd77avr4c73frifcg';

// ── helpers ───────────────────────────────────────────────────────────────────

function atlassianHeaders() {
  const email = process.env.ATLASSIAN_EMAIL || process.env.JIRA_USER_EMAIL || '';
  const token = process.env.ATLASSIAN_API_TOKEN || process.env.JIRA_API_TOKEN || '';
  const creds = Buffer.from(`${email}:${token}`).toString('base64');
  return {
    Authorization: `Basic ${creds}`,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
}

/**
 * Load operational context in parallel:
 * 1. Render service health
 * 2. STATUS.md contents (first 3000 chars)
 * 3. Recent errors (last 20 lines of most recent log file)
 * 4. Active Jira sprint tickets
 */
async function buildContext() {
  const [renderHealth, statusMd, recentErrors, sprintTickets] = await Promise.allSettled([
    fetchRenderHealth(),
    fetchStatusMd(),
    fetchRecentErrors(),
    fetchActiveSprintTickets(),
  ]);

  return {
    renderHealth:  renderHealth.status  === 'fulfilled' ? renderHealth.value  : `error: ${renderHealth.reason}`,
    statusMd:      statusMd.status      === 'fulfilled' ? statusMd.value      : `error: ${statusMd.reason}`,
    recentErrors:  recentErrors.status  === 'fulfilled' ? recentErrors.value  : `error: ${recentErrors.reason}`,
    sprintTickets: sprintTickets.status === 'fulfilled' ? sprintTickets.value : `error: ${sprintTickets.reason}`,
  };
}

async function fetchRenderHealth() {
  if (!RENDER_API_KEY) return 'RENDER_API_KEY not configured';
  const res = await fetch(
    `https://api.render.com/v1/services/${RENDER_SVC_ID}`,
    { headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' } }
  );
  if (!res.ok) return `Render API ${res.status}`;
  const data = await res.json();
  const svc  = data.service || data;
  return `service: ${svc.name || RENDER_SVC_ID}, status: ${svc.serviceDetails?.buildCommand ? 'configured' : 'unknown'}, suspended: ${svc.suspended || 'no'}`;
}

function fetchStatusMd() {
  const statusPath = path.join(__dirname, '..', '..', 'STATUS.md');
  const content    = fs.readFileSync(statusPath, 'utf8');
  return content.slice(0, 3000);
}

async function fetchRecentErrors() {
  const logsDir = path.join(__dirname, '..', '..', 'logs');
  if (!fs.existsSync(logsDir)) return 'logs directory not found';

  const files = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.jsonl') || f.endsWith('.log'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(logsDir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) return 'no log files found';

  const latest  = path.join(logsDir, files[0].name);
  const content = fs.readFileSync(latest, 'utf8');
  const lines   = content.split('\n').filter(Boolean);
  return lines.slice(-20).join('\n');
}

async function fetchActiveSprintTickets() {
  const headers = atlassianHeaders();

  const sprintRes = await fetch(
    `${ATLASSIAN_BASE}/rest/agile/1.0/board/1/sprint?state=active`,
    { headers }
  );
  if (!sprintRes.ok) return `Sprint API ${sprintRes.status}`;
  const sprintData = await sprintRes.json();
  const sprint     = (sprintData.values || [])[0];
  if (!sprint) return 'no active sprint';

  const issuesRes = await fetch(
    `${ATLASSIAN_BASE}/rest/agile/1.0/sprint/${sprint.id}/issue?maxResults=30&fields=summary,status,assignee,priority`,
    { headers }
  );
  if (!issuesRes.ok) return `Issues API ${issuesRes.status}`;
  const issuesData = await issuesRes.json();

  const tickets = (issuesData.issues || []).map(i => ({
    key:      i.key,
    summary:  i.fields.summary,
    status:   i.fields.status?.name,
    priority: i.fields.priority?.name,
    assignee: i.fields.assignee?.displayName || 'unassigned',
  }));

  return `Sprint: ${sprint.name}\n${tickets.map(t => `${t.key} [${t.status}] ${t.summary} (${t.priority}, ${t.assignee})`).join('\n')}`;
}

function buildSystemPrompt(context) {
  return `You are the AuraFlux Admin Assistant. Based on the user's message and context below, determine the intent and respond.

Intents:
- "answer": Answer the question directly using the provided context. Be concise.
- "action": Describe what action should be taken (do not execute it).
- "ticket": The user wants something built. Extract: title, description, acceptance_criteria, priority (high/medium/low).

Context:
--- Render Service Health ---
${context.renderHealth}

--- STATUS.md (last 3000 chars) ---
${context.statusMd}

--- Recent Errors (last 20 log lines) ---
${context.recentErrors}

--- Active Sprint Tickets ---
${context.sprintTickets}

Respond as JSON only (no markdown fences): { "type": "answer"|"action"|"ticket", "message": "...", "ticket"?: { "title": "...", "description": "...", "acceptance_criteria": "...", "priority": "high"|"medium"|"low" } }`;
}

async function createJiraTicket(ticket) {
  const headers = atlassianHeaders();
  const body = {
    fields: {
      project:     { key: JIRA_PROJECT },
      summary:     ticket.title,
      description: {
        type:    'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: ticket.description || '' }],
          },
          ...(ticket.acceptance_criteria ? [{
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: 'Acceptance Criteria' }],
          }, {
            type: 'paragraph',
            content: [{ type: 'text', text: ticket.acceptance_criteria }],
          }] : []),
        ],
      },
      issuetype: { name: 'Story' },
      priority:  { name: ticket.priority === 'high' ? 'High' : ticket.priority === 'low' ? 'Low' : 'Medium' },
      labels:    ['admin-assistant'],
    },
  };

  const res = await fetch(`${ATLASSIAN_BASE}/rest/api/3/issue`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jira ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.key;
}

async function triggerCursorAgent(ticketKey, ticket) {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return;

  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  await fetch('https://api.cursor.com/v1/agents', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt:       `Implement ${ticketKey}: ${ticket.title}\n\n${ticket.description}\n\nBranch: feat/${ticketKey.toLowerCase()}-${slug}\nCommit prefix: feat(${ticketKey.toLowerCase()}):`,
      autoCreatePR: true,
    }),
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/assistant
 * Body: { message: string }
 */
router.post(
  '/api/admin/assistant',
  requireAuth,
  requireRole(ROLES.SUPERADMIN),
  async (req, res) => {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    try {
      const context      = await buildContext();
      const systemPrompt = buildSystemPrompt(context);

      const raw = await callGemini(message, {
        systemInstruction: systemPrompt,
        maxOutputTokens:   1000,
        temperature:       0.3,
      });

      let parsed;
      try {
        const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        return res.json({ type: 'answer', message: raw });
      }

      if (parsed.type !== 'ticket' || !parsed.ticket) {
        return res.json({ type: parsed.type || 'answer', message: parsed.message || raw });
      }

      // Create Jira ticket
      const ticketKey = await createJiraTicket(parsed.ticket);

      // Attempt Cursor SDK agent handoff — non-fatal
      try {
        await triggerCursorAgent(ticketKey, parsed.ticket);
      } catch (agentErr) {
        logError('[admin_assistant] Cursor agent handoff failed', agentErr);
      }

      return res.json({
        type:     'ticket',
        message:  `Ticket ${ticketKey} created. Cursor is on it.`,
        ticketId: ticketKey,
      });
    } catch (err) {
      logError('[admin_assistant] Error processing request', err);
      return res.status(500).json({ error: 'Assistant error', detail: err.message });
    }
  }
);

module.exports = router;
