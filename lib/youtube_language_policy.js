'use strict';
/**
 * YouTube vulgar language policy helpers (Community Guidelines + ad suitability).
 * @see https://support.google.com/youtube/answer/10072685
 *
 * Surfaces we control on Shorts:
 *   - CAPTION (burned overlay) — treat like title/metadata (strictest)
 *   - HOOK / REACTION (Bobby G dialogue we write)
 *   - publish titles, short-form social captions
 *
 * Source clip audio may contain streamer profanity; this module only gates copy we generate.
 */

const POLICY_URL = 'https://support.google.com/youtube/answer/10072685';

/** Heavy profanity / slurs — never in captions, titles, or hooks we write. */
const HEAVY_PATTERNS = [
  /\bf[\*#@]{2,}/gi, // masked: F***, f@ck (no trailing word boundary — asterisks are non-word)
  /\bf+u+c+k+(?:ing|er|ed|s|t)?\b/gi,
  /\bmotherf+u+c+k+(?:er|ing|s)?\b/gi,
  /\bs+h+i+t+(?:ty|s|head)?\b/gi,
  /\bbullsh+i+t\b/gi,
  /\ba+s+s+h+o+l+e+\b/gi,
  /\bb+i+t+c+h+(?:es|y)?\b/gi,
  /\bc+u+n+t+s?\b/gi,
  /\bd+i+c+k+(?:head|s)?\b/gi,
  /\bc+o+c+k+s?\b/gi,
  /\bp+u+s+s+y\b/gi,
  /\bw+h+o+r+e+s?\b/gi,
  /\bs+l+u+t+s?\b/gi,
  /\bn+i+g+g+(?:er|a|as)?\b/gi,
  /\bf+a+g+g?(?:ot|ots|y)?\b/gi,
  /\bretard(?:ed|s)?\b/gi,
];

/** Sexually explicit terms in metadata-like surfaces. */
const SEXUAL_METADATA_PATTERNS = [
  /\bporn\b/gi,
  /\bxxx\b/gi,
  /\bonlyfans\b/gi,
  /\bnsfw\b/gi,
  /\bhentai\b/gi,
];

const REPLACEMENTS = [
  [/\bf[\*#@]{2,}/gi, '—'],
  [/\bf+u+c+k+(?:ing|er|ed|s|t)?\b/gi, 'freaking'],
  [/\bmotherf+u+c+k+(?:er|ing|s)?\b/gi, 'seriously'],
  [/\bs+h+i+t+(?:ty|s|head)?\b/gi, 'stuff'],
  [/\bbullsh+i+t\b/gi, 'nonsense'],
  [/\ba+s+s+h+o+l+e+\b/gi, 'jerk'],
  [/\bb+i+t+c+h+(?:es|y)?\b/gi, 'mess'],
  [/\bc+u+n+t+s?\b/gi, '—'],
  [/\bd+i+c+k+(?:head|s)?\b/gi, '—'],
  [/\bc+o+c+k+s?\b/gi, '—'],
  [/\bp+u+s+s+y\b/gi, '—'],
  [/\bw+h+o+r+e+s?\b/gi, '—'],
  [/\bs+l+u+t+s?\b/gi, '—'],
  [/\bn+i+g+g+(?:er|a|as)?\b/gi, '—'],
  [/\bf+a+g+g?(?:ot|ots|y)?\b/gi, '—'],
  [/\bretard(?:ed|s)?\b/gi, '—'],
];

const SURFACE_STRICTNESS = {
  caption: 'strict',
  title: 'strict',
  description: 'strict',
  hook: 'moderate',
  reaction: 'moderate',
  publish_caption: 'strict',
};

function normalizeForScan(text) {
  return String(text || '')
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^\w\s$#@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scan text for YouTube policy violations on a given surface.
 * @returns {{ ok: boolean, violations: string[], surface: string }}
 */
function scanVulgarLanguage(text, { surface = 'caption' } = {}) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: true, violations: [], surface };

  const violations = [];
  const check = (patterns, label) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      const m = raw.match(re);
      if (m) violations.push(`${label}: "${m[0]}"`);
    }
  };

  check(HEAVY_PATTERNS, 'heavy profanity');
  if (SURFACE_STRICTNESS[surface] === 'strict') {
    check(SEXUAL_METADATA_PATTERNS, 'sexual/explicit term');
  }

  return { ok: violations.length === 0, violations, surface };
}

