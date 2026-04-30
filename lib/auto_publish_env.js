'use strict';
/**
 * AUTO_PUBLISH_PLATFORMS — controls which platforms Portal 5 / Upload-Post targets.
 *
 * - **Unset:** callers should use their own default (usually `['youtube']` from content type).
 * - **Set to empty, `none`, `skip`, or `0`:** no platforms → Portal 5 does not run (saves YouTube
 *   daily upload quota during full portal 0–4 E2E).
 * - **Set to comma list:** e.g. `youtube` or `youtube,tiktok`.
 */

/**
 * @returns {string[] | null} `null` if env var absent; otherwise a (possibly empty) platform list.
 */
function readAutoPublishPlatformsEnv() {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'AUTO_PUBLISH_PLATFORMS')) {
    return null;
  }
  const raw = process.env.AUTO_PUBLISH_PLATFORMS;
  const s = String(raw ?? '').trim();
  if (s === '' || /^none$/i.test(s) || /^skip$/i.test(s) || s === '0') {
    return [];
  }
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

module.exports = { readAutoPublishPlatformsEnv };
