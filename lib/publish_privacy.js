'use strict';
/**
 * Resolve platform privacy for Gate 5 / Portal 5 uploads.
 * Clip comps and all pipeline auto-publish paths default to private drafts.
 */

const { clipCompPublishPrivate } = require('./clip_comp');

function resolveYouTubePrivacy(jobSpec, metadata = {}) {
  if (clipCompPublishPrivate(jobSpec?.contentType) || jobSpec?.clipsOnly) return 'private';
  return jobSpec?.deliverySpec?.visibility
    || jobSpec?.order?.publish?.privacyStatus
    || metadata.privacyStatus
    || 'private';
}

function resolveTikTokPrivacy(jobSpec, metadata = {}, scheduledAt = null) {
  const ytPrivate = resolveYouTubePrivacy(jobSpec, metadata) === 'private';
  const future = scheduledAt && new Date(scheduledAt).getTime() > Date.now();
  if (future || ytPrivate || clipCompPublishPrivate(jobSpec?.contentType) || jobSpec?.clipsOnly) {
    return 'SELF_ONLY';
  }
  return metadata.tiktokPrivacy || 'PUBLIC_TO_EVERYONE';
}

module.exports = {
  resolveYouTubePrivacy,
  resolveTikTokPrivacy,
};
