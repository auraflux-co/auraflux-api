'use strict';
/**
 * lib/routes/video.js — Standalone AI Video Generation (RunPod / WAN) utility endpoint
 *
 * WARNING — PIPELINE BYPASS:
 *   POST /api/generate-video fires WAN directly and returns raw files.
 *   It creates NO job spec, runs through NO portals, and has NO QA validation.
 *   This endpoint exists for direct RunPod access and tooling/testing purposes only.
 *
 *   For production job submissions that should run through the portal pipeline:
 *     → Use POST /jobs with entry='generate' (lib/routes/jobs_c1.js)
 *       This creates a job spec, fires WAN, and routes output through Portal 0 → full pipeline.
 *
 *   CPD-69 wires the POST /jobs generate entry to the portal pipeline.
 *   This file (POST /api/generate-video) is intentionally left as a standalone utility.
 */
const router = require('express').Router();
const { generateWanVideo } = require('../ai/runpod');
const { strictLimit } = require('../rateLimiter');

// POST /api/generate-video
// Body: { prompt, negativePrompt?, width?, height?, numFrames?, seed? }
// Returns: { promptId } — poll GET /api/generate-video/:promptId for result
// NOTE: Pipeline bypass — see file header. For portal-routed generation use POST /jobs.
router.post('/api/generate-video', strictLimit, async (req, res) => {
  try {
    const { prompt, negativePrompt, width, height, numFrames, seed } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const outputPrefix = `wan_${Date.now()}`;
    const promptId = await generateWanVideo({
      positivePrompt: prompt,
      negativePrompt,
      width: width || 832,
      height: height || 480,
      numFrames: numFrames || 25,
      seed,
      outputPrefix,
    });

    res.json({ promptId, outputPrefix, status: 'queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/generate-video/:promptId
// Polls ComfyUI for job completion. Returns { status, files } when done.
router.get('/api/generate-video/:promptId', async (req, res) => {
  try {
    const { promptId } = req.params;
    const podId = process.env.RUNPOD_POD_ID;
    const base = `https://${podId}-8188.proxy.runpod.net`;

    const resp = await fetch(`${base}/history/${promptId}`);
    const history = await resp.json();

    if (!history[promptId]) return res.json({ status: 'running' });

    const info = history[promptId];
    const statusStr = info?.status?.status_str;
    if (statusStr === 'error') {
      const errMsg = info.status.messages.find((m) => m[0] === 'execution_error');
      return res.status(500).json({ status: 'error', error: errMsg?.[1]?.exception_message });
    }

    const files = [];
    for (const out of Object.values(info.outputs || {})) {
      for (const fileList of Object.values(out)) {
        for (const f of Array.isArray(fileList) ? fileList : [fileList]) {
          if (f?.filename)
            files.push({ filename: f.filename, url: `${base}/view?filename=${f.filename}` });
        }
      }
    }

    res.json({ status: 'success', files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
