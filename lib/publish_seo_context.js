'use strict';
/** Resolve publish SEO profile — Twitch clip comp vs reaction / YouTube-sourced VOD. */

function detectUrlPlatform(url = '') {
  const u = String(url || '');
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  if (/twitch\.tv/i.test(u)) return 'twitch';
  if (/kick\.com/i.test(u)) return 'kick';
  return '';
}

function resolvePublishSeoContext({
  contentType = '',
  clipCompBrief = null,
  compCreative = null,
  streamers = [],
  items = [],
} = {}) {
  const preset = String(compCreative?.preset || '').trim();
  const ct = String(contentType || '').toLowerCase();
  const isReactionShort = preset === 'reaction_short' || ct.includes('reaction');

  const urls = [];
  for (const c of clipCompBrief?.clips || []) {
    if (c.pageUrl) urls.push(c.pageUrl);
    if (c.url) urls.push(c.url);
  }
  for (const it of items || []) {
    if (it.pageUrl) urls.push(it.pageUrl);
    if (it.url) urls.push(it.url);
  }

  const platforms = new Set(urls.map(detectUrlPlatform).filter(Boolean));
  for (const c of clipCompBrief?.clips || []) {
    if (c.platform) platforms.add(String(c.platform).toLowerCase());
  }

  const hasYoutube = platforms.has('youtube');
  const hasTwitch = platforms.has('twitch');

  let seoKind = 'twitch';
  if (isReactionShort || (hasYoutube && !hasTwitch)) seoKind = 'reaction';
  else if (ct.includes('sport') || ct.includes('nba')) seoKind = 'sports';
  else if (ct.includes('news')) seoKind = 'news';
  else if (!ct.includes('twitch') && !ct.includes('clip') && !ct.includes('streamer')) seoKind = 'viral';

  const observations = (clipCompBrief?.clips || [])
    .map((c) => String(c.observation || '').trim())
    .filter((o) => o.length > 40
      && !/analysis unavailable|title fallback|Repurpose segment/i.test(o));

  const subjectName = clipCompBrief?.leadStreamer
    || (typeof streamers[0] === 'string' ? streamers[0] : (streamers[0]?.displayName || streamers[0]?.streamer || ''));

  return {
    seoKind,
    isReactionShort,
    sourcePlatform: hasYoutube && !hasTwitch ? 'youtube' : (hasTwitch ? 'twitch' : 'unknown'),
    subjectName: String(subjectName || '').trim(),
    sourceChannel: String(clipCompBrief?.sourceChannel || '').trim(),
    hasGeminiObservations: observations.length > 0,
    geminiObservationBlock: observations.slice(0, 6).join('\n\n'),
  };
}

module.exports = {
  detectUrlPlatform,
  resolvePublishSeoContext,
};
