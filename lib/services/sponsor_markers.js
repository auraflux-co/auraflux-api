'use strict';

/**
 * Sponsor / ad phrase detection from transcripts (not core peak detection).
 * Gate: sponsor.markers
 */

const SPONSOR_PHRASES = [
  /sponsored by/i,
  /this (episode|video|stream) is sponsored/i,
  /thanks to .{2,40} for/i,
  /brought to you by/i,
  /check out the link/i,
  /link in (the )?description/i,
  /use (promo )?code/i,
  /today'?s sponsor/i,
  /partner(ed)? with/i,
  /ad break/i,
];

/**
 * @param {string|Array<{text?:string,start?:number,end?:number,startSec?:number,endSec?:number}>} transcript
 * @returns {Array<{startSec:number,endSec:number,phrase:string,confidence:number}>}
 */
function detectSponsorMarkers(transcript) {
  const markers = [];
  if (!transcript) return markers;

  if (typeof transcript === 'string') {
    const lower = transcript;
    for (const re of SPONSOR_PHRASES) {
      const m = lower.match(re);
      if (m && m.index != null) {
        // String transcripts lack timing — mark as whole-clip soft hit at 0..0
        markers.push({
          startSec: 0,
          endSec: 0,
          phrase: m[0],
          confidence: 0.55,
          untimed: true,
        });
      }
    }
    return markers;
  }

  if (!Array.isArray(transcript)) return markers;

  for (const seg of transcript) {
    const text = String(seg.text || seg.transcript || '');
    if (!text) continue;
    const startSec = Number(seg.startSec ?? seg.start ?? seg.start_time ?? 0) || 0;
    const endSec = Number(seg.endSec ?? seg.end ?? seg.end_time ?? startSec + 8) || (startSec + 8);
    for (const re of SPONSOR_PHRASES) {
      const m = text.match(re);
      if (m) {
        markers.push({
          startSec,
          endSec: Math.max(endSec, startSec + 2),
          phrase: m[0],
          confidence: 0.85,
          untimed: false,
        });
        break;
      }
    }
  }

  return markers;
}

/**
 * Nudge trim window outside overlapping sponsor reads.
 * @returns {{ trimStart: number, trimEnd: number, adjusted: boolean, reason?: string }}
 */
function adjustBoundariesForSponsors(trimStart, trimEnd, markers, { padSec = 0.5 } = {}) {
  let start = Math.max(0, Number(trimStart) || 0);
  let end = Number(trimEnd);
  if (!Number.isFinite(end) || end <= start) {
    return { trimStart: start, trimEnd: end, adjusted: false };
  }

  let adjusted = false;
  let reason;
  for (const mk of (markers || [])) {
    if (mk.untimed) continue;
    const ms = Number(mk.startSec);
    const me = Number(mk.endSec);
    if (!Number.isFinite(ms) || !Number.isFinite(me)) continue;
    // Overlap?
    if (me <= start || ms >= end) continue;
    // Prefer cutting before sponsor read
    if (ms > start + 2) {
      end = Math.max(start + 1, ms - padSec);
      adjusted = true;
      reason = `trimmed before sponsor: "${mk.phrase}"`;
    } else if (me < end - 2) {
      start = me + padSec;
      adjusted = true;
      reason = `trimmed after sponsor: "${mk.phrase}"`;
    }
  }

  if (end <= start) {
    return { trimStart: Number(trimStart) || 0, trimEnd: Number(trimEnd), adjusted: false };
  }
  return { trimStart: start, trimEnd: end, adjusted, reason };
}

/**
 * Build lower-third item when Append Sponsor Overlay is on.
 */
function buildSponsorLowerThird(markers, brandName) {
  const hit = (markers || []).find((m) => m.phrase);
  if (!hit) return null;
  const label = brandName
    ? `Sponsored · ${brandName}`
    : `Sponsored · ${String(hit.phrase).slice(0, 40)}`;
  return {
    text: label,
    startSec: hit.untimed ? 0 : hit.startSec,
    durationSec: hit.untimed ? 4 : Math.min(6, Math.max(3, (hit.endSec - hit.startSec) || 4)),
    style: 'sponsor',
  };
}

module.exports = {
  SPONSOR_PHRASES,
  detectSponsorMarkers,
  adjustBoundariesForSponsors,
  buildSponsorLowerThird,
};
