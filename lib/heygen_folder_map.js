'use strict';

/**
 * Map pipeline contentType → HeyGen folder_id (POST /v2/video/generate).
 * Set HEYGEN_FOLDER_ID_* in .env; omit or leave empty to skip (default library).
 *
 * @param {string} contentType — e.g. nba, news, twitch, nba-short
 * @returns {string|null}
 */
function resolveHeyGenFolderId(contentType) {
  const ct = String(contentType || '').toLowerCase().trim();
  const nbaNfl = (process.env.HEYGEN_FOLDER_ID_NBA_NFL || '').trim();
  const news = (process.env.HEYGEN_FOLDER_ID_NEWS || '').trim();
  const twitch = (process.env.HEYGEN_FOLDER_ID_TWITCH || '').trim();

  if (ct === 'nba' || ct === 'nba-short' || ct === 'nfl' || ct === 'nfl-short') {
    return nbaNfl || null;
  }
  if (ct === 'news' || ct === 'news-short') {
    return news || null;
  }
  if (ct === 'twitch' || ct === 'twitch-short' || ct === 'clips-short') {
    return twitch || null;
  }
  return null;
}

/** Env var name to set for this contentType, or null if unmapped. */
function heyGenFolderEnvKeyForContentType(contentType) {
  const ct = String(contentType || '').toLowerCase().trim();
  if (ct === 'nba' || ct === 'nba-short' || ct === 'nfl' || ct === 'nfl-short') {
    return 'HEYGEN_FOLDER_ID_NBA_NFL';
  }
  if (ct === 'news' || ct === 'news-short') return 'HEYGEN_FOLDER_ID_NEWS';
  if (ct === 'twitch' || ct === 'twitch-short' || ct === 'clips-short') {
    return 'HEYGEN_FOLDER_ID_TWITCH';
  }
  return null;
}

module.exports = { resolveHeyGenFolderId, heyGenFolderEnvKeyForContentType };
