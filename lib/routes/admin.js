'use strict';

// ── Admin / infrastructure routes ─────────────────────────────────────────────
// GET  /health
// GET  /news-tool
// GET  /newscast-overlay
// GET  /twitch-tool
// GET  /twitch-token
// GET  /market-keys
// POST /api/jira-webhook
// GET  /api/jira-queue
// POST /api/jira-queue/:issueKey/done
// POST /api/github-sync
// GET  /disk-usage
// GET  /errors
// POST /internal/alert  ← New Relic webhook (CPD-101)
//
// Factory: createAdminRouter({ _healthCache, BUILD_INFO })
// _healthCache is passed by reference so the route always reads the latest cached values.

const fs = require('fs');
const path = require('path');
const router = require('express').Router();

const { readJiraQueue, writeJiraQueue, JIRA_WEBHOOK_SECRET } = require('../jira_queue');
const { getErrorRate, getRecentErrors, ERROR_LOG } = require('../error_logger');
const { validateBodySize, requireFields } = require('../validation');
const { webhookLimit, apiLimit, healthLimit } = require('../rateLimiter');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');
const ROOT_DIR = path.join(__dirname, '..', '..');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'auraflux-co/auraflux-api';

/**
 * Extract plain text from a Jira ADF (Atlassian Document Format) comment body.
 * If body is already a string, returns it as-is.
 * Handles cases where Jira Automation serialises {{comment.body}} as a nested object.
 */
function adfToText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body !== 'object') return String(body);
  // Recursively pull text from ADF content nodes
  const extract = (node) => {
    if (!node) return '';
    if (node.type === 'text') return node.text || '';
    if (Array.isArray(node.content)) return node.content.map(extract).join('');
    return '';
  };
  return extract(body) || JSON.stringify(body);
}

