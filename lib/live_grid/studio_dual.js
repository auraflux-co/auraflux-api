'use strict';

/**
 * CPD-1029 — YouTube Studio native dual-format (Auto vertical).
 * Dual stream toggles are locked while RTMP is flowing; hold encoder until Studio is configured.
 */

function youtubeNativeDualEnabled() {
  return String(process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM ?? 'on').toLowerCase() === 'on';
}

function studioDualFirstEnabled() {
  return youtubeNativeDualEnabled()
    && String(process.env.LIVE_GRID_STUDIO_DUAL_FIRST ?? 'off').toLowerCase() === 'on';
}

/** @param {object} o start opts */
function shouldHoldRtmpForStudio(o = {}, ctx = {}) {
  if (ctx.forceLocalOnly) return false;
  if (!ctx.broadcast?.broadcastId || ctx.broadcast.localOnly) return false;
  if (o._rtmpGo === true || o.rtmpGo === true) return false;
  return studioDualFirstEnabled();
}

function studioUrlForBroadcast(broadcastId) {
  if (!broadcastId) return 'https://studio.youtube.com';
  return `https://studio.youtube.com/video/${broadcastId}/livestreaming`;
}

function studioDualInstructions(broadcast) {
  const broadcastId = broadcast?.broadcastId || broadcast?.id || null;
  const watchUrl = broadcast?.watchUrl || (broadcastId ? `https://youtube.com/live/${broadcastId}` : null);
  const studioUrl = studioUrlForBroadcast(broadcastId);
  const steps = [
    `Open YouTube Studio → ${studioUrl}`,
    'Stream tab → Stream settings → Dual stream → ON → Vertical format: Auto',
    'POST /live-grid/rtmp-go when Dual stream is saved (starts RTMP to YouTube)',
  ];
  return {
    rtmpHeld: true,
    summary: 'RTMP held until Dual stream (Auto vertical) is enabled in YouTube Studio',
    steps,
    watchUrl,
    studioUrl,
    broadcastId,
    rtmpGoEndpoint: '/live-grid/rtmp-go',
  };
}

module.exports = {
  youtubeNativeDualEnabled,
  studioDualFirstEnabled,
  shouldHoldRtmpForStudio,
  studioUrlForBroadcast,
  studioDualInstructions,
};
