'use strict';

const { secToHms } = require('./time_ranges');

function parseGeminiCandidates(text, count = 8, durationSec = null, clipWindowSec = 60) {
  const results = [];
  const lines = String(text || '').split('\n');

  for (const line of lines) {
    let startS = null;
    const hm = line.match(/(\d+)h\s*(\d+)\s*m/i);
    if (hm) startS = Number(hm[1]) * 3600 + Number(hm[2]) * 60;
    if (startS == null) {
      const hms = line.match(/(\d+):(\d+):(\d+)/);
      if (hms) startS = Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
    }
    if (startS == null) {
      const ms = line.match(/(\d+):(\d+)/);
      if (ms && Number(ms[1]) < 100) startS = Number(ms[1]) * 60 + Number(ms[2]);
    }
    if (startS == null) {
      const min = line.match(/(\d+)\s*m(?:in(?:ute)?)?/i);
      if (min) startS = Number(min[1]) * 60;
    }
    if (startS == null) continue;
    if (durationSec && startS >= durationSec - 90) continue;

    const inExcluded = /skip|exclude|claimed|copyright|do not/i.test(line);
    const scoreMatch = line.match(/(?:score|rating|rank)\s*[:=]\s*(\d+(?:\.\d+)?)/i);
    const titleMatch = line.match(/(?:title|moment|clip)\s*[:–-]\s*([^|]+)/i)
      || line.match(/[\(\-–]\s*([^)]+)\)/);
    const endS = startS + Math.max(15, Math.min(120, clipWindowSec));
    results.push({
      start_s: startS,
      end_s: endS,
      title: (titleMatch ? titleMatch[1] : `Highlight at ${secToHms(startS)}`).trim().slice(0, 80),
      score: scoreMatch ? Number(scoreMatch[1]) : Math.max(0.5, 1 - results.length * 0.05),
      summary: line.trim().slice(0, 240),
      excludedWindow: inExcluded,
    });
    if (results.length >= count) break;
  }

  return results.filter((c) => !c.excludedWindow);
}

module.exports = { parseGeminiCandidates };