// Search open/recent PRs for a given Jira issue key and post a comment
async function postJiraStatusToGitHub(issueKey, status, summary, actor, commentBody) {
  if (!GITHUB_TOKEN) return false;
  const https = require('https');

  let body;
  if (status === 'comment' && commentBody) {
    // Mirror a Jira comment verbatim (e.g. Rovo review)
    body =
      `💬 **Jira comment** on [${issueKey}](https://robertsworkspace-18914505.atlassian.net/browse/${issueKey})` +
      `${actor ? ` from **${actor}**` : ''}:\n\n---\n\n${commentBody}`;
  } else {
    const statusEmoji =
      {
        'In Development': '🛠️',
        'In Review': '🔍',
        Approved: '✅',
        Done: '🎉',
      }[status] || '📋';

    body =
      `${statusEmoji} **Jira status update**\n\n` +
      `**${issueKey}** → \`${status}\`${actor ? ` (by ${actor})` : ''}\n` +
      (summary ? `_${summary}_\n` : '') +
      `\nhttps://robertsworkspace-18914505.atlassian.net/browse/${issueKey}`;
  }

  const [owner, repo] = GITHUB_REPO.split('/');

  // Find PRs with this issue key in the branch name
  return new Promise((resolve) => {
    const searchQuery = encodeURIComponent(
      `repo:${owner}/${repo} is:pr head:${issueKey.toLowerCase()} in:head`
    );
    const options = {
      hostname: 'api.github.com',
      path: `/search/issues?q=${searchQuery}&per_page=5`,
      headers: {
        'User-Agent': 'auraflux-api',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    };
    https
      .get(options, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            const items = JSON.parse(data).items || [];
            if (!items.length) {
              resolve(false);
              return;
            }
            const prNumber = items[0].number;
            const postOpts = {
              hostname: 'api.github.com',
              path: `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
              method: 'POST',
              headers: {
                'User-Agent': 'auraflux-api',
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
            };
            const req = https.request(postOpts, (r) => {
              resolve(r.statusCode >= 200 && r.statusCode < 300);
            });
            req.on('error', () => resolve(false));
            req.write(JSON.stringify({ body }));
            req.end();
          } catch {
            resolve(false);
          }
        });
      })
      .on('error', () => resolve(false));
  });
}

module.exports = function createAdminRouter({ _healthCache, BUILD_INFO }) {
  // GET /health
  router.get('/health', healthLimit, (req, res) => {
    // Critical errors → 503 (server cannot function)
    const errors = [];
    if (_healthCache.ffmpeg.status === 'error') errors.push('FFmpeg not available');
    Object.entries(_healthCache.directories).forEach(([, v]) => {
      if (!v.exists) errors.push(`${v.path} directory not accessible`);
    });
    if (_healthCache.freeSpaceGB !== null && _healthCache.freeSpaceGB < 1) {
      errors.push(`Low disk space: ${_healthCache.freeSpaceGB}GB remaining`);
    }

    // Warnings → still 200 (server functional, some features unconfigured)
    const warnings = [];
    Object.entries(_healthCache.apiKeys).forEach(([k, v]) => {
      if (v.status === 'missing') warnings.push(`${k} not configured`);
    });

    const statusCode = errors.length === 0 ? 200 : 503;
    res.status(statusCode).json({
      ok: errors.length === 0,
      version: BUILD_INFO.version,
      gitHash: BUILD_INFO.gitHash,
      gitBranch: BUILD_INFO.gitBranch,
      lastCommit: BUILD_INFO.lastCommit,
      deployedAt: BUILD_INFO.deployedAt,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      cacheAge: _healthCache.lastRefreshed,
      dependencies: {
        ffmpeg: _healthCache.ffmpeg,
        ..._healthCache.apiKeys,
        vectcut: _healthCache.vectcut,
      },
      directories: _healthCache.directories,
      errors,
      warnings,
    });
  });

  // C0-only HTML tools — served from localhost for C0 operator use.
  // These routes are intentionally kept as reference implementations.
  // C1+ will serve equivalent tools from the Next.js frontend.
  router.get('/news-tool', (req, res) => res.sendFile(path.join(ROOT_DIR, 'cwn_news_tool.html')));
  router.get('/newscast-overlay', (req, res) =>
    res.sendFile(path.join(ROOT_DIR, 'tools', 'clipzworld_newscast.html'))
  );
  router.get('/twitch-tool', (req, res) =>
    res.sendFile(path.join(ROOT_DIR, 'cwn_twitch_tool.html'))
  );

  // C0-only: Twitch credentials for browser-side Twitch API (ticker overlay, clips, etc.)
  // C1+ equivalent will be gated behind customer auth, not a public env-var endpoint.
  router.get('/twitch-token', (req, res) => {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = process.env.TWITCH_TOKEN;
    if (!clientId || !token)
      return res.status(503).json({ error: 'Twitch credentials not configured' });
    res.json({ clientId, token });
  });

  // C0-only: market data API keys surfaced to browser (FMP, Finnhub for news overlays).
  // C1+ will proxy market data server-side; keys will not be sent to the client.
  router.get('/market-keys', (req, res) => {
    res.json({ fmp: process.env.FMP_API_KEY || '', finnhub: process.env.FINNHUB_API_KEY || '' });
  });

  // POST /api/jira-webhook
  router.post('/api/jira-webhook', webhookLimit, validateBodySize(65536), (req, res) => {
    try {
      const { secret } = req.query;
      if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'invalid secret' });
      }
      const payload = req.body;

      // Shape A: Jira Automation sends flat payload (action: "approved" / "rovo_review_requested")
      // Shape B: Standard Jira webhook with nested issue object
      const isApproved = payload.action === 'approved';
      const isReviewRequest = payload.action === 'rovo_review_requested';

      let key, summary, description, labels, status, priority, event;

      if (isApproved || isReviewRequest) {
        // Flat payload from Jira Automation rule
        key = payload.issueKey || '';
        summary = payload.summary || '';
        description = '';
        labels = [];
        status = payload.status || '';
        priority = 'Medium';
        event = payload.action;
      } else {
        // Standard Jira webhook with nested issue
        const issue = payload?.issue;
        if (!issue) return res.status(400).json({ error: 'no issue in payload' });
        key = issue.key;
        summary = issue.fields?.summary || '';
        description = issue.fields?.description || '';
        labels = issue.fields?.labels || [];
        status = issue.fields?.status?.name || '';
        priority = issue.fields?.priority?.name || 'Medium';
        event = payload.webhookEvent || '';
      }

      if (!key) return res.status(400).json({ error: 'could not determine issue key' });

      const isAider = labels.includes('aider');
      const isCursor = labels.includes('cursor');
      const isRovo = labels.includes('rovo');

      if (!isAider && !isCursor && !isRovo && !isReviewRequest && !isApproved) {
        return res.json({
          queued: false,
          reason: 'no aider/cursor/rovo label and no recognised action',
        });
      }

      const commentBody = adfToText(payload.comment?.body || '');
      const queue = readJiraQueue();
      const existingIdx = queue.findIndex((t) => t.key === key && t.processed === false);
      const entry = {
        key,
        summary,
        description: typeof description === 'string' ? description : JSON.stringify(description),
        labels,
        status,
        priority,
        agent: isAider ? 'aider' : isRovo || isReviewRequest ? 'rovo' : 'cursor',
        event,
        ...(isApproved && { approved: true }),
        ...(isReviewRequest && { reviewRequest: true, commentBody }),
        receivedAt: new Date().toISOString(),
        processed: false,
      };

      if (existingIdx >= 0) queue[existingIdx] = entry;
      else queue.push(entry);

      writeJiraQueue(queue);
      console.log(`[jira-webhook] queued ${key} (${summary}) for ${entry.agent}`);

      // Fire-and-forget: post Jira status update back to GitHub PR
      if (isApproved || isReviewRequest) {
        postJiraStatusToGitHub(
          key,
          isApproved ? 'Approved' : 'In Review',
          summary,
          '',
          commentBody
        ).catch(() => {});
      }

      res.status(202).json({ queued: true, key, agent: entry.agent });
    } catch (err) {
      console.error('[jira-webhook] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/github-sync — Jira Automation calls this on any status transition
  // Body: { issueKey, status, summary, actor }
  router.post('/api/github-sync', webhookLimit, validateBodySize(16384), async (req, res) => {
    try {
      const { secret } = req.query;
      if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'invalid secret' });
      }
      const { issueKey, status, summary, actor, comment } = req.body || {};
      if (!issueKey || !status)
        return res.status(400).json({ error: 'issueKey and status required' });

      const posted = await postJiraStatusToGitHub(
        issueKey,
        status,
        summary || '',
        actor || '',
        adfToText(comment || '')
      );
      res.json({ posted, issueKey, status });
    } catch (err) {
      console.error('[github-sync] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/jira-queue
  router.get('/api/jira-queue', (req, res) => {
    const { secret } = req.query;
    if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET)
      return res.status(403).json({ error: 'invalid secret' });
    res.json(readJiraQueue().filter((t) => !t.processed));
  });

  // POST /api/jira-queue/:issueKey/done
  router.post('/api/jira-queue/:issueKey/done', (req, res) => {
    const { secret } = req.query;
    if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET)
      return res.status(403).json({ error: 'invalid secret' });
    const { issueKey } = req.params;
    const queue = readJiraQueue();
    const item = queue.find((t) => t.key === issueKey);
    if (!item) return res.status(404).json({ error: 'not found' });
    item.processed = true;
    item.processedAt = new Date().toISOString();
    writeJiraQueue(queue);
    res.json({ ok: true, key: issueKey });
  });

  // GET /disk-usage
  router.get('/disk-usage', (req, res) => {
    try {
      const outputFiles = fs
        .readdirSync(OUTPUT_DIR)
        .filter((f) => f.endsWith('.mp4'))
        .map((f) => {
          const fp = path.join(OUTPUT_DIR, f);
          const stat = fs.statSync(fp);
          return {
            name: f,
            sizeMB: parseFloat((stat.size / 1024 / 1024).toFixed(1)),
            mtime: stat.mtimeMs,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const tmpSize = fs.readdirSync(TMP_DIR).reduce((acc, f) => {
        try {
          return acc + fs.statSync(path.join(TMP_DIR, f)).size;
        } catch (_e) {
          return acc;
        }
      }, 0);

      const totalMB = outputFiles.reduce((a, f) => a + f.sizeMB, 0) + tmpSize / 1024 / 1024;
      res.json({
        ok: true,
        outputFiles,
        tmpMB: parseFloat((tmpSize / 1024 / 1024).toFixed(1)),
        totalMB: parseFloat(totalMB.toFixed(1)),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /errors
  router.get('/errors', (req, res) => {
    const n = parseInt(req.query.n) || 50;
    const label = req.query.label || null;
    const rate = getErrorRate();
    let recent = getRecentErrors(n);
    if (label) recent = recent.filter((e) => e.label === label);
    res.json({ ok: true, errorRate: rate, recent, logFile: ERROR_LOG });
  });

  // POST /api/admin/migrate-pg
  // One-shot SQLite → Postgres migration triggered via HTTP.
  // Protected by ADMIN_SECRET header. Safe to run multiple times (ON CONFLICT DO NOTHING).
  router.post('/api/admin/migrate-pg', async (req, res) => {
    const secret = process.env.ADMIN_SECRET || process.env.NEW_RELIC_LICENSE_KEY;
    if (!secret || req.headers['x-admin-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!process.env.DATABASE_URL) {
      return res.status(400).json({ ok: false, error: 'DATABASE_URL is not set' });
    }
    try {
      const { execFile } = require('child_process');
      const scriptPath = path.join(__dirname, '../../scripts/migrate_sqlite_to_pg.js');
      res.json({ ok: true, message: 'Migration started — check Render logs for progress' });
      // Run async after response so the HTTP connection doesn't time out on large datasets
      execFile(
        'node',
        [scriptPath],
        { env: process.env, cwd: path.join(__dirname, '../..') },
        (err, stdout, stderr) => {
          if (err) console.error('[migrate-pg] FAILED:', err.message, stderr);
          else console.log('[migrate-pg] Complete:', stdout.trim());
        }
      );
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /internal/alert — New Relic webhook receiver (CPD-101)
  // NR alert policy sends here when PIPELINE_ESCALATION fires 3+ times in 1h.
  // Accepts NR webhook JSON. Authenticated via NR_ALERT_SECRET header.
  // Configure in New Relic: Alerts → Notification Channels → Webhook → URL: https://api.auraflux.co/internal/alert
  router.post('/internal/alert', webhookLimit, validateBodySize(65536), (req, res) => {
    const secret = process.env.NR_ALERT_SECRET;
    if (secret && req.headers['x-nr-alert-secret'] !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const payload = req.body || {};
    const severity = payload.severity || payload.current_state || 'unknown';
    const condition = payload.condition_name || payload.policy_name || '(unknown condition)';
    const details = payload.details || payload.message || JSON.stringify(payload).slice(0, 300);
    // Log to errors.jsonl
    const { logError } = require('../error_logger');
    logError('PIPELINE_NR_ALERT', new Error(`[NR] ${condition}: ${details}`), {
      nrPayload: { severity, condition, details },
    });
    // Emit so any attached listener (e.g. monitoring.js) can act
    try {
      const { monitoringBus } = require('../monitoring');
      monitoringBus.emit('nr_alert', { severity, condition, details, raw: payload });
    } catch (_e) { /* non-fatal */ }
    res.json({ ok: true, received: true });
  });

  return router;
};
