'use strict';

function extractClipIdFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const slug = s.match(/clips\.twitch\.tv\/([^/?#]+)/i);
  if (slug) return slug[1];
  const clip = s.match(/twitch\.tv\/[^/]+\/clip\/([^/?#]+)/i);
  if (clip) return clip[1];
  const reddit = s.match(/comments\/([a-z0-9]+)/i);
  if (reddit) return reddit[1];
  if (/^reddit:[a-z0-9]+$/i.test(s)) return s.split(':')[1];
  return null;
}

module.exports = { extractClipIdFromUrl };
