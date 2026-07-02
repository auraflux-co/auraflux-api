'use strict';

const fs = require('fs');
const path = require('path');

const COUNTERS_PATH = process.env.EPISODE_COUNTERS_PATH
  || path.join(__dirname, '..', 'data', 'episode_counters.json');

const DEFAULT_COUNTERS = { twitch: 1, nba: 1, news: 1 };

const LONG_FORM_KEYS = new Set(['twitch', 'nba', 'news']);

function readCounters() {
  try {
    return { ...DEFAULT_COUNTERS, ...JSON.parse(fs.readFileSync(COUNTERS_PATH, 'utf8')) };
  } catch (_e) {
    return { ...DEFAULT_COUNTERS };
  }
}

function writeCounters(counters) {
  fs.mkdirSync(path.dirname(COUNTERS_PATH), { recursive: true });
  fs.writeFileSync(COUNTERS_PATH, JSON.stringify(counters, null, 2));
}

function baseContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('twitch')) return 'twitch';
  if (ct.includes('nba')) return 'nba';
  if (ct.includes('news')) return 'news';
  return ct.split('-')[0] || 'twitch';
}

function counterKey(contentType, { isShort } = {}) {
  const base = baseContentType(contentType);
  if (isShort || String(contentType || '').includes('short')) {
    return `${base}-short_short`;
  }
  return base;
}

function parseEpisodeNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  const m = String(value).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function episodeLabel(num) {
  const n = parseEpisodeNumber(num);
  return n ? `Episode ${n}` : null;
}

function getEpisodeNumberForAssembly(contentType, options = {}) {
  const key = counterKey(contentType, options);
  const counters = readCounters();
  const num = counters[key] || counters[baseContentType(contentType)] || 1;
  return { num, label: episodeLabel(num), key };
}

function isLongFormEpisode(contentType, jobSpec = {}) {
  if (jobSpec.isShort || jobSpec.clipsOnly) return false;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('short')) return false;
  return LONG_FORM_KEYS.has(baseContentType(contentType));
}

function resolvePublishedEpisodeNumber(jobSpec, card) {
  const fromCard = card?.episodeNumber
    || card?.state?.savedOutputs?.episodeNumber
    || jobSpec?.state?.savedOutputs?.episodeNumber
    || jobSpec?.episodeNumber;
  const parsed = parseEpisodeNumber(fromCard);
  if (parsed) return parsed;

  const { num } = getEpisodeNumberForAssembly(jobSpec?.contentType || card?.contentType);
  return num;
}

/**
 * After a successful long-form publish, bump the show counter so the next assembly
 * uses the next episode number. Idempotent per jobId when alreadyIncremented is set.
 */
function incrementAfterPublish({ jobId, contentType, jobSpec, card, alreadyIncremented } = {}) {
  if (alreadyIncremented) {
    return { skipped: true, reason: 'already_incremented' };
  }
  if (!isLongFormEpisode(contentType, jobSpec || card || {})) {
    return { skipped: true, reason: 'not_long_form' };
  }

  const key = counterKey(contentType);
  const publishedNum = resolvePublishedEpisodeNumber(jobSpec, card);
  const counters = readCounters();
  const current = counters[key] || 1;
  const next = Math.max(current, publishedNum + 1);

  counters[key] = next;
  const formatKey = `${key}_v2`;
  if (typeof counters[formatKey] === 'number') {
    counters[formatKey] = counters[formatKey] + 1;
  }
  writeCounters(counters);

  console.log(
    `[episode-counters] ${jobId || '?'}: ${key} ${publishedNum} published → next=${next}`
  );

  return {
    skipped: false,
    key,
    publishedNum,
    previous: current,
    next,
  };
}

module.exports = {
  COUNTERS_PATH,
  readCounters,
  writeCounters,
  baseContentType,
  counterKey,
  parseEpisodeNumber,
  episodeLabel,
  getEpisodeNumberForAssembly,
  isLongFormEpisode,
  resolvePublishedEpisodeNumber,
  incrementAfterPublish,
};