/**
 * Replace heavy profanity with broadcast-safe wording (deterministic).
 */
function sanitizeVulgarLanguage(text) {
  let out = String(text || '');
  for (const [re, rep] of REPLACEMENTS) {
    re.lastIndex = 0;
    out = out.replace(re, rep);
  }
  for (const re of SEXUAL_METADATA_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Prompt block for short-form writers (Gemini / Claude).
 */
function buildYoutubeLanguagePromptBlock() {
  return `
YOUTUBE VULGAR LANGUAGE (${POLICY_URL}) — NON-NEGOTIABLE FOR SHORTS:
- CAPTION text is burned on-screen and treated like a title: NO heavy profanity, slurs, sexual terms, or leetspeak spellings of those words.
- HOOK and REACTION dialogue we write must stay TV-14: no F-word, S-word, slurs, or sexual explicitness — even if the source clip is spicy.
- Internet voice is fine ("WHO LET HIM COOK", "L + RATIO", "CHAT WAS RIGHT") without profanity.
- Mild words ("damn", "hell") sparingly in HOOK/REACTION only — never in CAPTION.
- Do not quote uncensored streamer swearing in HOOK, REACTION, or CAPTION.`;
}

/**
 * Parse and sanitize HOOK / REACTION / CAPTION lines in a short-form script.
 * @returns {{ script: string, captionText: string|null, violations: string[], sanitized: boolean }}
 */
function enforceShortScriptLanguage(script, contentType) {
  if (!script || !String(contentType || '').includes('-short')) {
    return { script, captionText: null, violations: [], sanitized: false };
  }

  const violations = [];
  let sanitized = false;
  let captionText = null;

  const patchLine = (label, surface) => {
    const re = new RegExp(`^(${label}:\\s*)(.+)$`, 'm');
    const m = script.match(re);
    if (!m) return;
    const original = m[2].trim();
    const scan = scanVulgarLanguage(original, { surface });
    if (!scan.ok) violations.push(...scan.violations.map((v) => `${label} ${v}`));
    const cleaned = sanitizeVulgarLanguage(original);
    if (cleaned !== original) {
      sanitized = true;
      script = script.replace(re, `$1${cleaned}`);
    }
    if (label === 'CAPTION') captionText = cleaned;
  };

  const patchScene = (scene, surface) => {
    const blockRe = new RegExp(
      `(===\\s*${scene}\\s*===\\s*\\r?\\n(?:type:[^\\r\\n]*\\r?\\n)?spokenText:\\s*)([\\s\\S]*?)(?=\\r?\\n===|\\r?\\nCAPTION:|$)`,
      'i'
    );
    script = script.replace(blockRe, (full, prefix, body) => {
      const original = body.trim();
      const scan = scanVulgarLanguage(original, { surface });
      if (!scan.ok) violations.push(...scan.violations.map((v) => `${scene} ${v}`));
      const cleaned = sanitizeVulgarLanguage(original);
      if (cleaned !== original) {
        sanitized = true;
        const rest = body.substring(original.length);
        return prefix + cleaned + rest;
      }
      return full;
    });
  };

  patchLine('HOOK', 'hook');
  patchLine('REACTION', 'reaction');
  patchLine('CAPTION', 'caption');
  patchScene('HOOK', 'hook');
  patchScene('REACTION', 'reaction');

  const capM = script.match(/^CAPTION:\s*(.+)$/m);
  if (capM) {
    captionText = sanitizeVulgarLanguage(
      capM[1].trim().replace(/^["']|["']$/g, '').trim()
    );
  }

  return { script, captionText, violations, sanitized };
}

function enforcePublishCaptionLanguage(caption) {
  const scan = scanVulgarLanguage(caption, { surface: 'publish_caption' });
  const cleaned = sanitizeVulgarLanguage(caption);
  return {
    caption: cleaned,
    ok: scan.ok && cleaned === String(caption || '').trim(),
    violations: scan.violations,
    sanitized: cleaned !== String(caption || '').trim(),
  };
}

module.exports = {
  POLICY_URL,
  scanVulgarLanguage,
  sanitizeVulgarLanguage,
  buildYoutubeLanguagePromptBlock,
  enforceShortScriptLanguage,
  enforcePublishCaptionLanguage,
};
