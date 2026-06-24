'use strict';
/**
 * lib/gemini_json_parse.js — robust JSON extraction from Gemini text responses.
 * Shared by Hook Machine, lead-title pick, and other clip-comp Gemini calls.
 */

function stripMarkdownFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
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
  if (inStr) fragment += '"';
  const openSq = (fragment.match(/\[/g) || []).length;
  const closeSq = (fragment.match(/\]/g) || []).length;
  for (let j = 0; j < openSq - closeSq; j++) fragment += ']';
  const open = (fragment.match(/\{/g) || []).length;
  const close = (fragment.match(/\}/g) || []).length;
  for (let j = 0; j < open - close; j++) fragment += '}';
  fragment = fragment.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  return fragment;
}

/**
 * Salvage Hook Machine objects when Gemini emits unescaped quotes inside "text".
 * Anchors each hook on the following "rank" field instead of strict JSON string rules.
 */
function salvageHookObjects(raw) {
  const cleaned = stripMarkdownFences(raw);
  if (!/["']hooks["']/i.test(cleaned) && !/"text"\s*:/.test(cleaned)) return [];

  const hooks = [];
  const textKey = '"text"';
  let searchFrom = 0;

  while (searchFrom < cleaned.length) {
    const textIdx = cleaned.indexOf(textKey, searchFrom);
    if (textIdx < 0) break;

    const valueStart = cleaned.indexOf('"', cleaned.indexOf(':', textIdx) + 1);
    if (valueStart < 0) break;
    const contentStart = valueStart + 1;

    const rankIdx = cleaned.indexOf('"rank"', contentStart);
    if (rankIdx < 0) break;

    const beforeRank = cleaned.slice(contentStart, rankIdx);
    const endMarker = beforeRank.lastIndexOf('",');
    if (endMarker < 0) {
      searchFrom = contentStart + 1;
      continue;
    }

    const text = beforeRank.slice(0, endMarker).replace(/\\"/g, '"').trim();
    const tail = cleaned.slice(rankIdx);
    const rankMatch = tail.match(/"rank"\s*:\s*(\d+)/);
    const tensionMatch = tail.match(/"tensionScore"\s*:\s*(\d+)/);
    const whyMatch = tail.match(/"why"\s*:\s*"((?:\\.|[^"\\])*)"/);

    if (text) {
      hooks.push({
        text,
        rank: rankMatch ? Number(rankMatch[1]) : hooks.length + 1,
        tensionScore: tensionMatch ? Number(tensionMatch[1]) : undefined,
        why: whyMatch ? whyMatch[1].replace(/\\"/g, '"') : '',
      });
    }

    searchFrom = rankIdx + 6;
  }

  return hooks;
}

function parseJsonLoose(raw) {
  const fragment = extractJsonObject(raw);
  if (fragment) {
    try {
      return JSON.parse(fragment);
    } catch (_) {
      try {
        return JSON.parse(fragment.replace(/,\s*([}\]])/g, '$1'));
      } catch (_2) {
        // fall through to salvage
      }
    }
  }

  const salvagedHooks = salvageHookObjects(raw);
  if (salvagedHooks.length) return { hooks: salvagedHooks };

  return null;
}

module.exports = {
  stripMarkdownFences,
  extractJsonObject,
  salvageHookObjects,
  parseJsonLoose,
};
