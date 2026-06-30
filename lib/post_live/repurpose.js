'use strict';

/**
 * Repurpose eligibility — long-form pipeline vs live archive (CPD-1132+).
 *
 * Long-form shows: HeyGen scaffolding + postAssemblyRundown → scene timestamps (automatic).
 * Livestreams: no scaffold — operator defines start/stop clip windows (timestamp mode).
 */

const { youtubeVideoId } = require('./claims_csv');

function resolvePublishedVideoUrl(card) {
  const candidates = [
    card?.publishRecord?.youtubeUrl,
    card?.publishRecord?.url,
    card?.gate5Result?.platforms?.youtube?.url,
    card?.gate5Result?.youtube?.url,
    card?.gate5Result?.results?.find?.((r) => r.platform === 'youtube')?.url,
    card?.driveUrl,
    card?.finalUrl,
    card?.state?.savedOutputs?.driveUrl,
  ].filter(Boolean);
  for (const url of candidates) {
    const s = String(url);
    if (/youtube\.com|youtu\.be/i.test(s)) return s;
  }
  return null;
}

function isShortFormContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  return ct.includes('-short') || ct.endsWith('_short') || ct === 'short';
}

function isClipCompOnly(card) {
  const ct = String(card?.contentType || '').toLowerCase();
  return card?.clipsOnly || ct.includes('clip-comp') || ct === 'clip_comp';
}

function isPublishedLongFormJob(card) {
  if (!card || isClipCompOnly(card)) return false;
  const ct = String(card.contentType || '').toLowerCase();
  if (isShortFormContentType(ct)) return false;
  const published = card.stage === 'published' || !!card.publishedAt;
  if (!published) return false;
  return !!resolvePublishedVideoUrl(card);
}

/** @deprecated alias */
function isPublishedTalkSoupJob(card) {
  return isPublishedLongFormJob(card);
}

function hasAssemblyRundown(card) {
  return !!(card?.postAssemblyRundown?.entries?.length);
}

function hasScriptScaffold(card) {
  return !!(
    card?.designSpec?.sceneStructure?.sceneHeaders?.length
    || (card?.script?.raw && /===\s*.+\s*===/m.test(card.script.raw))
  );
}

function getRepurposeMode(card) {
  if (hasAssemblyRundown(card)) return 'scene';
  if (hasScriptScaffold(card)) return 'scene'; // rundown may arrive after partial publish
  return 'timestamp';
}

function resolveShowLabel(card) {
  const key = card?.heygenShowKey || card?.showKey;
  if (key) {
    try {
      const { loadHeygenShows } = require('../heygen_shows');
      const shows = loadHeygenShows(card?.customerId || 'c0');
      if (shows[key]?.label) return shows[key].label;
    } catch { /* non-fatal */ }
    return String(key);
  }
  const ct = String(card?.contentType || 'long-form');
  if (ct.includes('twitch')) return 'Talk Soup';
  if (ct.includes('news')) return 'News';
  if (ct.includes('nba') || ct.includes('sports')) return 'Sports';
  if (card?.title) return String(card.title).slice(0, 48);
  return ct;
}

function parseTimeSec(input) {
  if (input == null || input === '') throw new Error('Time required');
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, input);
  const s = String(input).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  throw new Error(`Invalid time "${input}" — use seconds or M:SS`);
}

function buildManualClipCandidate({ start_s, end_s, title, sceneLabel } = {}) {
  const start = parseTimeSec(start_s);
  const end = parseTimeSec(end_s);
  if (end <= start) throw new Error('End must be after start');
  const dur = Math.round((end - start) * 10) / 10;
  const label = sceneLabel || title || `Clip ${Math.floor(start)}s`;
  return {
    sceneLabel: label,
    title: title || label,
    start_s: start,
    end_s: end,
    durationSec: dur,
    source: 'manual_timestamp',
    selected: false,
  };
}

function mergeClipCandidates(existing, incoming) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  for (const c of incoming) {
    const dup = base.some((b) =>
      Math.abs((b.start_s || 0) - c.start_s) < 0.5
      && Math.abs((b.end_s || 0) - c.end_s) < 0.5,
    );
    if (!dup) base.push(c);
  }
  return base;
}

function summarizePublishedJob(jobId, card) {
  return {
    jobId,
    title: card.title || jobId,
    contentType: card.contentType || null,
    showLabel: resolveShowLabel(card),
    showKey: card.heygenShowKey || card.showKey || null,
    stage: card.stage,
    publishedAt: card.publishedAt || card.assembledAt || null,
    youtubeUrl: resolvePublishedVideoUrl(card),
    durationSec: card.postAssemblyRundown?.totalSec || card.durationSec || null,
    hasRundown: hasAssemblyRundown(card),
    repurposeMode: getRepurposeMode(card),
  };
}

/** @deprecated alias — any published long-form show */
function isPublishedTalkSoupJob(card) {
  return isPublishedLongFormJob(card);
}

module.exports = {
  resolvePublishedVideoUrl,
  isShortFormContentType,
  isPublishedLongFormJob,
  isPublishedTalkSoupJob,
  hasAssemblyRundown,
  hasScriptScaffold,
  getRepurposeMode,
  resolveShowLabel,
  parseTimeSec,
  buildManualClipCandidate,
  mergeClipCandidates,
  summarizePublishedJob,
};
