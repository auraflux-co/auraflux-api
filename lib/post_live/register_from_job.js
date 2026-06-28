'use strict';

/**
 * Register Post-Live session from a published Talk Soup job card (CPD-1132).
 */

const { youtubeVideoId } = require('./claims_csv');
const { upsertSession } = require('./vod_sessions');
const { buildRepurposeSceneCandidates } = require('../scene_scaffold_panel');

function resolvePublishedVideoUrl(card) {
  const candidates = [
    card?.publishRecord?.youtubeUrl,
    card?.publishRecord?.url,
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

function loadRundown(card) {
  if (card?.postAssemblyRundown?.entries?.length) return card.postAssemblyRundown;
  return null;
}

function registerSessionFromJob(jobId, card, { rundown: rundownIn } = {}) {
  if (!card) throw new Error('Job card required');
  const url = resolvePublishedVideoUrl(card);
  if (!url) throw new Error('No YouTube URL on job card — publish first or set driveUrl');

  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error(`Could not parse YouTube video ID from ${url.slice(0, 80)}`);

  const rundown = rundownIn || loadRundown(card);
  const repurpose = buildRepurposeSceneCandidates({ card, rundown });

  const session = upsertSession({
    videoId,
    title: card.title || jobId,
    url,
    streamer: (card.streamers && card.streamers[0]) || null,
    durationSec: rundown?.totalSec || card.durationSec || null,
    published: card.publishedAt || card.assembledAt || null,
    sourceJobId: jobId,
    sessionKind: 'published_episode',
    sceneCandidates: repurpose.candidates,
    analyzeStatus: repurpose.candidates.length ? 'scene_ready' : 'idle',
    candidates: repurpose.candidates.length ? [] : (card.postLiveCandidates || []),
  });

  return {
    session,
    repurpose,
    videoId,
  };
}

function isPublishedTalkSoupJob(card) {
  const ct = String(card?.contentType || '').toLowerCase();
  if (!ct.includes('twitch') || card?.clipsOnly) return false;
  if (ct.includes('-short')) return false;
  const stage = card?.stage || '';
  return stage === 'published' || !!card?.publishedAt;
}

module.exports = {
  registerSessionFromJob,
  resolvePublishedVideoUrl,
  isPublishedTalkSoupJob,
};
