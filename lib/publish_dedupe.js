'use strict';

/**
 * Publish dedupe — skip Gate 5 only when THIS driveUrl was already uploaded.
 * A new assembly (re-assemble / avatar rerun) gets a new driveUrl and may republish.
 */

function resolveCardDriveUrl(card = {}) {
  return card.state?.savedOutputs?.driveUrl || card.driveUrl || null;
}

function normalizeDriveUrl(url) {
  return String(url || '').trim();
}

function getPublishedRows(jobId) {
  try {
    const db = require('./db');
    return db.getPublishedResults(jobId) || [];
  } catch (_e) {
    return [];
  }
}

function isDriveUrlAlreadyPublished(jobId, driveUrl) {
  const target = normalizeDriveUrl(driveUrl);
  if (!target) return false;
  return getPublishedRows(jobId).some(
    (r) => r.platform_job_id && normalizeDriveUrl(r.drive_url) === target
  );
}

function needsRepublish(card = {}, jobId = card.jobId || card.id) {
  const driveUrl = resolveCardDriveUrl(card);
  if (!driveUrl || !jobId) return false;
  const rows = getPublishedRows(jobId).filter((r) => r.platform_job_id);
  if (!rows.length) return false;
  return !isDriveUrlAlreadyPublished(jobId, driveUrl);
}

function lastPublishedDriveUrl(jobId) {
  const rows = getPublishedRows(jobId).filter((r) => r.drive_url);
  return rows[0]?.drive_url || null;
}

module.exports = {
  resolveCardDriveUrl,
  isDriveUrlAlreadyPublished,
  needsRepublish,
  lastPublishedDriveUrl,
};
