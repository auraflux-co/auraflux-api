'use strict';
/**
 * lib/services/gemini.js — Singleton Gemini service for AuraFlux C1+.
 *
 * Wraps lib/clients/gemini_client.js with:
 *   - Pre-initialized singleton (env key loaded once at startup)
 *   - Convenience helpers used across gate files and script_gen
 *   - Model constants (avoid magic strings scattered across files)
 *
 * Usage:
 *   const { gemini, GEMINI_FLASH, callGemini } = require('./services/gemini');
 *   const text = await callGemini(prompt, { maxOutputTokens: 500 });
 *   const result = await gemini.generateContent(prompt);
 *   const result = await gemini.analyzeVideo(filePath, prompt);
 */

const GeminiClient = require('../clients/gemini_client');

// ── Model constants ───────────────────────────────────────────────────────────

const GEMINI_FLASH     = 'gemini-2.5-flash';
const GEMINI_PRO       = 'gemini-2.5-pro';
const GEMINI_FLASH_2   = 'gemini-2.0-flash-exp';

const DEFAULT_MODEL = process.env.GEMINI_MODEL || GEMINI_FLASH;

// ── Singleton ─────────────────────────────────────────────────────────────────

let _client = null;

function getClient() {
  if (_client) return _client;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('[services/gemini] GEMINI_API_KEY is not set');
  _client = new GeminiClient(key, { model: DEFAULT_MODEL });
  return _client;
}

// ── Convenience helpers ───────────────────────────────────────────────────────

/**
 * Simple text generation — the most common Gemini call pattern.
 * Replaces inline `axios.post(generativelanguage.googleapis.com/...)` calls.
 *
 * @param {string} prompt
 * @param {Object} [opts]
 * @param {number} [opts.maxOutputTokens=1000]
 * @param {number} [opts.temperature=0.3]
 * @param {string} [opts.systemInstruction]
 * @param {string} [opts.model] — override default model
 * @returns {Promise<string>} generated text
 */
async function callGemini(prompt, opts = {}) {
  const client = opts.model && opts.model !== DEFAULT_MODEL
    ? new GeminiClient(process.env.GEMINI_API_KEY, { model: opts.model })
    : getClient();
  return client.generateContent(prompt, opts);
}

/**
 * Analyse a local video file with Gemini.
 * Uploads to Gemini Files API then calls generateContent.
 *
 * @param {string} filePath  — absolute path to video file
 * @param {string} prompt
 * @param {Object} [opts]
 * @returns {Promise<string>} generated text
 */
async function analyzeVideo(filePath, prompt, opts = {}) {
  return getClient().analyzeVideo(filePath, prompt, opts);
}

/**
 * Returns true if GEMINI_API_KEY is configured.
 * Use in /health checks.
 */
function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

module.exports = {
  getClient,
  callGemini,
  analyzeVideo,
  isConfigured,
  GEMINI_FLASH,
  GEMINI_PRO,
  GEMINI_FLASH_2,
  DEFAULT_MODEL,
};
