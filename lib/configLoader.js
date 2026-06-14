/**
 * configLoader.js — Universal content-type config loader
 *
 * Provides typed accessors over config/contentTypes.json.
 * All pipeline code should use these helpers instead of hardcoding
 * thresholds, avatar IDs, or per-content-type flags.
 *
 * env: references in the JSON are resolved to process.env at call time.
 */
'use strict';

const contentTypesConfig = require('../config/contentTypes.json');
const { normalizeContentType } = require('./content_type');

/**
 * Return the full config block for a content type (e.g. "twitch", "sports-short").
 * Accepts legacy aliases (`nba` → `sports`). Throws if unrecognised.
 */
function getContentTypeConfig(contentType) {
  const canonical = normalizeContentType(contentType);
  let config = contentTypesConfig.contentTypes[contentType]
    || contentTypesConfig.contentTypes[canonical];
  if (config?.aliasOf) {
    config = contentTypesConfig.contentTypes[config.aliasOf] || config;
  }
  if (!config) throw new Error(`Unknown contentType: ${contentType}`);
  return config;
}

/**
 * Resolve an "env:VAR_NAME" string to its env-var value.
 * Passes non-env values through unchanged.
 */
function resolveEnvVar(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] || null;
  }
  return value;
}

/**
 * HeyGen config for a content type.
 * avatarId is resolved from the environment at call time.
 */
function getHeyGenConfig(contentType) {
  const config = getContentTypeConfig(contentType);
  if (!config.heygen || config.clipsOnly) return null;
  return {
    ...config.heygen,
    avatarId: resolveEnvVar(config.heygen.avatarId),
  };
}

/** QA gate thresholds for a content type. */
function getQAThresholds(contentType) {
  return getContentTypeConfig(contentType).qa;
}

/** Assembly config (chrome skin, ticker key, layout, sourceCrop, voiceover). */
function getAssemblyConfig(contentType) {
  return getContentTypeConfig(contentType).assembly;
}

/** Publish config (platforms, pinnedCommentKey). */
function getPublishConfig(contentType) {
  return getContentTypeConfig(contentType).publish;
}

/**
 * Returns true when the content type is a short-form (9:16) format.
 * Use this instead of contentType.includes('-short') or format === 'portrait'.
 */
function isShortForm(contentType) {
  return getContentTypeConfig(contentType).formFactor === 'short';
}

module.exports = {
  getContentTypeConfig,
  getHeyGenConfig,
  getQAThresholds,
  getAssemblyConfig,
  getPublishConfig,
  isShortForm,
  contentTypesConfig,
};
