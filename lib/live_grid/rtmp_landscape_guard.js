'use strict';

/**
 * Guard against shipping square 1080×1080 to YouTube RTMP while the compositor
 * canvas is 1920×1080. Root cause of the last two bad VODs: LIVE_GRID_LOCAL_HLS=on
 * + LIVE_GRID_YOUTUBE_SQUARE_PAD defaulting to on → RTMP leg was square-padded.
 */

const { describeEncodePlan, gridLayoutDims } = require('./compositor');

function rtmpGuardEnabled() {
  return String(process.env.LIVE_GRID_ENFORCE_LANDSCAPE ?? 'on').toLowerCase() !== 'off';
}

/**
 * @param {{ output?: string, localHlsPath?: string|null, streamId?: string|null }} o
 * @returns {{ ok: boolean, plan?: object, error?: string, fix?: string }}
 */
function checkRtmpLandscapeEncode(o = {}) {
  const { outW, outH, landscape } = (() => {
    const dims = gridLayoutDims();
    return { ...dims, landscape: dims.outW > dims.outH };
  })();
  if (!landscape) return { ok: true, skipped: true };
  if (!o.output || !/^rtmps?:/.test(o.output)) return { ok: true, skipped: true };
  if (!rtmpGuardEnabled()) return { ok: true, skipped: true };

  const plan = describeEncodePlan(o);
  if (!plan.rtmpSquare) {
    return { ok: true, plan };
  }

  return {
    ok: false,
    plan,
    fix:
      'Set LIVE_GRID_YOUTUBE_SQUARE_PAD=off in .env (default is now off). ' +
      'Square pad only applies when LOCAL_HLS is on — it was sending 1080×1080 to YouTube ' +
      'while localhost preview stayed 1920×1080. Restart sidecar after .env change.',
    error:
      `RTMP encode plan is ${plan.rtmp} but grid canvas is ${plan.canvas}. ` +
      'YouTube VOD/thumbnails will be square and pillarboxed like the last two streams.',
  };
}

module.exports = {
  rtmpGuardEnabled,
  checkRtmpLandscapeEncode,
};
