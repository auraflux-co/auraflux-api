'use strict';

/**
 * HeyGen reads every character aloud — parenthetical pronunciation guides get spoken twice.
 *
 * CPD-978 / phonetic handoff rule: when a word needs special pronunciation, write ONLY
 * the phonetic spelling in the script (LAY-see, ee-RAHN, EN-VID-YA). Never "Word (guide)".
 * Streamers: streamers.json `phonetic` is injected at script-gen time; captions map back
 * to onAirName in assembly_postprocess. This module strips broken parenthetical patterns
 * for ANY word, roster or not.
 */

const fs = require('fs');
const path = require('path');

let _roster = null;

function loadRoster() {
  if (_roster) return _roster;
  _roster = [];
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'streamers.json'), 'utf8');
    _roster = JSON.parse(raw)?.roster || [];
  } catch { /* empty */ }
  return _roster;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inner paren text looks like a spoken pronunciation guide, not normal prose. */
function looksLikePhoneticGuide(inner) {
  const s = String(inner || '').trim();
  if (!s || s.length > 48) return false;
  if (/^(?:pronounced|pronunciation:)/i.test(s)) return true;
  const body = s.replace(/^(?:pronounced|pronunciation:)\s*/i, '').trim();
  // Syllable-stress spellings: LAY-see, ee-RAHN, YAH-nis, EN-VID-YA, zeh-LEN-skee
  if (/[A-Za-z][A-Za-z'-]*-[A-Za-z]/.test(body)) return true;
  // Short all-caps stress chunks: (YAWN-uh) already caught; (ee-RAHN) via hyphen
  if (/^[A-Z]{2,}(-[A-Z]{2,})+$/i.test(body)) return true;
  return false;
}

function extractPhoneticFromGuide(inner) {
  return String(inner || '')
    .trim()
    .replace(/^(?:pronounced|pronunciation:)\s*/i, '')
    .trim();
}

/** Known streamer pairs from roster (onAir ↔ phonetic). */
function collapseRosterPhoneticPairs(text, roster = loadRoster()) {
  let t = String(text || '');
  t = t.replace(/\b([\w'-]+)\s*\(\s*\1\s*\)/gi, '$1');
  for (const s of roster) {
    const ph = s.phonetic;
    const onAir = s.onAirName || s.displayName;
    if (!ph) continue;
    const ePh = escapeRegex(ph);
    if (onAir) {
      const eOn = escapeRegex(onAir);
      t = t.replace(new RegExp(`\\b${eOn}\\s*\\(\\s*${ePh}\\s*\\)`, 'gi'), ph);
      t = t.replace(new RegExp(`\\b${ePh}\\s*\\(\\s*${eOn}\\s*\\)`, 'gi'), ph);
    }
    t = t.replace(new RegExp(`\\b${ePh}\\s*\\(\\s*${ePh}\\s*\\)`, 'gi'), ph);
    t = t.replace(new RegExp(`\\(\\s*${ePh}\\s*\\)`, 'gi'), ph);
  }
  return t;
}

/**
 * Collapse ANY "word (phonetic-guide)" → spoken guide only.
 * Works for streamers, place names, people, brands, jargon — not roster-limited.
 */
function collapseParentheticalPronunciationGuides(text, roster = loadRoster()) {
  let t = collapseRosterPhoneticPairs(text, roster);

  // One word before the guide (roster handles multi-word names like Jay Cinco)
  for (let pass = 0; pass < 3; pass++) {
    const next = t.replace(
      /\b([\w'-]+)\s*\(\s*([^)]+)\s*\)/g,
      (full, _before, inner) => {
        if (!looksLikePhoneticGuide(inner)) return full;
        return extractPhoneticFromGuide(inner);
      }
    );
    if (next === t) break;
    t = next;
  }

  // Bare parenthetical syllable guides: "… (ee-RAHN)" → "… ee-RAHN"
  t = t.replace(/\(\s*([A-Za-z][\w'-]*(?:-[A-Za-z][\w'-]*)+)\s*\)/g, '$1');

  return t.replace(/\s{2,}/g, ' ').trim();
}

/** @deprecated alias */
function stripDuplicatePhoneticGuides(text, roster) {
  return collapseParentheticalPronunciationGuides(text, roster);
}

function rosterEntryForSceneName(sceneName) {
  const name = String(sceneName || '').trim();
  if (!name || /^(INTRO|OUTRO)$/i.test(name)) return null;
  const prefix = name.replace(/_(INTRO|CLIP\d+_(SETUP|REACTION)|SHORT|HOOK|REACTION)$/i, '');
  if (!prefix || prefix === name) return null;
  const norm = prefix.replace(/_/g, ' ').toLowerCase().replace(/\s+/g, '');
  for (const s of loadRoster()) {
    const keys = [s.onAirName, s.displayName, s.twitchUsername]
      .filter(Boolean)
      .map((k) => String(k).toLowerCase().replace(/\s+/g, ''));
    if (keys.includes(norm)) return s;
  }
  return null;
}

function isStreamerIntroScene(sceneName) {
  return /_INTRO$/i.test(String(sceneName || '')) && !/^(INTRO|OUTRO)$/i.test(String(sceneName || ''));
}

/**
 * Sanitize one avatar spoken block for HeyGen.
 * @param {string} text
 * @param {string} [sceneName]
 */
function sanitizeSpokenTextForScene(text, sceneName) {
  let t = collapseParentheticalPronunciationGuides(text);
  const entry = rosterEntryForSceneName(sceneName);
  if (entry?.phonetic) {
    t = t.replace(/^Streamer\s+/i, '');
    const onAir = entry.onAirName || entry.displayName || '';
    const login = entry.twitchUsername || '';
    const names = [onAir, login, entry.displayName].filter(Boolean);
    for (const name of names) {
      if (name && name.toLowerCase() !== entry.phonetic.toLowerCase()) {
        t = t.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi'), entry.phonetic);
      }
    }
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** Walk === SCENE === blocks (long-form) or return whole-script sanitize for short headers. */
function sanitizeScriptForHeyGen(script, opts = {}) {
  const src = String(script || '');
  const sceneRegex = /===\s*([A-Za-z_0-9]+)\s*===/g;
  const matches = [];
  let m;
  while ((m = sceneRegex.exec(src)) !== null) {
    matches.push({ name: m[1], index: m.index, full: m[0] });
  }
  if (!matches.length) {
    return collapseParentheticalPronunciationGuides(src);
  }

  let out = '';
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    out += src.slice(cursor, cur.index);
    const bodyStart = cur.index + cur.full.length;
    const bodyEnd = next ? next.index : src.length;
    let body = src.slice(bodyStart, bodyEnd);
    const isPureClip = /type:\s*source_clip/i.test(body);
    if (!isPureClip && body.trim()) {
      const clipMarker = body.match(/\[CLIP PLAYS HERE\]/i);
      if (clipMarker) {
        const idx = body.indexOf(clipMarker[0]);
        const spoken = body.slice(0, idx);
        const tail = body.slice(idx);
        body = sanitizeSpokenTextForScene(spoken, cur.name) + tail;
      } else {
        body = sanitizeSpokenTextForScene(body, cur.name);
      }
    }
    out += cur.full + body;
    cursor = bodyEnd;
  }
  return out;
}

/** @deprecated alias */
function sanitizeTwitchScript(script, opts) {
  return sanitizeScriptForHeyGen(script, opts);
}

module.exports = {
  loadRoster,
  looksLikePhoneticGuide,
  collapseParentheticalPronunciationGuides,
  stripDuplicatePhoneticGuides,
  rosterEntryForSceneName,
  isStreamerIntroScene,
  sanitizeSpokenTextForScene,
  sanitizeScriptForHeyGen,
  sanitizeTwitchScript,
};
