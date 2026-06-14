'use strict';
/**
 * lib/customerConfig.js — Customer Config Loader
 *
 * Loads per-customer configuration from config/customers/{customerId}.json.
 * customerId is always the Clerk user ID (e.g. 'user_3DeZEr79TWcmvEvCMlu8lmM1FdU').
 *
 * Fallback chain:
 *   known Clerk ID with a matching JSON file → that file
 *   any unknown ID → c1_default (generic C1+ baseline)
 *
 * Gate files call loadCustomerConfig(jobSpec.customerId) to read QA thresholds,
 * voice rules, and design defaults — never hardcode customer IDs.
 */

const fs = require('fs');
const path = require('path');

const CUSTOMERS_DIR = path.join(__dirname, '..', 'config', 'customers');
const C1_DEFAULT_ID = 'c1_default';

// Cache loaded configs in memory
const _cache = new Map();

/**
 * Load customer config by customerId.
 * Returns the parsed config object.
 *
 * Fallback chain for unknown customer IDs:
 *   any ID with a matching JSON file → that file
 *   any unknown ID → c1_default (generic C1+ baseline)
 *
 * @param {string} customerId - Clerk user ID e.g. 'user_3DeZEr79TWcmvEvCMlu8lmM1FdU'
 * @param {string} [templateId] - e.g. 'long-form' or 'short-form'
 * @returns {Object} customer config (templates block for templateId, or full config)
 */
function loadCustomerConfig(customerId, templateId) {
  const id = customerId || C1_DEFAULT_ID;
  const cacheKey = `${id}:${templateId || ''}`;

  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  let config;
  const filePath = path.join(CUSTOMERS_DIR, `${id}.json`);

  try {
    config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (id !== C1_DEFAULT_ID) {
      // Unknown customer — fall back to c1_default
      const fallbackPath = path.join(CUSTOMERS_DIR, `${C1_DEFAULT_ID}.json`);
      try {
        config = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
      } catch (e) {
        config = {};
      }
    } else {
      config = {};
    }
  }

  // If templateId is requested, return the template sub-block
  if (templateId && config.templates && config.templates[templateId]) {
    const result = config.templates[templateId];
    _cache.set(cacheKey, result);
    return result;
  }

  _cache.set(cacheKey, config);
  return config;
}

/**
 * Get QA thresholds for a gate from customer config.
 * Returns the gate thresholds object or a default fallback.
 *
 * @param {string} customerId
 * @param {string} templateId - 'long-form' or 'short-form'
 * @param {string} gateKey - e.g. 'gate0', 'gate1', 'gate2', 'gate3a', 'gate4'
 * @param {Object} [defaults] - fallback values if config not found
 * @returns {Object}
 */
function getPortalThresholds(customerId, templateId, gateKey, defaults = {}) {
  try {
    const template = loadCustomerConfig(customerId, templateId);
    return template?.qaThresholds?.[gateKey] || defaults;
  } catch {
    return defaults;
  }
}

/**
 * Get voice config (prohibitedWords, outroLine, speakerName) from customer config.
 *
 * @param {string} customerId
 * @param {string} templateId
 * @returns {Object}
 */
function getVoiceConfig(customerId, templateId) {
  try {
    const template = loadCustomerConfig(customerId, templateId);
    return template?.voice || {};
  } catch {
    return {};
  }
}

function clearCustomerConfigCache() {
  _cache.clear();
}

module.exports = { loadCustomerConfig, getPortalThresholds, getVoiceConfig, clearCustomerConfigCache };
