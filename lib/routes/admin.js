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
// GET  /disk-usage
// GET  /errors
//
// Factory: createAdminRouter({ _healthCache, BUILD_INFO })
// _healthCache is passed by reference so the route always reads the latest cached values.

const fs     = require('fs');
const path   = require('path');
const router = require('express').Router();

const { readJiraQueue, writeJiraQueue, JIRA_WEBHOOK_SECRET } = require('../jira_queue');
const { getErrorRate, getRecentErrors, ERROR_LOG }           = require('../error_logger');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const TMP_DIR    = path.join(__dirname, '..', '..', 'tmp');
const ROOT_DIR   = path.join(__dirname, '..', '..');

module.exports = function createAdminRouter({ _healthCache, BUILD_INFO }) {

  // GET /health
  router.get('/health', (req, res) => {
    const errors = [];
    if (_healthCache.ffmpeg.status === 'error') errors.push('FFmpeg not available');
    Object.entries(_healthCache.apiKeys).forEach(([k, v]) => {
      if (v.status === 'missing') errors.push(`${k} not configured`);
    });
    Object.entries(_healthCache.directories).forEach(([, v]) => {
      if (!v.exists) errors.push(`${v.path} directory not accessible`);
    });
    if (_healthCache.freeSpaceGB !== null && _healthCache.freeSpaceGB < 5) {
      errors.push(`Low disk space: ${_healthCache.freeSpaceGB}GB remaining`);
    }
    const statusCode = errors.length === 0 ? 200 : 503;
    res.status(statusCode).json({
      ok: errors.length === 0,
      version:    BUILD_INFO.version,
      gitHash:    BUILD_INFO.gitHash,
      gitBranch:  BUILD_INFO.gitBranch,
      lastCommit: BUILD_INFO.lastCommit,
      deployedAt: BUILD_INFO.deployedAt,
      timestamp:  new Date().toISOString(),
      uptime:     process.uptime(),
      cacheAge:   _healthCache.lastRefreshed,
      dependencies: { ffmpeg: _healthCache.ffmpeg, ..._healthCache.apiKeys, vectcut: _healthCache.vectcut },
      directories: _healthCache.directories,
      errors,
    });
  });

  // C0-only HTML tools — served from localhost for C0 operator use.
  // These routes are intentionally kept as reference implementations.
  // C1+ will serve equivalent tools from the Next.js frontend.
  router.get('/news-tool',       (req, res) => res.sendFile(path.join(ROOT_DIR, 'cwn_news_tool.html')));
  router.get('/newscast-overlay', (req, res) => res.sendFile(path.join(ROOT_DIR, 'tools', 'clipzworld_newscast.html')));
  router.get('/twitch-tool',     (req, res) => res.sendFile(path.join(ROOT_DIR, 'cwn_twitch_tool.html')));

  // C0-only: Twitch credentials for browser-side Twitch API (ticker overlay, clips, etc.)
  // C1+ equivalent will be gated behind customer auth, not a public env-var endpoint.
  router.get('/twitch-token', (req, res) => {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token    = process.env.TWITCH_TOKEN;
    if (!clientId || !token) return res.status(503).json({ error: 'Twitch credentials not configured' });
    res.json({ clientId, token });
  });

  // C0-only: market data API keys surfaced to browser (FMP, Finnhub for news overlays).
  // C1+ will proxy market data server-side; keys will not be sent to the client.
  router.get('/market-keys', (req, res) => {
    res.json({ fmp: process.env.FMP_API_KEY || '', finnhub: process.env.FINNHUB_API_KEY || '' });
  });

  // POST /api/jira-webhook
  router.post('/api/jira-webhook', (req, res) => {
    try {
      const { secret } = req.query;
      if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'invalid secret' });
      }
      const payload = req.body;
      const issue   = payload?.issue;
      if (!issue) return res.status(400).json({ error: 'no issue in payload' });

      const key         = issue.key;
      const summary     = issue.fields?.summary     || '';
      const description = issue.fields?.description || '';
      const labels      = issue.fields?.labels      || [];
      const status      = issue.fields?.status?.name || '';
      const priority    = issue.fields?.priority?.name || 'Medium';
      const event       = payload.webhookEvent || '';

      const isAider = labels.includes('aider');
      const isCursor = labels.includes('cursor');
      const isRovo   = labels.includes('rovo');
      if (!isAider && !isCursor && !isRovo) {
        return res.json({ queued: false, reason: 'no aider/cursor/rovo label' });
      }

      const queue = readJiraQueue();
      const existingIdx = queue.findIndex((t) => t.key === key && t.processed === false);
      const entry = {
        key, summary,
        description: typeof description === 'string' ? description : JSON.stringify(description),
        labels, status, priority,
        agent: isAider ? 'aider' : isRovo ? 'rovo' : 'cursor',
        event, receivedAt: new Date().toISOString(), processed: false,
      };

      if (existingIdx >= 0) queue[existingIdx] = entry;
      else queue.push(entry);

      writeJiraQueue(queue);
      console.log(`[jira-webhook] queued ${key} (${summary}) for ${entry.agent}`);
      res.status(202).json({ queued: true, key, agent: entry.agent });
    } catch (err) {
      console.error('[jira-webhook] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/jira-queue
  router.get('/api/jira-queue', (req, res) => {
    const { secret } = req.query;
    if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET) return res.status(403).json({ error: 'invalid secret' });
    res.json(readJiraQueue().filter((t) => !t.processed));
  });

  // POST /api/jira-queue/:issueKey/done
  router.post('/api/jira-queue/:issueKey/done', (req, res) => {
    const { secret } = req.query;
    if (JIRA_WEBHOOK_SECRET && secret !== JIRA_WEBHOOK_SECRET) return res.status(403).json({ error: 'invalid secret' });
    const { issueKey } = req.params;
    const queue = readJiraQueue();
    const item  = queue.find((t) => t.key === issueKey);
    if (!item) return res.status(404).json({ error: 'not found' });
    item.processed   = true;
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
          const fp   = path.join(OUTPUT_DIR, f);
          const stat = fs.statSync(fp);
          return { name: f, sizeMB: parseFloat((stat.size / 1024 / 1024).toFixed(1)), mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const tmpSize = fs.readdirSync(TMP_DIR).reduce((acc, f) => {
        try { return acc + fs.statSync(path.join(TMP_DIR, f)).size; } catch (_e) { return acc; }
      }, 0);

      const totalMB = outputFiles.reduce((a, f) => a + f.sizeMB, 0) + tmpSize / 1024 / 1024;
      res.json({ ok: true, outputFiles, tmpMB: parseFloat((tmpSize / 1024 / 1024).toFixed(1)), totalMB: parseFloat(totalMB.toFixed(1)) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /errors
  router.get('/errors', (req, res) => {
    const n     = parseInt(req.query.n) || 50;
    const label = req.query.label || null;
    const rate  = getErrorRate();
    let recent  = getRecentErrors(n);
    if (label) recent = recent.filter((e) => e.label === label);
    res.json({ ok: true, errorRate: rate, recent, logFile: ERROR_LOG });
  });

  return router;
};
