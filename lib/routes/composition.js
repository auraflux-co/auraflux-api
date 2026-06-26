'use strict';

const fs = require('fs');
const path = require('path');
const { buildCompositionSpec, validateCompositionSpec } = require('../composition_spec');

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

function registerCompositionRoutes(app) {
  app.post('/composition/validate', (req, res) => {
    try {
      const { spec, validation } = buildCompositionSpec(req.body || {});
      res.json({ ok: validation.ok, spec, validation });
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
}

module.exports = { registerCompositionRoutes, loadTemplates, saveTemplates };
