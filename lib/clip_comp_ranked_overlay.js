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
  // Fixed row height + padding keeps every digit left-aligned on the same column.
  if (slotCount > 6) {
    return {
      headerSize: 50,
      listTop: 118,
      numSize: 38,
      numX: 44,
      rowHeight: 42,
      rowPadding: 14,
      rowGap: 56,
    };
  }
  return {
    headerSize: 64,
    listTop: 196,
    numSize: 74,
    numX: 52,
    rowHeight: 76,
    rowPadding: 22,
    rowGap: 98,
  };
}

function rankedSlotY(metrics, slot, slotCount) {
  const rowIndex = slotCount - slot;
  const rowStep = metrics.rowHeight + metrics.rowPadding;
  const rowTop = metrics.listTop + rowIndex * rowStep;
  const textYOffset = Math.round((metrics.rowHeight - metrics.numSize) * 0.42);
  return rowTop + textYOffset;
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
    'fontcolor=0xFFE566',
    'borderw=5',
    'bordercolor=black',
    'box=1',
    'boxcolor=black@0.72',
    'boxborderw=14',
    'x=(W-text_w)/2',
    'y=36',
  ].join(':'));

  for (let slot = 1; slot <= slotCount; slot++) {
    const highlighted = slot === activeSlot;
    const y = rankedSlotY(metrics, slot, slotCount);
    filters.push('drawtext=' + [
      `fontfile=${_escapeFontPath(font)}`,
      `text='${slot}'`,
      `fontsize=${metrics.numSize}`,
      `fontcolor=${highlighted ? '0xFFE566' : 'white@0.92'}`,
      `borderw=${highlighted ? 6 : 3}`,
      'bordercolor=black',
      ...(highlighted ? ['box=1', 'boxcolor=black@0.62', 'boxborderw=12'] : []),
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
  rankedSlotY,
  buildRankedOverlayDrawtext,
  burnRankedListOverlay,
};
