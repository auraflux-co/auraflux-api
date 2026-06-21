'use strict';

/** Redact YouTube RTMP ingest keys from operator read APIs when LIVE_GRID_PROTECT_YT_RTMP=on. */

function protectYtRtmpEnabled() {
  return String(process.env.LIVE_GRID_PROTECT_YT_RTMP ?? 'on').toLowerCase() !== 'off';
}

function redactRtmpUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/\/live2\/.+$/, '/live2/…');
}

function redactListing(listing) {
  if (!listing || !protectYtRtmpEnabled()) return listing;
  const out = { ...listing };
  if (out.rtmpUrl) out.rtmpUrl = redactRtmpUrl(out.rtmpUrl);
  return out;
}

function redactSoloListings(listings) {
  if (!Array.isArray(listings)) return listings;
  return listings.map(redactListing);
}

module.exports = {
  protectYtRtmpEnabled,
  redactRtmpUrl,
  redactListing,
  redactSoloListings,
};
