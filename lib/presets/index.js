'use strict';
/**
 * Content Presets — CPD-24
 *
 * resolvePreset(presetId, overrides) → merged job request body
 *
 * Presets are restrictions LIFTED — the caller can pass overrides to any
 * preset field and they will take precedence over the preset defaults.
 */

const PRESETS = require('./definitions');

const PRESET_IDS = Object.keys(PRESETS);

/**
 * Returns the preset definition or null if not found.
 * @param {string} presetId
 * @returns {object|null}
 */
function getPreset(presetId) {
  return PRESETS[presetId] || null;
}

/**
 * Resolves a preset + caller overrides into a normalised job request body
 * ready to pass to createJobSpec().
 *
 * @param {string} presetId
 * @param {object} overrides — caller-supplied fields that override preset defaults
 * @returns {{ resolved: object, preset: object } | { error: string }}
 */
function resolvePreset(presetId, overrides = {}) {
  const preset = getPreset(presetId);
  if (!preset) {
    return { error: `Unknown preset: ${presetId}. Valid presets: ${PRESET_IDS.join(', ')}` };
  }

  const resolved = {
    entry:       overrides.entry       || preset.entry,
    contentType: overrides.contentType || preset.contentType,
    templateId:  overrides.templateId  || preset.templateId,
    sourceHints: { ...preset.sourceHints, ...(overrides.sourceHints || {}) },
    stageLock:   { ...preset.stageLock,   ...(overrides.stageLock   || {}) },
    addOns:      { ...preset.addOnDefaults, ...(overrides.addOns    || {}) },
    // Pass through any other caller overrides (url, fileId, prompt, etc.)
    ...overrides,
  };

  return { resolved, preset };
}

module.exports = { getPreset, resolvePreset, PRESET_IDS };
