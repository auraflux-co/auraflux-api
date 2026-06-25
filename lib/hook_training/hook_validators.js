'use strict';

const DEFAULT_GENERIC_FALLBACKS = [
  'That Escalated Fast',
  'Wait For The Beat',
  'Something Went Wrong',
  'The Look Says It All',
];

const OUTCOME_SPOILER_PATTERNS = [
  /\bthen the (goal|win|punchline|joke|twist|score|point)\b/i,
  /\bthen (he|she|they) (won|scored|made it|did it|clutched)\b/i,
  /\band then (the|he|she|they)\b/i,
  /^[^.]+\.\s*then (the|he|she|they|it)\b/i,
];

function isOutcomeSpoilerHook(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return OUTCOME_SPOILER_PATTERNS.some((re) => re.test(t));
}

function isFallbackHook(text, fallbacks = DEFAULT_GENERIC_FALLBACKS) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) return false;
  return fallbacks.some((f) => String(f).trim().toLowerCase() === normalized);
}

module.exports = {
  DEFAULT_GENERIC_FALLBACKS,
  OUTCOME_SPOILER_PATTERNS,
  isOutcomeSpoilerHook,
  isFallbackHook,
};
