'use strict';

const { presignR2, isR2Configured } = require('../storage');

/**
 * Browser-playable URL for a staged library clip.
 * Uses R2_ASSETS_DOMAIN when set; otherwise presigned GET (12h).
 */
async function resolveStagedPlaybackUrl(row) {
  if (!row?.r2_key) return row?.r2_url || null;

  const domain = (process.env.R2_ASSETS_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (domain) {
    if (row.r2_url && row.r2_url.includes(domain)) return row.r2_url;
    return `https://${domain}/${row.r2_key}`;
  }

  if (!isR2Configured()) return row.r2_url || null;
  return presignR2(row.r2_key, { expiresIn: 43200 });
}

async function attachPlaybackUrl(formatted, row) {
  if (!formatted || !row) return formatted;
  formatted.playbackUrl = await resolveStagedPlaybackUrl(row);
  formatted.stagedUrl = formatted.playbackUrl || formatted.r2Url;
  formatted.mp4Url = formatted.stagedUrl;
  return formatted;
}

module.exports = { resolveStagedPlaybackUrl, attachPlaybackUrl };
