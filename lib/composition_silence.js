'use strict';

const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

function parseSilenceRegions(stderr = '', offsetSec = 0) {
  const starts = [...String(stderr).matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...String(stderr).matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const regions = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    regions.push({
      start_sec: Math.round((starts[i] + offsetSec) * 10) / 10,
      end_sec: Math.round((ends[i] + offsetSec) * 10) / 10,
      duration_sec: Math.round((ends[i] - starts[i]) * 10) / 10,
    });
  }
  return regions;
}

function speechRegionsFromSilence(silenceRegions, totalDuration, offsetSec = 0) {
  const speech = [];
  let cursor = 0;
  for (const s of silenceRegions) {
    const relStart = s.start_sec - offsetSec;
    if (relStart - cursor >= 0.3) {
      speech.push({
        start_sec: Math.round((cursor + offsetSec) * 10) / 10,
        end_sec: s.start_sec,
      });
    }
    cursor = s.end_sec - offsetSec;
  }
  if (totalDuration - cursor >= 0.3) {
    speech.push({
      start_sec: Math.round((cursor + offsetSec) * 10) / 10,
      end_sec: Math.round((totalDuration + offsetSec) * 10) / 10,
    });
  }
  return speech;
}

async function detectSilenceOnFile(filePath, { thresholdDb = -30, minDuration = 0.4, offsetSec = 0 } = {}) {
  const stderr = await new Promise((resolve) => {
    execFile(ffmpegPath(), [
      '-i', filePath,
      '-af', `silencedetect=n=${thresholdDb}dB:d=${minDuration}`,
      '-vn', '-sn', '-dn', '-f', 'null', '/dev/null',
    ], { timeout: 120000 }, (_err, _stdout, errText) => resolve(errText || ''));
  });
  const durMatch = stderr.match(/Duration:\s*([\d:.]+)/);
  let totalDuration = 60;
  if (durMatch) {
    const parts = durMatch[1].split(':').map(parseFloat);
    totalDuration = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  const silence = parseSilenceRegions(stderr, offsetSec);
  return {
    silence,
    speech: speechRegionsFromSilence(silence, totalDuration, offsetSec),
    totalDuration,
  };
}

module.exports = {
  parseSilenceRegions,
  speechRegionsFromSilence,
  detectSilenceOnFile,
};
