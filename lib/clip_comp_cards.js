'use strict';
/**
 * lib/clip_comp_cards.js — branded intro/outro cards + show chips for clip comps.
 */

const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');

function escapeDrawtext(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\\:')
    .replace(/\n/g, '\\n');
}

/**
 * Render 1080×1920 brand card with optional TTS audio muxed in.
 */
async function renderBrandCard({
  networkBrand,
  dateLine,
  categoryLabel,
  handle,
  accentColor = '#1CE8FF',
  subline = null,
  audioPath = null,
  minDurationSec = 2.5,
  outputPath,
  log = null,
}) {
  const fontBold = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
  const fontReg = '/System/Library/Fonts/Supplemental/Arial.ttf';
  const bg = '0x0d1424';
  const dur = Math.max(minDurationSec, audioPath ? (await probeDurationSec(audioPath)) + 0.35 : minDurationSec);

  const dt = [
    `drawtext=fontfile=${fontBold}:text=${escapeDrawtext(networkBrand)}:fontsize=64:fontcolor=white:x=(w-text_w)/2:y=h*0.38:box=1:boxcolor=${accentColor}@0.35:boxborderw=18`,
    `drawtext=fontfile=${fontReg}:text=${escapeDrawtext(dateLine)}:fontsize=38:fontcolor=white@0.95:x=(w-text_w)/2:y=h*0.48`,
    `drawtext=fontfile=${fontBold}:text=${escapeDrawtext(categoryLabel)}:fontsize=44:fontcolor=${accentColor}:x=(w-text_w)/2:y=h*0.56`,
    `drawtext=fontfile=${fontReg}:text=${escapeDrawtext(handle)}:fontsize=34:fontcolor=white@0.85:x=(w-text_w)/2:y=h*0.64`,
  ];
  if (subline) {
    dt.push(`drawtext=fontfile=${fontReg}:text=${escapeDrawtext(subline)}:fontsize=30:fontcolor=white@0.8:x=(w-text_w)/2:y=h*0.72`);
  }

  const vf = `color=c=${bg}:s=1080x1920:d=${dur.toFixed(3)},format=yuv420p,${dt.join(',')}`;

  return new Promise((res, rej) => {
    const args = audioPath
      ? ['-f', 'lavfi', '-i', vf, '-i', audioPath, '-shortest', '-map', '0:v', '-map', '1:a']
      : ['-f', 'lavfi', '-i', vf];
    args.push(
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    );
    execFile(ffmpegPath(), args, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) return rej(err);
      if (log) log(`  🎴 Brand card (${dur.toFixed(1)}s)`);
      res({ path: outputPath, durationSec: dur });
    });
  });
}

/** Dark bridge card with TTS + optional sting mixed under voice. */
async function renderBridgeSegment({
  ttsAudioPath,
  stingPath = null,
  stingDurationSec = 0.45,
  accentColor = '#1CE8FF',
  minDurationSec = 2.0,
  outputPath,
  log = null,
}) {
  const ttsDur = ttsAudioPath ? await probeDurationSec(ttsAudioPath) : minDurationSec;
  const dur = Math.max(minDurationSec, ttsDur + 0.4);
  const vf = `color=c=0x0d1424:s=1080x1920:d=${dur.toFixed(3)},format=yuv420p`;

  const filterParts = [];
  let audioMap = null;

  if (stingPath && ttsAudioPath) {
    filterParts.push(
      `[1:a]atrim=0:${stingDurationSec},asetpts=PTS-STARTPTS,volume=0.55[sting]`,
      `[2:a]asetpts=PTS-STARTPTS,volume=1.0[voice]`,
      `[sting][voice]amix=inputs=2:duration=longest:dropout_transition=0[aout]`,
    );
    audioMap = '[aout]';
  } else if (ttsAudioPath) {
    audioMap = '1:a';
  }

  return new Promise((res, rej) => {
    const args = ['-f', 'lavfi', '-i', vf];
    if (stingPath) args.push('-i', stingPath);
    if (ttsAudioPath) args.push('-i', ttsAudioPath);

    if (filterParts.length) {
      args.push('-filter_complex', filterParts.join(';'));
      args.push('-map', '0:v', '-map', audioMap);
    } else if (ttsAudioPath) {
      args.push('-map', '0:v', '-map', '1:a', '-shortest');
    }

    args.push(
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-t', dur.toFixed(3),
      '-movflags', '+faststart', '-y', outputPath,
    );

    execFile(ffmpegPath(), args, { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) return rej(err);
      if (log) log(`  🔗 Bridge segment (${dur.toFixed(1)}s${stingPath ? ', sting' : ''})`);
      res({ path: outputPath, durationSec: dur });
    });
  });
}

/** Small top-left show chip on clip footage. */
async function burnClipCompShowChip(inputPath, outputPath, { chipText, accentColor = '#1CE8FF', log = null }) {
  const text = String(chipText || '').trim().slice(0, 36);
  if (!text) {
    const fs = require('fs');
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const font = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
  const dt = `drawtext=fontfile=${font}:text=${escapeDrawtext(text)}:fontsize=28:fontcolor=white:box=1:boxcolor=${accentColor}@0.88:boxborderw=10:x=36:y=36`;

  return new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', dt,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) return rej(err);
      if (log) log(`  🏷️  Show chip: "${text}"`);
      res(outputPath);
    });
  });
}

module.exports = {
  renderBrandCard,
  renderBridgeSegment,
  burnClipCompShowChip,
};
