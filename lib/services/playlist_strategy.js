'use strict';

/**
 * Playlist / series routing from brand publish_strategy_rules.
 * Gate: publish.playlist_strategy
 *
 * Rule shape:
 *   { match: { tag?, audioBed? }, destination: { platform, playlistId, playlistTitle } }
 */

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * @param {Array} rules
 * @param {{ tags?: string[], audioBed?: string|null, platform?: string }} ctx
 */
function matchPlaylistStrategy(rules, ctx = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const tags = (ctx.tags || []).map(normalize);
  const bed = normalize(ctx.audioBed);
  const platform = normalize(ctx.platform || 'youtube') || 'youtube';

  for (const rule of list) {
    const match = rule?.match || {};
    const dest = rule?.destination || {};
    if (!dest.playlistId && !dest.playlistTitle) continue;
    const destPlatform = normalize(dest.platform || 'youtube');
    if (destPlatform && destPlatform !== platform) continue;

    const tagNeed = normalize(match.tag);
    const bedNeed = normalize(match.audioBed);
    if (tagNeed && !tags.some((t) => t === tagNeed || t.includes(tagNeed))) continue;
    if (bedNeed && bed !== bedNeed && !bed.includes(bedNeed)) continue;
    if (!tagNeed && !bedNeed) continue;

    return {
      matched: true,
      rule,
      playlistId: dest.playlistId || null,
      playlistTitle: dest.playlistTitle || null,
      platform: destPlatform || 'youtube',
      badge: 'Auto-matched by strategy rule',
    };
  }

  return { matched: false };
}

module.exports = { matchPlaylistStrategy };
