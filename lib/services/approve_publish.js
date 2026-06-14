'use strict';
/**
 * lib/services/approve_publish.js — CPD-1020 / CPD-1027
 * Shared helpers for POST /jobs/:id/approve-publish result handling.
 */

/** True when at least one platform upload succeeded. */
function publishResultsHadSuccess(results) {
  if (!results || typeof results !== 'object') return false;
  return Object.values(results).some((r) => {
    if (!r || typeof r !== 'object') return false;
    if (r.failed === true || r.error) return false;
    if (r.ok === true && !r.failReason) return true;
    if (r.platformJobId || r.jobId || r.url || r.videoId) return true;
    return false;
  });
}

/** Merge approve-publish body fields into job spec (schedule, publish meta). */
function applyPublishRequestToSpec(spec, body = {}) {
  const publishMeta = body.publishMeta || {};
  if (body.scheduledPublishAt) {
    spec.scheduledPublishAt = body.scheduledPublishAt;
    spec.order = spec.order || {};
    spec.order.publish = spec.order.publish || {};
    spec.order.publish.scheduledPublishAt = body.scheduledPublishAt;
    spec.order.publish.scheduledAt = body.scheduledPublishAt;
    spec.order.publish.privacyStatus = 'private';
  }
  if (Object.keys(publishMeta).length) {
    spec.order = spec.order || {};
    spec.order.publish = spec.order.publish || {};
    if (publishMeta.title !== undefined) spec.order.publish.title = publishMeta.title;
    if (publishMeta.description !== undefined) spec.order.publish.description = publishMeta.description;
    if (publishMeta.tags !== undefined) spec.order.publish.tags = publishMeta.tags;
    if (publishMeta.privacyStatus !== undefined) spec.order.publish.privacyStatus = publishMeta.privacyStatus;
    if (publishMeta.scheduledPublishAt !== undefined) {
      spec.scheduledPublishAt = publishMeta.scheduledPublishAt;
      spec.order.publish.scheduledPublishAt = publishMeta.scheduledPublishAt;
      spec.order.publish.scheduledAt = publishMeta.scheduledPublishAt;
    }
    if (publishMeta.tiktokCaption !== undefined) spec.order.publish.tiktokCaption = publishMeta.tiktokCaption;
    if (publishMeta.instagramCaption !== undefined) {
      spec.order.publish.instagramCaption = publishMeta.instagramCaption;
    }
  }
  return spec;
}

/**
 * Upload-Post profile required only when at least one platform cannot publish direct.
 * YouTube on Operate+ uses lib/publish/adapters/youtube.js (OAuth), not Upload-Post.
 */
async function assertPublishCredentials(platforms, spec, { resolveUploadPostProfile, canPublishDirect }) {
  const needsUploadPost = [];
  for (const platform of platforms) {
    const check = await canPublishDirect(platform, spec).catch(() => ({ canDirect: false }));
    if (!check.canDirect) needsUploadPost.push({ platform, reason: check.reason || 'no direct path' });
  }
  if (needsUploadPost.length === 0) {
    return { ok: true, directOnly: true, needsUploadPost: [] };
  }
  const profile = resolveUploadPostProfile(spec);
  if (!profile) {
    return {
      ok: false,
      error: 'no_upload_post_profile',
      message:
        'No upload-post profile configured and direct publish unavailable for: ' +
        needsUploadPost.map((p) => p.platform).join(', '),
      needsUploadPost,
    };
  }
  return { ok: true, directOnly: false, needsUploadPost, profile };
}

module.exports = {
  publishResultsHadSuccess,
  applyPublishRequestToSpec,
  assertPublishCredentials,
};
