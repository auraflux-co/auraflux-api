'use strict';

const fs = require('fs');
const path = require('path');
const { buildCompositionSpec, validateCompositionSpec, toGenerateClipCompBody, toGenerateClipCompJobs } = require('../composition_spec');
const { buildProductionPreflight } = require('../composition_preflight');
const {
  renderCompositionPreview,
  renderVodSegmentPreview,
  prepareComposerSourceReview,
  cleanupOldPreviews,
  PREVIEW_DIR,
} = require('../composition_preview');

const TEMPLATES_PATH = path.join(__dirname, '../../data/composition_templates.json');

function loadTemplates() {
  try {
    if (!fs.existsSync(TEMPLATES_PATH)) return [];
    return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8')).templates || [];
  } catch (_) {
    return [];
  }
}

function saveTemplates(templates) {
  fs.mkdirSync(path.dirname(TEMPLATES_PATH), { recursive: true });
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify({ templates }, null, 2));
}

function registerCompositionRoutes(app, deps = {}) {
  const twitchClient = deps.twitchClient || null;

  app.post('/composition/validate', (req, res) => {
    try {
      const { spec, validation } = buildCompositionSpec(req.body || {});
      res.json({ ok: validation.ok, spec, validation });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/preflight', (req, res) => {
    try {
      const built = buildCompositionSpec(req.body || {});
      let { spec, validation } = built;
      const preflight = buildProductionPreflight(spec);
      let dispatchJobs = [];
      let dispatchError = null;
      if (validation.ok) {
        try {
          dispatchJobs = toGenerateClipCompJobs(spec);
        } catch (err) {
          dispatchError = err.message;
          validation = {
            ...validation,
            ok: false,
            errors: [...(validation.errors || []), err.message],
          };
        }
      }
      res.json({
        ok: validation.ok && !dispatchError,
        spec,
        validation,
        preflight,
        dispatchJobs,
        dispatchError,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/composition/templates', (_req, res) => {
    try {
      const templates = loadTemplates();
      res.json({ ok: true, templates });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/templates', (req, res) => {
    try {
      const { name, compositionSpec } = req.body || {};
      if (!name || !compositionSpec) {
        return res.status(400).json({ ok: false, error: 'name and compositionSpec required' });
      }
      const validation = validateCompositionSpec(compositionSpec);
      if (!validation.ok && !req.body?.force) {
        return res.status(400).json({ ok: false, error: 'Invalid spec', validation });
      }
      const templates = loadTemplates();
      const id = `tpl_${Date.now()}`;
      const entry = {
        id,
        name: String(name).slice(0, 64),
        createdAt: new Date().toISOString(),
        deliveryFormat: compositionSpec.deliveryFormat,
        compCreativePreset: compositionSpec.compCreativePreset,
        compCreative: compositionSpec.compCreative,
        clipCount: (compositionSpec.clips || []).length,
        features: compositionSpec.features,
        compositionSpec,
      };
      templates.unshift(entry);
      saveTemplates(templates.slice(0, 50));
      res.json({ ok: true, template: entry });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/composition/templates/:id', (req, res) => {
    try {
      const templates = loadTemplates().filter((t) => t.id !== req.params.id);
      saveTemplates(templates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/composition/source-review/file/:name', (req, res) => {
    try {
      const name = path.basename(req.params.name || '');
      if (!/^srcrev_[\w.-]+\.mp4$/.test(name)) {
        return res.status(400).json({ ok: false, error: 'Invalid source review file' });
      }
      const filePath = path.join(PREVIEW_DIR, name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/source-review', async (req, res) => {
    cleanupOldPreviews();
    const body = req.body || {};
    const log = (m) => console.log(m);
    try {
      if (body.vodSegment?.vodUrl || body.deliveryFormat === 'vod_segment') {
        const result = await prepareComposerSourceReview({
          vodSegment: body.vodSegment,
          twitchClient,
          log,
        });
        return res.json(result);
      }
      const clip = body.clip || (Array.isArray(body.clips) && body.clips[0]) || null;
      if (!clip?.url && !clip?.pageUrl && !clip?.mp4Url && !clip?.stagedUrl) {
        return res.status(400).json({ ok: false, error: 'clip or vodSegment required' });
      }
      const result = await prepareComposerSourceReview({ clip, twitchClient, log });
      res.json(result);
    } catch (err) {
      console.error('[composition/source-review]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/composition/preview/file/:name', (req, res) => {
    try {
      const name = path.basename(req.params.name || '');
      const isJpeg = /^prev_[\w.-]+\.jpg$/.test(name) || /^vodprev_[\w.-]+\.jpg$/.test(name);
      const isMp4 = /^prev_[\w.-]+\.mp4$/.test(name);
      if (!isJpeg && !isMp4) {
        return res.status(400).json({ ok: false, error: 'Invalid preview file' });
      }
      const filePath = path.join(PREVIEW_DIR, name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
      res.setHeader('Content-Type', isMp4 ? 'video/mp4' : 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      if (isMp4) res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/preview', async (req, res) => {
    cleanupOldPreviews();
    const body = req.body || {};
    const log = (m) => console.log(m);
    try {
      const preset = body.compCreativePreset || 'classic_blur_pad';
      const overrides = body.compCreative || {};
      if (body.vodSegment?.vodUrl || body.deliveryFormat === 'vod_segment') {
        const seg = body.vodSegment || {};
        const result = await renderVodSegmentPreview({
          vodUrl: seg.vodUrl,
          startSec: seg.start_sec,
          endSec: seg.end_sec,
          durationSec: seg.duration_sec,
          compCreativePreset: preset,
          compCreativeOverrides: overrides,
          log,
        });
        return res.json({ ok: true, ...result });
      }
      const clip = body.clip || (Array.isArray(body.clips) && body.clips[0]) || null;
      if (!clip?.url && !clip?.pageUrl) {
        return res.status(400).json({ ok: false, error: 'clip or vodSegment required' });
      }
      const result = await renderCompositionPreview({
        clip,
        compCreativePreset: preset,
        compCreativeOverrides: overrides,
        twitchClient,
        log,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[composition/preview]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { registerCompositionRoutes, loadTemplates, saveTemplates };
