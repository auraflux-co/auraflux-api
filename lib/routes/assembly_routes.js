'use strict';
// C0 — Assembly, Drive upload, Canva import, Ticker baking
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { body, validationResult } = require('express-validator');
const { handleAssemble, assemblyJobs, captureTicker, TICKER_CACHE, TICKER_MAP } = require('../assembly');
const { getJobSpec } = require('../job_spec');
const { saveJobCard } = require('../job_card');
const { uploadToDrive } = require('../publish');
const { requireFields, validateContentType } = require('../validation');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

// In-memory Canva job state (C0 only)
const canvaJobs = {};

// POST /upload-to-drive — manual trigger from dashboard
router.post('/upload-to-drive', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found: ' + filename });

  try {
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl)
      return res
        .status(400)
        .json({ error: 'cwn-drive-key.json not found in Downloads. See setup instructions.' });
    res.json({ ok: true, driveUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /drive-then-canva — upload to Drive and auto-import to Canva
router.post('/drive-then-canva', async (req, res) => {
  const { filename, title } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const filePath = path.join(OUTPUT_DIR, path.basename(filename));
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found: ' + filename });

  res.json({ ok: true, message: 'Upload started — check /assemble-progress for status' });

  try {
    console.log(`[drive-then-canva] Starting for: ${filename}`);
    const driveUrl = await uploadToDrive(filePath, filename, title || filename);
    if (!driveUrl) {
      console.warn('[drive-then-canva] No Drive key configured');
      return;
    }
    console.log(`[drive-then-canva] Drive URL: ${driveUrl}`);
    console.log(`[drive-then-canva] Paste that URL in Claude chat to import to Canva`);
  } catch (err) {
    console.error('[drive-then-canva] Error:', err.message);
  }
});

router.post(
  '/assemble',
  body('asmId').optional().isString().trim(),
  body('segments').isArray(),
  body('contentType').isString(),
  body('formType').optional().isString(),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  },
  requireFields('segments', 'segmentData'),
  validateContentType(['twitch', 'nba', 'news', 'twitch-short', 'nba-short', 'news-short']),
  async (req, res) => {
    const jobId = req.body.jobSpecId || req.body.asmId;
    if (jobId) {
      try {
        req.jobSpec = await getJobSpec(jobId);
      } catch (e) {
        console.warn(`[assemble] No job spec found for ${jobId} — proceeding without`);
      }
    }
    handleAssemble(req, res, saveJobCard);
  }
);

// GET /assemble-progress/:id
router.get('/assemble-progress/:id', (req, res) => {
  const job = assemblyJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const logOffset = parseInt(req.query.offset) || 0;
  const fullLog = job.log || '';
  const newLog = fullLog.slice(logOffset);

  res.json({
    pct: job.pct,
    tickerPct: job.tickerPct || null,
    status: job.status,
    error: job.error || null,
    log: newLog,
    logOffset: fullLog.length,
    outputPath: job.outputPath,
    filename: job.filename,
    duration: job.duration,
    segmentDurations: job.segmentDurations || null,
    gate2Score: job.gate2Score || null,
    gate2Outcome: job.gate2Outcome || null,
    downloadUrl: job.filename ? `/download/${job.filename}` : null,
    thumbFilename: job.thumbFilename || null,
  });
});

// GET /download/:file — serve assembled video or thumbnail frame
router.get('/download/:file', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.file));
  if (!fs.existsSync(filePath)) {
    const tmpPath = path.join(TMP_DIR, path.basename(req.params.file));
    if (fs.existsSync(tmpPath)) return res.download(tmpPath);
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});

// GET /thumbnail/:assemblyId — get extracted thumbnail frame for a job
router.get('/thumbnail/:assemblyId', (req, res) => {
  const job = assemblyJobs[req.params.assemblyId];
  if (!job || !job.thumbFrame || !fs.existsSync(job.thumbFrame)) {
    return res.status(404).json({ error: 'No thumbnail frame available' });
  }
  res.sendFile(job.thumbFrame);
});

