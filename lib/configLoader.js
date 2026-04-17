'use strict';
/**
 * configLoader.js
 *
 * Reads config/contentTypes.json and exposes lookup helpers for the pipeline.
 * Phase 1 of the universal architecture refactor (UNIVERSAL_ARCHITECTURE_RECOMMENDATIONS.md).
 *
 * Usage:
 *   const { getContentTypeConfig, getAssemblyConfig } = require('./lib/configLoader');
 *   const cfg = getContentTypeConfig('nba');      // full content-type config object
 *   const asm = getAssemblyConfig('nba');         // cfg.assembly shorthand
 */

const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'contentTypes.json');

let _cache = null;

/**
 * Load and cache config/contentTypes.json.
 * Returns the full parsed JSON (with top-level "contentTypes" key).
 */
function loadConfig() {
  if (!_cache) {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    _cache = JSON.parse(raw);
  }
  return _cache;
}

/**
 * Return the config object for a given contentType string.
 * Normalises the key: strips trailing "-short" variants to match "twitch-short" etc.
 * Falls back to null if the content type is unknown.
 *
 * @param {string} contentType  e.g. "twitch", "nba", "news", "twitch-short"
 * @returns {object|null}
 */
function getContentTypeConfig(contentType) {
  const cfg = loadConfig();
  const types = cfg.contentTypes || {};

  // Exact match first
  if (types[contentType]) return types[contentType];

  // Normalise: some callers pass "twitch-compilation", map to "twitch"
  const base = contentType ? contentType.replace(/-compilation$/i, '') : contentType;
  if (base && types[base]) return types[base];

  return null;
}

/**
 * Return only the assembly sub-config for a content type.
 * Returns an empty object if the content type has no assembly config.
 *
 * @param {string} contentType
 * @returns {object}
 */
function getAssemblyConfig(contentType) {
  const cfg = getContentTypeConfig(contentType);
  return (cfg && cfg.assembly) ? cfg.assembly : {};
}

module.exports = { loadConfig, getContentTypeConfig, getAssemblyConfig };
