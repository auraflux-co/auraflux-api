'use strict';
/**
 * lib/clip_comp_gag_overlay.js — optional sticker/gag overlays (CPD-1092, off by default)
 */

const fs = require('fs');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { escapeDrawtext } = require('./clip_comp_cards');

async function burnGagSticker(inputPath, outputPath, {
  stickerText = 'NEW',
  x = 'W-220',
  y = '120',
  log = () => {},
} = {}) {
  const vf = [
    `drawtext=text='${escapeDrawtext(stickerText)}':fontsize=36:fontcolor=0xFF4444`,
    'borderw=3:bordercolor=black',
    `x=${x}:y=${y}`,
  ].join(':');

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  log(`  🏷 Gag overlay: ${stickerText}`);
  return true;
}

async function applyGagOverlaysIfEnabled(inputPath, outputPath, compCreative, { log = () => {} } = {}) {
  if (!compCreative?.effects?.gagOverlays) {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }
  return burnGagSticker(inputPath, outputPath, { stickerText: 'NEW', log });
}

module.exports = {
  burnGagSticker,
  applyGagOverlaysIfEnabled,
};