// POST /canva-import — proxy a HeyGen video URL into Canva via Anthropic Claude + Canva MCP
router.post('/canva-import', async (req, res) => {
  const { videoUrl, label } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

  const jobId = 'canva_' + Date.now();
  canvaJobs[jobId] = { status: 'pending', design_url: null, error: null };

  res.json({ ok: true, job_id: jobId });

  const runCanva = async () => {
    try {
      canvaJobs[jobId].status = 'in_progress';

      const client = new Anthropic();

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are a production assistant. Use the Canva MCP tool to import the provided video URL into a new Canva design. 
Call import-design-from-url with the URL provided. Then call get-design-import-from-url-status to get the result.
Return ONLY a JSON object with keys: design_id, design_url, status. No other text.`,
        messages: [
          {
            role: 'user',
            content: `Import this video into Canva: ${videoUrl}\nLabel: ${label || 'CWN Video'}\nReturn JSON with design_id and design_url.`,
          },
        ],
        mcp_servers: [
          {
            type: 'url',
            url: 'https://mcp.canva.com/mcp',
            name: 'canva-mcp',
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock) throw new Error('No text response from Claude');

      let parsed;
      try {
        const clean = textBlock.text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch (e) {
        const urlMatch = textBlock.text.match(/https:\/\/www\.canva\.com\/design\/[^\s"']+/);
        if (urlMatch) {
          parsed = { design_url: urlMatch[0], status: 'success' };
        } else {
          throw new Error('Could not parse Canva response: ' + textBlock.text.slice(0, 200));
        }
      }

      canvaJobs[jobId].status = 'success';
      canvaJobs[jobId].design_url = parsed.design_url || parsed.url;
      canvaJobs[jobId].design_id = parsed.design_id;
      console.log(`[canva] Import complete: ${canvaJobs[jobId].design_url}`);
    } catch (err) {
      console.error('[canva] Import failed:', err.message);
      canvaJobs[jobId].status = 'failed';
      canvaJobs[jobId].error = err.message;
    }
  };

  runCanva();
});

// GET /canva-import-status/:id
router.get('/canva-import-status/:id', (req, res) => {
  const job = canvaJobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /ticker-status — check which tickers are cached
router.get('/ticker-status', (req, res) => {
  res.json({
    cached: Object.keys(TICKER_CACHE),
    available: Object.keys(TICKER_MAP),
    puppeteerInstalled: (() => {
      try {
        require('puppeteer');
        return true;
      } catch (e) {
        return false;
      }
    })(),
  });
});

// POST /precapture-tickers — warm up ticker cache before assembly
router.post('/precapture-tickers', async (req, res) => {
  const types = (req.body && req.body.types) || Object.keys(TICKER_MAP);
  const captured = [],
    failed = [];

  console.log(`[ticker] Pre-capturing tickers: ${types.join(', ')}`);
  for (const type of types) {
    try {
      const p = await captureTicker(type);
      if (p) {
        captured.push(type);
        console.log(`[ticker] ✓ ${type}`);
      } else {
        failed.push(type);
      }
    } catch (e) {
      failed.push(type);
      console.warn(`[ticker] ✗ ${type}: ${e.message}`);
    }
  }
  res.json({ ok: true, captured, failed });
});

// POST /capture-ticker — pre-capture a ticker on demand
router.post('/capture-ticker', async (req, res) => {
  const { contentType } = req.body;
  if (!TICKER_MAP[contentType])
    return res.status(400).json({ error: 'Unknown content type. Use: nba, news, twitch' });
  delete TICKER_CACHE[contentType];
  res.json({ ok: true, message: `Capturing ${contentType} ticker in background...` });
  captureTicker(contentType).catch((e) =>
    console.warn('[ticker] Background capture failed:', e.message)
  );
});

module.exports = router;
