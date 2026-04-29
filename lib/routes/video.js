'use strict';
// C1+ — AI Video Generation (RunPod / WAN)
const router = require('express').Router();
const { generateWanVideo } = require('../ai/runpod');
const { strictLimit } = require('../rateLimiter');

// POST /api/generate-video
// Body: { prompt, negativePrompt?, width?, height?, numFrames?, seed? }
// Returns: { promptId } — poll GET /api/generate-video/:promptId for result
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
