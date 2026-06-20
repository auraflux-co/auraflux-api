'use strict';

const fs = require('fs');
const path = require('path');

function hlsSegmentTimeSec() {
  return parseInt(process.env.LIVE_GRID_HLS_TIME || '2', 10);
}

function hlsListSize() {
  return parseInt(process.env.LIVE_GRID_HLS_LIST_SIZE || '12', 10);
}

function hlsDeleteSegmentsEnabled() {
  return String(process.env.LIVE_GRID_HLS_DELETE_SEGMENTS || 'on').toLowerCase() !== 'off';
}

/** FFmpeg hls_flags for compositor → local preview (middleware delivery path). */
function hlsFlagsString() {
  const flags = ['append_list', 'omit_endlist', 'independent_segments'];
  if (hlsDeleteSegmentsEnabled()) flags.unshift('delete_segments');
  return flags.join('+');
}

/** Args for `-f hls` output (middleware compositor writes here; restreamer reads). */
function hlsOutputArgs(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  return [
    '-f', 'hls',
    '-hls_time', String(hlsSegmentTimeSec()),
    '-hls_list_size', String(hlsListSize()),
    '-hls_flags', hlsFlagsString(),
    targetPath,
  ];
}

/** Tee muxer HLS leg: `[f=hls:...]path` */
function hlsTeeSpec(targetPath) {
  const segTime = hlsSegmentTimeSec();
  const listSize = hlsListSize();
  const flags = hlsFlagsString();
  return `[f=hls:hls_time=${segTime}:hls_list_size=${listSize}:hls_flags=${flags}:onfail=ignore]${targetPath}`;
}

module.exports = {
  hlsSegmentTimeSec,
  hlsListSize,
  hlsDeleteSegmentsEnabled,
  hlsFlagsString,
  hlsOutputArgs,
  hlsTeeSpec,
};
