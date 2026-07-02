'use strict';
/**
 * Hook emoji — operator picklist, text parsing, Twemoji PNG assets for FFmpeg overlay burn-in.
 * Text hooks use Barlow drawtext; emoji glyphs use scaled PNG overlays (color, cross-platform).
 */

const fs = require('fs');
const path = require('path');

/** Curated Shorts-style emoji for operator hook picker + burn-in assets. */
const HOOK_EMOJI_PICKLIST = [
  { char: '😂', label: 'Laugh' },
  { char: '💀', label: 'Dead' },
  { char: '🔥', label: 'Fire' },
  { char: '😭', label: 'Cry' },
  { char: '🤯', label: 'Mind blown' },
  { char: '😳', label: 'Shook' },
  { char: '👀', label: 'Eyes' },
  { char: '💯', label: '100' },
  { char: '⚡', label: 'Bolt' },
  { char: '🚨', label: 'Siren' },
  { char: '🎮', label: 'Game' },
  { char: '📺', label: 'TV' },
  { char: '💜', label: 'Heart' },
  { char: '👏', label: 'Clap' },
  { char: '🤔', label: 'Think' },
  { char: '😈', label: 'Devil' },
  { char: '💸', label: 'Money' },
  { char: '🤡', label: 'Clown' },
  { char: '😤', label: 'Steam' },
  { char: '✨', label: 'Sparkle' },
  { char: '🏆', label: 'Trophy' },
  { char: '🎯', label: 'Target' },
  { char: '🫠', label: 'Melt' },
  { char: '❓', label: 'Question' },
];

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

const EMOJI_ASSET_DIR = path.join(__dirname, '..', 'assets', 'hook_emoji');

function emojiToAssetCode(char) {
  const parts = [];
  for (const ch of String(char || '')) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue;
    parts.push(cp.toString(16).toLowerCase());
  }
  return parts.join('-');
}

function resolveEmojiAssetPath(char) {
  const code = emojiToAssetCode(char);
  if (!code) return null;
  return path.join(EMOJI_ASSET_DIR, `${code}.png`);
}

function sanitizeHookLineGlyphs(s) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsHookEmoji(s) {
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(String(s || ''));
}

