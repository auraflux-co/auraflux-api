'use strict';
/**
 * lib/clip_comp_audio_mix.js — music bed + cut SFX for clip comps (CPD-1089)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');

const AUDIO_DIR = path.join(__dirname, '..', 'assets', 'audio');

const BED_FILES = {
  low_trap: 'ES_ALMIGHTY - Cushy.mp3',
  neutral_lofi: 'ES_IRRATIONAL - Dylan Sitts.mp3',
};

const SFX_FILES = {
  whoosh: 'ES_Oui (Instrumental Version) - Baha Bank$.mp3',
  impact: 'ES_BUZZER BEATER (Instrumental Version) - Demon Baby.mp3',
};

function resolveBedPath(musicBed) {
  if (!musicBed || musicBed === 'off') return null;
  const file = BED_FILES[musicBed];
  if (!file) return null;
  const full = path.join(AUDIO_DIR, file);
  return fs.existsSync(full) ? full : null;
}

function resolveCutSfxPath(cutSfx) {
  if (!cutSfx || cutSfx === 'off') return null;
  if (cutSfx === 'serpent_pack') return resolveCutSfxPath('whoosh');
  const file = SFX_FILES[cutSfx] || SFX_FILES.whoosh;
  const full = path.join(AUDIO_DIR, file);
  return fs.existsSync(full) ? full : null;
}

function resolveSerpentSfxPaths() {
  return [resolveCutSfxPath('whoosh'), resolveCutSfxPath('impact')].filter(Boolean);
}

function shouldMixCompAudio(compCreative) {
  const audio = compCreative?.audio || {};
  return (audio.musicBed && audio.musicBed !== 'off')
    || (audio.cutSfx && audio.cutSfx !== 'off');
}

/**
 * Mix optional music bed + cut stings at clip boundaries onto a comp video.
 * @param {number[]} clipDurationsSec — per-segment durations in concat order
 */
async function mixCompAudio(inputPath, outputPath, {
  compCreative = null,
  clipDurationsSec = [],
  log = () => {},
} = {}) {
  const audio = compCreative?.audio || {};
  const bedPath = resolveBedPath(audio.musicBed);
  const cutSfx = audio.cutSfx || 'off';
  const bedVol = Number(audio.musicBedVolume) || 0.18;

  if (!bedPath && cutSfx === 'off') {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }

  const totalDur = await probeDurationSec(inputPath);
  const boundaries = [];
  let t = 0;
  for (let i = 0; i < clipDurationsSec.length - 1; i++) {
    t += clipDurationsSec[i] || 0;
    if (t > 0.05 && t < totalDur - 0.05) boundaries.push(t);
  }

  const inputs = ['-i', inputPath];
  const filterParts = ['[0:a]aformat=sample_rates=48000:channel_layouts=stereo[main]'];
  let mixInputs = ['[main]'];
  let inputIdx = 1;

  if (bedPath) {
    inputs.push('-stream_loop', '-1', '-i', bedPath);
    filterParts.push(
      `[${inputIdx}:a]volume=${bedVol.toFixed(3)},atrim=0:${Math.max(1, totalDur).toFixed(3)},asetpts=PTS-STARTPTS[bed]`,
    );
    mixInputs.push('[bed]');
    inputIdx += 1;
    log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol}`);
  }

  const sfxPaths = cutSfx === 'serpent_pack'
    ? resolveSerpentSfxPaths()
    : [resolveCutSfxPath(cutSfx)].filter(Boolean);

  for (let bi = 0; bi < boundaries.length; bi++) {
    const boundary = boundaries[bi];
    const sfxPath = sfxPaths[bi % sfxPaths.length];
    if (!sfxPath) continue;
    inputs.push('-i', sfxPath);
    const delayMs = Math.round(boundary * 1000);
    filterParts.push(
      `[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=0.55,apad=whole_dur=${Math.max(1, totalDur).toFixed(3)}[sfx${bi}]`,
    );
    mixInputs.push(`[sfx${bi}]`);
    inputIdx += 1;
  }

  if (mixInputs.length === 1) {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }

  filterParts.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=2[aout]`);

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    ], { timeout: 600000, maxBuffer: 80 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });

  log(`  🔊 Comp audio mix applied (bed=${!!bedPath}, sfx=${cutSfx}, cuts=${boundaries.length})`);
  return true;
}

module.exports = {
  BED_FILES,
  SFX_FILES,
  resolveBedPath,
  resolveCutSfxPath,
  shouldMixCompAudio,
  mixCompAudio,
};
