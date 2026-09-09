'use strict';

function extractClipIdFromUrl(url) {
  if (!url) return null;
  const s = String(url);
  const yt = s.match(/[?&]v=([^&#]+)/i)
    || s.match(/youtu\.be\/([^?&#]+)/i)
    || s.match(/youtube\.com\/shorts\/([^?&#]+)/i)
    || s.match(/youtube\.com\/live\/([^?&#]+)/i);
  if (yt) return decodeURIComponent(yt[1]);
  const slug = s.match(/clips\.twitch\.tv\/([^/?#]+)/i);
  if (slug) return slug[1];
  const clip = s.match(/twitch\.tv\/[^/]+\/clip\/([^/?#]+)/i);
  if (clip) return clip[1];
  const vod = s.match(/twitch\.tv\/videos\/(\d+)/i);
  if (vod) return vod[1];
  const reddit = s.match(/comments\/([a-z0-9]+)/i);
  if (reddit) return reddit[1];
  if (/^reddit:[a-z0-9]+$/i.test(s)) return s.split(':')[1];
  return null;
}

module.exports = { extractClipIdFromUrl };
