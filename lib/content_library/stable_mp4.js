'use strict';

/**
 * CPD-1273 — Detect stable AuraFlux / R2 library MP4s so EXECUTE never
 * rewrites peaks back to a YouTube watch URL + postLiveVod extract.
 */

function candidateUrls(clip = {}) {
  return [
    clip.mp4Url,
    clip.stagedUrl,
    clip.r2Url,
    clip.playbackUrl,
    clip.clipUrl,
    clip.url,
  ].filter(Boolean).map((u) => String(u));
}

function isStableLibraryMp4Url(url) {
  const s = String(url || '');
  if (!s || !/^https?:\/\//i.test(s)) return false;
  if (!/\.mp4(\?|#|$)/i.test(s)) return false;
  return /assets\.auraflux\.co/i.test(s) || /library-staging/i.test(s);
}

function pickStableLibraryMp4(clip = {}) {
  for (const u of candidateUrls(clip)) {
    if (isStableLibraryMp4Url(u)) return u;
  }
  return null;
}

function hasStableLibraryMp4(clip = {}) {
  return !!pickStableLibraryMp4(clip);
}

/** Peak windows staged from VODs — treat as library clips, not post-live extract. */
function isStagedVodPeakClip(clip = {}) {
  if (clip.vodPeakWindow) return true;
  if (hasStableLibraryMp4(clip) && /cwn_win=/i.test(String(clip.pageUrl || clip.url || ''))) {
    return true;
  }
  return hasStableLibraryMp4(clip) && !clip.postLiveVodSessionId;
}

module.exports = {
  candidateUrls,
  isStableLibraryMp4Url,
  pickStableLibraryMp4,
  hasStableLibraryMp4,
  isStagedVodPeakClip,
};
