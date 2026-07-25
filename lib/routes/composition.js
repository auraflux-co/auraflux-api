'use strict';

const fs = require('fs');
const path = require('path');
const { buildCompositionSpec, validateCompositionSpec, toGenerateClipCompBody, toGenerateClipCompJobs } = require('../composition_spec');
const { buildProductionPreflight } = require('../composition_preflight');
const {
  renderCompositionPreview,
  renderCompositionTimelinePreview,
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
      const preflight = validation.ok ? buildProductionPreflight(spec) : null;
      res.json({ ok: validation.ok, spec, validation, preflight });
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
          sourceCleanup: body.sourceCleanup || body.compCreative?.sourceCleanup || null,
          compCreative: body.compCreative || null,
          log,
        });
        return res.json(result);
      }
      const clip = body.clip || (Array.isArray(body.clips) && body.clips[0]) || null;
      if (!clip?.url && !clip?.pageUrl && !clip?.mp4Url && !clip?.stagedUrl) {
        return res.status(400).json({ ok: false, error: 'clip or vodSegment required' });
      }
      const result = await prepareComposerSourceReview({
        clip,
        twitchClient,
        sourceCleanup: body.sourceCleanup || body.compCreative?.sourceCleanup || null,
        compCreative: body.compCreative || null,
        log,
      });
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
      const isMp4 = /^prev_[\w.-]+\.mp4$/.test(name) || /^tlprev_[\w.-]+\.mp4$/.test(name);
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
      const deliveryAspect = body.deliveryAspect === '1:1' ? '1:1' : '9:16';
      if (body.vodSegment?.vodUrl || body.deliveryFormat === 'vod_segment') {
        const seg = body.vodSegment || {};
        const result = await renderVodSegmentPreview({
          vodUrl: seg.vodUrl,
          startSec: seg.start_sec,
          endSec: seg.end_sec,
          durationSec: seg.duration_sec,
          compCreativePreset: preset,
          compCreativeOverrides: overrides,
          deliveryAspect,
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
        deliveryAspect,
        twitchClient,
        log,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[composition/preview]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/timeline-preview', async (req, res) => {
    cleanupOldPreviews();
    const body = req.body || {};
    const log = (m) => console.log(m);
    try {
      const preset = body.compCreativePreset || 'classic_blur_pad';
      const overrides = body.compCreative || {};
      const deliveryAspect = body.deliveryAspect === '1:1' ? '1:1' : '9:16';
      if (body.vodSegment?.vodUrl || body.deliveryFormat === 'vod_segment') {
        const seg = body.vodSegment || {};
        const clip = {
          url: seg.vodUrl,
          pageUrl: seg.vodUrl,
          platform: 'youtube',
          trimStart: seg.start_sec,
          trimEnd: seg.end_sec,
          title: seg.title || '',
        };
        const result = await renderCompositionTimelinePreview({
          clip,
          compCreativePreset: preset,
          compCreativeOverrides: overrides,
          deliveryAspect,
          twitchClient,
          log,
        });
        return res.json({ ok: true, ...result });
      }
      const clip = body.clip || (Array.isArray(body.clips) && body.clips[0]) || null;
      if (!clip?.url && !clip?.pageUrl && !clip?.mp4Url && !clip?.stagedUrl) {
        return res.status(400).json({ ok: false, error: 'clip or vodSegment required' });
      }
      const result = await renderCompositionTimelinePreview({
        clip,
        compCreativePreset: preset,
        compCreativeOverrides: overrides,
        deliveryAspect,
        twitchClient,
        log,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[composition/timeline-preview]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/composition/caption-styles', (_req, res) => {
    try {
      const { CAPTION_STYLE_OPTIONS } = require('../clip_comp_creative');
      res.json({ ok: true, styles: CAPTION_STYLE_OPTIONS });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/moment-finder', async (req, res) => {
    const { findMoments, momentsToCompositionClips } = require('../moment_finder');
    const body = req.body || {};
    const version = Math.max(1, Number(body.version) || 1);
    try {
      const result = await findMoments({
        vodUrl: body.vodUrl,
        rangeStart: body.rangeStart,
        rangeEnd: body.rangeEnd,
        prompt: body.prompt,
        minDurationSec: body.minDurationSec,
        maxDurationSec: body.maxDurationSec,
        maxCandidates: body.maxCandidates,
        title: body.title,
        durationSec: body.durationSec,
        log: (m) => console.log(m),
      });
      const clips = momentsToCompositionClips(result.moments, result.vodUrl, body.streamer || '');
      let competitorHints = null;
      try {
        const { competitorPatterns } = require('../intelligence/competitors');
        competitorHints = competitorPatterns({ limit: 5 });
      } catch (_) { /* offline */ }
      res.json({ ok: true, ...result, clips, version, competitorHints });
    } catch (err) {
      console.error('[composition/moment-finder]', err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/moment-finder/reprompt', async (req, res) => {
    const { findMoments, momentsToCompositionClips } = require('../moment_finder');
    const body = req.body || {};
    const version = Math.max(1, (Number(body.version) || 0) + 1);
    try {
      const result = await findMoments({
        vodUrl: body.vodUrl,
        rangeStart: body.rangeStart,
        rangeEnd: body.rangeEnd,
        prompt: body.prompt,
        minDurationSec: body.minDurationSec,
        maxDurationSec: body.maxDurationSec,
        maxCandidates: body.maxCandidates,
        title: body.title,
        durationSec: body.durationSec,
        log: (m) => console.log(m),
      });
      const clips = momentsToCompositionClips(result.moments, result.vodUrl, body.streamer || '');
      let competitorHints = null;
      try {
        const { competitorPatterns } = require('../intelligence/competitors');
        competitorHints = competitorPatterns({ limit: 5 });
      } catch (_) { /* offline */ }
      res.json({ ok: true, ...result, clips, version, reprompted: true, competitorHints });
    } catch (err) {
      console.error('[composition/moment-finder/reprompt]', err.message);
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.get('/composition/competitor-hints', (_req, res) => {
    try {
      const { competitorPatterns } = require('../intelligence/competitors');
      const block = competitorPatterns({ limit: 8 });
      res.json({ ok: true, ...(block || { outliers: [], promptBlock: '' }) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/detect-silence', async (req, res) => {
    const { detectSilenceOnFile } = require('../composition_silence');
    const body = req.body || {};
    try {
      const filePath = body.filePath || body.localPath;
      if (!filePath) return res.status(400).json({ ok: false, error: 'filePath required' });
      const result = await detectSilenceOnFile(filePath, {
        offsetSec: Number(body.trimStart) || 0,
        thresholdDb: body.thresholdDb,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // CPD-1282: energy peaks → punch/shake suggestions for Compose
  app.post('/composition/analyze-beats', async (req, res) => {
    const { analyzeBeatsOnFile } = require('../beat_detect');
    const body = req.body || {};
    try {
      const filePath = body.filePath || body.localPath;
      if (!filePath) return res.status(400).json({ ok: false, error: 'filePath required' });
      const result = await analyzeBeatsOnFile(filePath, {
        maxPeaks: body.maxPeaks != null ? Number(body.maxPeaks) : 6,
        minGapSec: body.minGapSec != null ? Number(body.minGapSec) : 0.85,
        thresholdRatio: body.thresholdRatio != null ? Number(body.thresholdRatio) : 1.35,
        maxSec: body.maxSec != null ? Number(body.maxSec) : 90,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/composition/export/fcpxml', (req, res) => {
    try {
      const { buildFcpxml } = require('../composition_fcpxml');
      const { spec } = buildCompositionSpec(req.body || {});
      const isSquare = spec.deliveryAspect === '1:1';
      const xml = buildFcpxml({
        title: (spec.clips && spec.clips[0] && spec.clips[0].title) || 'AuraFlux Export',
        clips: spec.clips || [],
        width: 1080,
        height: isSquare ? 1080 : 1920,
      });
      res.setHeader('Content-Type', 'application/xml');
      res.send(xml);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
}

module.exports = { registerCompositionRoutes, loadTemplates, saveTemplates };
