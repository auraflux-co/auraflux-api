'use strict';
/**
 * lib/clip_comp_ranked_overlay.js — Stream Serpent ranked-list overlay (CPD-1090)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { escapeDrawtext } = require('./clip_comp_cards');
const { buildRankedListHeader, resolveActiveRankSlot } = require('./clip_comp_titles');

const DEFAULT_FONT = path.join(__dirname, '..', 'assets', 'fonts', 'BarlowCondensed-SemiBold.ttf');

function _escapeFontPath(fontPath) {
  return String(fontPath || DEFAULT_FONT)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

function rankedOverlayMetrics(slotCount) {
  if (slotCount > 6) {
    return { headerSize: 44, rowGap: 52, listTop: 132, numHi: 52, numLo: 36, numX: 48 };
  }
  return { headerSize: 54, rowGap: 84, listTop: 188, numHi: 96, numLo: 68, numX: 56 };
}

function buildRankedOverlayDrawtext(compCreative, { activeSlot = 1, font = DEFAULT_FONT } = {}) {
  const rl = compCreative?.hooks?.rankedList || {};
  if (!rl.enabled) return '';

  const slotCount = Math.max(1, Number(rl.slotCount) || 5);
  const header = buildRankedListHeader(compCreative);
  const metrics = rankedOverlayMetrics(slotCount);
  const filters = [];

  filters.push('drawtext=' + [
    `fontfile=${_escapeFontPath(font)}`,
    `text='${escapeDrawtext(header)}'`,
    `fontsize=${metrics.headerSize}`,
    'fontcolor=white',
    'borderw=4',
    'bordercolor=black',
    'x=(W-text_w)/2',
    'y=44',
  ].join(':'));

  for (let slot = 1; slot <= slotCount; slot++) {
    const highlighted = slot === activeSlot;
    const y = metrics.listTop + (slotCount - slot) * metrics.rowGap;
    filters.push('drawtext=' + [
      `fontfile=${_escapeFontPath(font)}`,
      `text='${slot}'`,
      `fontsize=${highlighted ? metrics.numHi : metrics.numLo}`,
      `fontcolor=${highlighted ? '0xFFE566' : 'white'}`,
      `borderw=${highlighted ? 4 : 2}`,
      'bordercolor=black',
      `x=${metrics.numX}`,
      `y=${y}`,
    ].join(':'));
  }

  return filters.join(',');
}

async function burnRankedListOverlay(inputPath, outputPath, {
  compCreative,
  clipIndex = 0,
  clipCount = 1,
  log = () => {},
} = {}) {
  if (!compCreative?.hooks?.rankedList?.enabled) {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }

  const activeSlot = resolveActiveRankSlot(compCreative, clipIndex, clipCount);
  const vf = buildRankedOverlayDrawtext(compCreative, { activeSlot });
  if (!vf) {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });

  log(`  🏆 Ranked overlay slot #${activeSlot} (clip ${clipIndex + 1}/${clipCount})`);
  return true;
}

module.exports = {
  rankedOverlayMetrics,
  buildRankedOverlayDrawtext,
  burnRankedListOverlay,
};
