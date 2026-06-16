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
  if (body.clearSchedule === true) {
    delete spec.scheduledPublishAt;
    spec.order = spec.order || {};
    spec.order.publish = spec.order.publish || {};
    delete spec.order.publish.scheduledPublishAt;
    delete spec.order.publish.scheduledAt;
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

/**
 * Block approve-publish when pixel/metadata QA has not passed (CPD-1045).
 * approve-publish is the human publish decision — do not block on operator_review status.
 * Operators may pass forceApprove: true to bypass grade/chrome holds.
 */
function _featureApplied(orderedKey, appliedList = []) {
  const base = String(orderedKey).split(':')[0];
  return appliedList.some((a) => a === orderedKey || String(a).split(':')[0] === base);
}

function _chromeRequiredForPublish(spec = {}) {
  if (spec.state?.chromeSkipped === true) return false;
  if (spec.clipsOnly || spec.productionPath === 'short_compile_clips') return false;
  if (spec.designSpec?.chrome?.layout === 'clip-comp') return false;
  const manifest = spec.processingManifest || spec.state?.processingManifest || {};
  const ordered = manifest.featuresOrdered || [];
  if (ordered.some((f) => /brand|chrome|logo|overlay/i.test(String(f)))) return true;
  return !!(spec.brandId || spec.designSpec?.chrome?.showName || spec.designSpec?.chrome?.streamer);
}

function assertPublishReadiness(spec, { forceApprove = false } = {}) {
  const errors = [];
  if (!spec) return { ok: false, errors: ['missing job spec'] };

  if (!forceApprove) {
    if (typeof spec.grade === 'number' && spec.grade < 75) {
      errors.push(`grade ${spec.grade}/100 below publish threshold (75)`);
    }
  }

  if (_chromeRequiredForPublish(spec) && spec.state?.chromeApplied !== true) {
    errors.push('chromeApplied is false — output may lack brand chrome');
  }

  const manifest = spec.processingManifest || spec.state?.processingManifest || {};
  const applied = manifest.featuresApplied || [];
  const ordered = manifest.featuresOrdered || [];
  if (ordered.length > 0) {
    const missing = ordered.filter((f) => !_featureApplied(f, applied));
    if (missing.length > 0) {
      errors.push(`ordered features not applied: ${missing.join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Reset false-positive published state so direct YouTube republish can run (CPD-1027). */
function clearFailedPublishState(spec, { forceRepublish = false } = {}) {
  if (!spec) return spec;
  const hadSuccess = publishResultsHadSuccess(spec.publishResults);
  if (forceRepublish || (spec.status === 'published' && !hadSuccess)) {
    spec.status = 'complete';
    delete spec.approvedAt;
    spec.staging = true;
  }
  if (forceRepublish || !hadSuccess) {
    if (spec.publishResults) delete spec.publishResults;
    if (forceRepublish) spec.publishStatus = null;
  }
  return spec;
}

/**
 * Run platform uploads and persist job spec. Used sync (legacy) and async background path.
 */
async function executeApprovePublish({ db, jobId, spec, platforms, retryPlatformUpload }) {
  if (!spec.jobId) spec.jobId = jobId;
  const results = {};
  for (const platform of platforms) {
    try {
      results[platform] = await retryPlatformUpload(spec, platform);
    } catch (pErr) {
      results[platform] = { failed: true, error: pErr.message };
    }
  }

  spec.publishResults = results;
  spec.updatedAt = new Date().toISOString();
  spec.publishStatus = publishResultsHadSuccess(results) ? 'published' : 'failed';

  if (!publishResultsHadSuccess(results)) {
    spec.status = 'complete';
    spec.staging = true;
    await db.updateJobSpec(jobId, spec, { force: true });
    return { ok: false, error: 'publish_failed', platforms: results };
  }

  spec.staging = false;
  spec.status = 'published';
  spec.approvedAt = new Date().toISOString();
  await db.updateJobSpec(jobId, spec, { force: true });
  return { ok: true, approved: true, platforms: results };
}

/** Fire-and-forget publish — avoids Render 499 when YouTube upload exceeds client timeout. */
function launchApprovePublishBackground({ db, jobId, spec, platforms, retryPlatformUpload, logError }) {
  setImmediate(async () => {
    try {
      await executeApprovePublish({ db, jobId, spec, platforms, retryPlatformUpload });
    } catch (err) {
      if (logError) logError('APPROVE_PUBLISH_BG_FAIL', err, { jobId });
      try {
        spec.status = 'complete';
        spec.publishStatus = 'failed';
        spec.publishResults = { error: err.message };
        spec.updatedAt = new Date().toISOString();
        await db.updateJobSpec(jobId, spec, { force: true });
      } catch (_e) { /* best effort */ }
    }
  });
}

module.exports = {
  publishResultsHadSuccess,
  applyPublishRequestToSpec,
  assertPublishCredentials,
  assertPublishReadiness,
  clearFailedPublishState,
  executeApprovePublish,
  launchApprovePublishBackground,
};
