'use strict';

/**
 * Register Post-Live session from a published long-form job card (CPD-1132).
 */

const { youtubeVideoId } = require('./claims_csv');
const { upsertSession } = require('./vod_sessions');
const { buildRepurposeSceneCandidates } = require('../scene_scaffold_panel');
const {
  isPublishedLongFormJob,
  getRepurposeMode,
  resolveShowLabel,
  resolvePublishedVideoUrl,
  isPublishedTalkSoupJob,
} = require('./repurpose');

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
  const repurposeMode = getRepurposeMode(card);
  const sceneReady = repurpose.candidates.length > 0 && repurposeMode === 'scene';

  const session = upsertSession({
    videoId,
    title: card.title || jobId,
    url,
    streamer: (card.streamers && card.streamers[0]) || null,
    durationSec: rundown?.totalSec || card.durationSec || null,
    published: card.publishedAt || card.assembledAt || null,
    sourceJobId: jobId,
    contentType: card.contentType || null,
    showKey: card.heygenShowKey || card.showKey || null,
    showLabel: resolveShowLabel(card),
    repurposeMode,
    sessionKind: 'published_long_form',
    sceneCandidates: repurpose.candidates,
    analyzeStatus: sceneReady ? 'scene_ready' : (repurposeMode === 'timestamp' ? 'timestamp_manual' : 'idle'),
    candidates: sceneReady ? [] : (card.postLiveCandidates || []),
  });

  return {
    session,
    repurpose,
    videoId,
  };
}

module.exports = {
  registerSessionFromJob,
  resolvePublishedVideoUrl,
  isPublishedLongFormJob,
  isPublishedTalkSoupJob,
};