/** Split hook into alternating text / emoji tokens (preserves order). */
function splitHookBurnTokens(text) {
  const s = String(text || '');
  const tokens = [];
  let last = 0;
  const re = new RegExp(EMOJI_RE.source, 'gu');
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const chunk = s.slice(last, m.index);
      if (chunk) tokens.push({ type: 'text', value: chunk });
    }
    tokens.push({ type: 'emoji', value: m[0], assetPath: resolveEmojiAssetPath(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    const tail = s.slice(last);
    if (tail) tokens.push({ type: 'text', value: tail });
  }
  return tokens;
}

function stripHookEmojis(text) {
  EMOJI_RE.lastIndex = 0;
  return String(text || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Width estimate for Barlow Condensed SemiBold drawtext centering.
 * Calibrated coefficient: uppercase chars ≈ 0.66 * fontsize (vs 0.52 which underestimates
 * and shifts text right, overflowing the right edge).
 */
function estimateTextWidth(text, fontsize) {
  const t = String(text || '');
  if (!t) return 0;
  let w = 0;
  for (const ch of t) {
    w += ch === ' ' ? fontsize * 0.28 : fontsize * 0.66;
  }
  return w;
}

function estimateEmojiWidth(count, emojiSize) {
  if (!count) return 0;
  return count * emojiSize * 1.05;
}

/**
 * Build filter_complex + extra input paths for hook burn (drawtext + Twemoji overlays).
 * Returns { filterComplex, extraInputs, mapLabel } or null when no drawable content.
 */
function buildHookBurnFilterPlan(lines, style, {
  frameWidth = 1080,
  sharpBottom = 1264,
  hookPlacement = 'bottom',
  hookMidY = 680,
} = {}) {
  const cleanLines = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
  if (!cleanLines.length) return null;

  const lineHeight = Math.round(style.fontsize * 1.18);
  const blockHeight = cleanLines.length * lineHeight;
  const midFrame = hookPlacement === 'ranked_mid' || hookPlacement === 'full_bleed_mid';
  const baseY = midFrame
    ? hookMidY
    : sharpBottom - style.yOffset - blockHeight;
  const emojiSize = Math.round(style.fontsize * 0.92);
  const emojiGap = 8;
  const textEmojiGap = 10;

  const extraInputs = [];
  const filterParts = [];
  let streamLabel = '0:v';
  let emojiInputIndex = 1;

  cleanLines.forEach((line, lineIdx) => {
    const tokens = splitHookBurnTokens(line);
    const textPart = tokens.filter((t) => t.type === 'text').map((t) => t.value).join('').trim();
    const emojis = tokens.filter((t) => t.type === 'emoji' && t.assetPath && fs.existsSync(t.assetPath));
    const y = baseY + lineIdx * lineHeight;

    const textW = estimateTextWidth(textPart, style.fontsize);
    const emojiW = estimateEmojiWidth(emojis.length, emojiSize);
    const gap = emojis.length && textPart ? textEmojiGap : 0;
    const totalW = textW + gap + emojiW;
    let xCursor = (frameWidth - totalW) / 2;

    if (textPart) {
      const outLabel = `hookL${lineIdx}t`;
      const { escapeDrawtext } = require('./clip_comp_cards');
      // Text-only lines: use FFmpeg's actual text_w for perfect centering.
      // Text+emoji lines: use the estimated xCursor (text_w unavailable at overlay positioning time).
      const xExpr = emojis.length === 0
        ? '(W-text_w)/2'
        : `${Math.max(0, Math.round(xCursor))}`;
      const parts = [
        `fontfile=${_escapeFontPath(style.font)}`,
        `text='${escapeDrawtext(textPart)}'`,
        `fontsize=${style.fontsize}`,
        `fontcolor=${style.fontcolor}`,
        `box=${style.useBox ? 1 : 0}`,
        `boxcolor=${style.boxcolor}`,
        `boxborderw=${style.boxborderw}`,
        `borderw=${style.borderw}`,
        `bordercolor=${style.bordercolor}`,
        `shadowx=${style.shadowx}`,
        `shadowy=${style.shadowy}`,
        `shadowcolor=${style.shadowcolor}`,
        `x=${xExpr}`,
        `y=${y}`,
      ];
      filterParts.push(`[${streamLabel}]drawtext=${parts.join(':')}[${outLabel}]`);
      streamLabel = outLabel;
      xCursor += textW + gap;
    }

    emojis.forEach((em, emIdx) => {
      extraInputs.push(em.assetPath);
      const scaleLabel = `hookEm${lineIdx}_${emIdx}S`;
      const outLabel = `hookL${lineIdx}e${emIdx}`;
      filterParts.push(`[${emojiInputIndex}:v]scale=${emojiSize}:${emojiSize}[${scaleLabel}]`);
      filterParts.push(
        `[${streamLabel}][${scaleLabel}]overlay=x=${Math.round(xCursor)}:y=${y + Math.round(style.fontsize * 0.06)}:format=auto[${outLabel}]`,
      );
      streamLabel = outLabel;
      emojiInputIndex += 1;
      xCursor += emojiSize * 1.05;
    });
  });

  if (!filterParts.length) return null;
  return {
    filterComplex: filterParts.join(';'),
    extraInputs,
    mapLabel: streamLabel,
  };
}

function _escapeFontPath(fontPath) {
  return String(fontPath || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

module.exports = {
  HOOK_EMOJI_PICKLIST,
  EMOJI_RE,
  EMOJI_ASSET_DIR,
  emojiToAssetCode,
  resolveEmojiAssetPath,
  sanitizeHookLineGlyphs,
  containsHookEmoji,
  splitHookBurnTokens,
  stripHookEmojis,
  estimateTextWidth,
  estimateEmojiWidth,
  buildHookBurnFilterPlan,
};
