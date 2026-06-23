'use strict';
/**
 * lib/gemini_json_parse.js — robust JSON extraction from Gemini text responses.
 * Shared by Hook Machine, lead-title pick, and other clip-comp Gemini calls.
 */

function stripMarkdownFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Extract first balanced JSON object from text; repair truncated closing braces.
 */
function extractJsonObject(text) {
  const cleaned = stripMarkdownFences(text);
  const start = cleaned.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }

  let fragment = cleaned.slice(start);
  const open = (fragment.match(/\{/g) || []).length;
  const close = (fragment.match(/\}/g) || []).length;
  for (let j = 0; j < open - close; j++) fragment += '}';
  fragment = fragment.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  return fragment;
}

function parseJsonLoose(raw) {
  const fragment = extractJsonObject(raw);
  if (!fragment) return null;
  try {
    return JSON.parse(fragment);
  } catch (_) {
    try {
      return JSON.parse(fragment.replace(/,\s*([}\]])/g, '$1'));
    } catch (_2) {
      return null;
    }
  }
}

module.exports = {
  stripMarkdownFences,
  extractJsonObject,
  parseJsonLoose,
};
