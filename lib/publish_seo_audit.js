'use strict';
/**
 * lib/publish_seo_audit.js — Track how publish SEO fields evolve (title, desc, tags, hashtags).
 * Snapshots are appended on job cards as publishSeoAudit.snapshots[] for comps experiments.
 */

const { normalizePublishCopyShape, countWords } = require('./publish_copy_normalize');
const { countHashtagsInText } = require('./gates/metadata_qa');

function _pickYoutubeTitle(yt = {}) {
  return yt.bestTitle?.title || yt.title || (Array.isArray(yt.titles) && yt.titles[0]) || '';
}

function snapshotFromPublishCopy(pc = {}, stage = 'generated') {
  const flat = normalizePublishCopyShape(pc);
  const yt = flat.youtube || flat.platforms?.youtube || {};
  const tt = flat.tiktok || flat.platforms?.tiktok || {};
  const ig = flat.instagram || flat.platforms?.instagram || {};
  const desc = yt.description || '';
  return {
    at: new Date().toISOString(),
    stage,
    youtube: {
      title: _pickYoutubeTitle(yt),
      descriptionChars: desc.length,
      descriptionWords: countWords(desc),
      descriptionHashtags: countHashtagsInText(desc),
      tagCount: Array.isArray(yt.tags) ? yt.tags.length : 0,
      tagsPreview: (yt.tags || []).slice(0, 8),
    },
    tiktok: {
      captionChars: String(tt.caption || '').length,
      captionHashtags: countHashtagsInText(tt.caption || ''),
    },
    instagram: {
      captionChars: String(ig.caption || '').length,
      captionHashtags: countHashtagsInText(ig.caption || ''),
    },
  };
}

function snapshotFromGateMetadata(metadata = {}, stage = 'gate5_upload') {
  const desc = metadata.description || '';
  const ttCap = metadata.tiktokCaption || metadata.caption || '';
  const igCap = metadata.instagramCaption || '';
  return {
    at: new Date().toISOString(),
    stage,
    youtube: {
      title: metadata.title || '',
      descriptionChars: desc.length,
      descriptionWords: countWords(desc),
      descriptionHashtags: countHashtagsInText(desc),
      tagCount: Array.isArray(metadata.tags) ? metadata.tags.length : 0,
      tagsPreview: (metadata.tags || []).slice(0, 8),
    },
    tiktok: {
      captionChars: String(ttCap).length,
      captionHashtags: countHashtagsInText(ttCap),
    },
    instagram: {
      captionChars: String(igCap).length,
      captionHashtags: countHashtagsInText(igCap),
    },
  };
}

function _fieldChanges(prev, next, path, label) {
  const changes = [];
  if (!prev) return changes;
  const a = path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), prev);
  const b = path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), next);
  if (a !== b) changes.push(`${label}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return changes;
}

function diffSnapshots(prev, next) {
  if (!prev) return [];
  const changes = [];
  changes.push(..._fieldChanges(prev, next, 'youtube.title', 'YT title'));
  changes.push(..._fieldChanges(prev, next, 'youtube.descriptionWords', 'YT desc words'));
  changes.push(..._fieldChanges(prev, next, 'youtube.descriptionHashtags', 'YT desc #'));
  changes.push(..._fieldChanges(prev, next, 'youtube.tagCount', 'YT tags'));
  changes.push(..._fieldChanges(prev, next, 'tiktok.captionChars', 'TT caption len'));
  changes.push(..._fieldChanges(prev, next, 'tiktok.captionHashtags', 'TT #'));
  changes.push(..._fieldChanges(prev, next, 'instagram.captionChars', 'IG caption len'));
  changes.push(..._fieldChanges(prev, next, 'instagram.captionHashtags', 'IG #'));
  return changes;
}

function appendSnapshot(existingAudit, snapshot) {
  const audit = existingAudit && Array.isArray(existingAudit.snapshots)
    ? { ...existingAudit, snapshots: [...existingAudit.snapshots] }
    : { snapshots: [] };
  const prev = audit.snapshots[audit.snapshots.length - 1] || null;
  const changes = diffSnapshots(prev, snapshot);
  audit.snapshots.push({ ...snapshot, changes });
  audit.lastAt = snapshot.at;
  audit.lastStage = snapshot.stage;
  if (changes.length) audit.lastChanges = changes;
  return audit;
}

function recordPublishCopySnapshot(existingAudit, publishCopy, stage = 'generated') {
  return appendSnapshot(existingAudit, snapshotFromPublishCopy(publishCopy, stage));
}

function recordGateMetadataSnapshot(existingAudit, metadata, stage = 'gate5_upload') {
  return appendSnapshot(existingAudit, snapshotFromGateMetadata(metadata, stage));
}

module.exports = {
  snapshotFromPublishCopy,
  snapshotFromGateMetadata,
  diffSnapshots,
  appendSnapshot,
  recordPublishCopySnapshot,
  recordGateMetadataSnapshot,
};
