'use strict';

/**
 * Permanent YouTube RTMP ingest — one liveStream in Studio, reused forever.
 * New liveBroadcast listings bind to the same streamId; never auto-create streams.
 */

function existingIngestStream(o = {}) {
  const streamId = o.streamId || process.env.LIVE_GRID_STREAM_ID || null;
  const rtmpUrl = o.output || process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL || null;
  if (!streamId || !rtmpUrl) return null;
  return { streamId, rtmpUrl };
}

function allowNewIngestStream(o = {}) {
  if (o.createStream === true) return true;
  return String(process.env.LIVE_GRID_ALLOW_NEW_STREAM || 'off').toLowerCase() === 'on';
}

/** Default on — attach to .env listing without YouTube API status/create calls (saves quota). */
function trustEnvBroadcast() {
  return String(process.env.LIVE_GRID_TRUST_ENV_BROADCAST ?? 'on').toLowerCase() !== 'off';
}

/**
 * Permanent RTMP + current listing from env/start body — zero API calls.
 * @returns {{ broadcastId, watchUrl, streamId, rtmpUrl }|null}
 */
function envBroadcastAttach(o = {}) {
  const broadcastId = o.broadcastId || process.env.LIVE_GRID_BROADCAST_ID || null;
  const ingest = existingIngestStream(o);
  if (!broadcastId || !ingest?.rtmpUrl) return null;
  const watchUrl = o.watchUrl || process.env.LIVE_GRID_WATCH_URL
    || `https://youtube.com/live/${broadcastId}`;
  return {
    broadcastId,
    watchUrl,
    streamId: ingest.streamId,
    rtmpUrl: o.output || ingest.rtmpUrl,
  };
}

const MISSING_INGEST_MSG =
  'YouTube ingest not configured — set LIVE_GRID_RTMP_URL + LIVE_GRID_STREAM_ID in .env ' +
  '(one permanent stream, reused across all sessions). New listings reuse that RTMP key; ' +
  'only create a stream once in Studio or with LIVE_GRID_ALLOW_NEW_STREAM=on / createStream:true.';

/**
 * Resolve ingest for broadcast create/start. Throws unless allowNewIngestStream.
 * @returns {{ streamId: string, rtmpUrl: string }|null} null = caller may create (one-time setup)
 */
function resolveIngestForCreate(o = {}, existingStream = null) {
  if (existingStream?.streamId && existingStream?.rtmpUrl) return existingStream;
  const fromEnv = existingIngestStream(o);
  if (fromEnv) return fromEnv;
  if (allowNewIngestStream(o)) return null;
  throw new Error(MISSING_INGEST_MSG);
}

module.exports = {
  existingIngestStream,
  allowNewIngestStream,
  trustEnvBroadcast,
  envBroadcastAttach,
  resolveIngestForCreate,
  MISSING_INGEST_MSG,
};
