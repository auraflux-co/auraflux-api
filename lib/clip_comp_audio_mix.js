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

/** Default bed weight in amix — clip native stays dominant (weight 1). */
const DEFAULT_BED_MIX_WEIGHT = 0.22;
const DEFAULT_SFX_MIX_WEIGHT = 0.38;
const DEFAULT_SFX_VOLUME = 0.42;

function resolveBedPath(musicBed) {
  if (!musicBed || musicBed === 'off') return null;
  let file = BED_FILES[musicBed];
  if (!file && String(musicBed).startsWith('file:')) {
    file = String(musicBed).slice(5);
  }
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

/** Sidechain only when explicitly enabled — ranked comps use constant quiet bed instead. */
function sidechainBedParams(audio = {}) {
  if (audio.duckSpeech === false) return null;
  return {
    threshold: 0.06,
    ratio: 3,
    attack: 15,
    release: 400,
    mix: 0.1,
    levelSc: 0.85,
  };
}

function probeHasAudioStream(filePath) {
  return new Promise((resolve) => {
    execFile(require('./ffmpeg_utils').ffprobePath(), [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0',
      filePath,
    ], (err, stdout) => resolve(!err && /audio/.test(String(stdout))));
  });
}

/**
 * Mux a silent stereo track when a clip segment has video but no audio stream.
 * Prevents concat from shifting the mixed timeline so clip 1 plays without bed.
 */
async function ensureSegmentHasAudio(inputPath, outputPath, { log = () => {} } = {}) {
  const hasAudio = await probeHasAudioStream(inputPath);
  if (hasAudio) {
    if (path.resolve(inputPath) !== path.resolve(outputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return false;
  }

  const dur = await probeDurationSec(inputPath);
  const padDur = Math.max(0.1, dur || 1);
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${padDur.toFixed(3)}`,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  log('  🔇 Silent audio track added — source clip had no audio stream');
  return true;
}

function buildAmixFilter(mixInputs, { bedWeight = DEFAULT_BED_MIX_WEIGHT, sfxWeight = DEFAULT_SFX_MIX_WEIGHT } = {}) {
  const weights = mixInputs.map((label, i) => {
    if (i === 0) return '1';
    if (/bed/i.test(label)) return String(bedWeight);
    return String(sfxWeight);
  });
  return `${mixInputs.join('')}amix=inputs=${mixInputs.length}:weights=${weights.join(' ')}:normalize=0:duration=first:dropout_transition=2[aout]`;
}

/**
 * Build ffmpeg filter_complex segments for comp bed + SFX (exported for tests).
 */
function buildCompAudioFilterParts({
  totalDur,
  bedVol,
  bedInputIdx,
  duckParams,
  boundaries = [],
  sfxInputStartIdx = 2,
  sfxPaths = [],
  bedMixWeight = DEFAULT_BED_MIX_WEIGHT,
  sfxMixWeight = DEFAULT_SFX_MIX_WEIGHT,
  sfxVolume = DEFAULT_SFX_VOLUME,
} = {}) {
  const filterParts = ['[0:a]aformat=sample_rates=48000:channel_layouts=stereo[main]'];
  const mixInputs = ['[main]'];
  let inputIdx = sfxInputStartIdx;

  if (bedInputIdx != null) {
    const dur = Math.max(1, totalDur).toFixed(3);
    filterParts.push(
      `[${bedInputIdx}:a]volume=${bedVol.toFixed(4)},atrim=0:${dur},asetpts=PTS-STARTPTS[bedraw]`,
    );
    if (duckParams) {
      const sc = duckParams;
      filterParts.push(
        `[bedraw][main]sidechaincompress=threshold=${sc.threshold}:ratio=${sc.ratio}:attack=${sc.attack}:release=${sc.release}:mix=${sc.mix}:level_sc=${sc.levelSc}[bed]`,
      );
      mixInputs.push('[bed]');
    } else {
      mixInputs.push('[bedraw]');
    }
  }

  for (let bi = 0; bi < boundaries.length; bi++) {
    if (!sfxPaths[bi % sfxPaths.length]) continue;
    const delayMs = Math.round(boundaries[bi] * 1000);
    filterParts.push(
      `[${inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${sfxVolume.toFixed(2)},apad=whole_dur=${Math.max(1, totalDur).toFixed(3)}[sfx${bi}]`,
    );
    mixInputs.push(`[sfx${bi}]`);
    inputIdx += 1;
  }

  if (mixInputs.length === 1) return { filterParts: null, mixInputs };

  filterParts.push(buildAmixFilter(mixInputs, { bedWeight: bedMixWeight, sfxWeight: sfxMixWeight }));
  return { filterParts, mixInputs };
}

function shouldMixCompAudio(compCreative) {
  const audio = compCreative?.audio || {};
  const highlight = audio.highlightSfx || compCreative?.highlightSfx;
  const hasDrops = highlight && highlight.enabled !== false
    && (Array.isArray(highlight.drops) ? highlight.drops.length > 0 : false);
  return (audio.musicBed && audio.musicBed !== 'off')
    || (audio.cutSfx && audio.cutSfx !== 'off')
    || hasDrops;
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
  const skipBed = !!audio.bedPerSegment;
  const { normalizeHighlightDrops, resolveSfxPath } = require('./highlight_sfx');
  const highlightCfg = audio.highlightSfx || compCreative?.highlightSfx || null;
  const highlightDrops = normalizeHighlightDrops(highlightCfg);

  if ((!bedPath || skipBed) && cutSfx === 'off' && !highlightDrops.length) {
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
  let bedInputIdx = null;
  if (bedPath && !skipBed) {
    inputs.push('-stream_loop', '-1', '-i', bedPath);
    bedInputIdx = 1;
  }

  const cutSfxPaths = cutSfx === 'serpent_pack'
    ? resolveSerpentSfxPaths()
    : [resolveCutSfxPath(cutSfx)].filter(Boolean);

  let nextInputIdx = (bedPath && !skipBed) ? 2 : 1;
  const cutBoundaryMarks = [];
  for (let bi = 0; bi < boundaries.length; bi++) {
    const sfxPath = cutSfxPaths[bi % cutSfxPaths.length];
    if (!sfxPath) continue;
    inputs.push('-i', sfxPath);
    cutBoundaryMarks.push({ atSec: boundaries[bi], inputIdx: nextInputIdx, volume: DEFAULT_SFX_VOLUME });
    nextInputIdx += 1;
  }

  // CPD-1286: beat/highlight SFX drops (independent of cut boundaries)
  const highlightMarks = [];
  for (const drop of highlightDrops) {
    if (drop.atSec >= totalDur - 0.05) continue;
    const sfxPath = resolveSfxPath(drop.kind);
    if (!sfxPath) continue;
    inputs.push('-i', sfxPath);
    highlightMarks.push({ atSec: drop.atSec, inputIdx: nextInputIdx, volume: drop.volume });
    nextInputIdx += 1;
  }

  const allSfxMarks = [...cutBoundaryMarks, ...highlightMarks];
  const duckParams = bedPath && !skipBed ? sidechainBedParams(audio) : null;
  const bedMixWeight = Number(audio.bedMixWeight) > 0
    ? Number(audio.bedMixWeight)
    : DEFAULT_BED_MIX_WEIGHT;

  // Build filter with arbitrary timed SFX (not only boundary list)
  const filterParts = ['[0:a]aformat=sample_rates=48000:channel_layouts=stereo[main]'];
  const mixInputs = ['[main]'];
  if (bedInputIdx != null) {
    const dur = Math.max(1, totalDur).toFixed(3);
    filterParts.push(
      `[${bedInputIdx}:a]volume=${bedVol.toFixed(4)},atrim=0:${dur},asetpts=PTS-STARTPTS[bedraw]`,
    );
    if (duckParams) {
      const sc = duckParams;
      filterParts.push(
        `[bedraw][main]sidechaincompress=threshold=${sc.threshold}:ratio=${sc.ratio}:attack=${sc.attack}:release=${sc.release}:mix=${sc.mix}:level_sc=${sc.levelSc}[bed]`,
      );
      mixInputs.push('[bed]');
    } else {
      mixInputs.push('[bedraw]');
    }
  }
  for (let i = 0; i < allSfxMarks.length; i++) {
    const m = allSfxMarks[i];
    const delayMs = Math.round(m.atSec * 1000);
    const vol = Number(m.volume) || DEFAULT_SFX_VOLUME;
    filterParts.push(
      `[${m.inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${vol.toFixed(2)},apad=whole_dur=${Math.max(1, totalDur).toFixed(3)}[sfx${i}]`,
    );
    mixInputs.push(`[sfx${i}]`);
  }

  if (mixInputs.length === 1) {
    fs.copyFileSync(inputPath, outputPath);
    return false;
  }
  filterParts.push(buildAmixFilter(mixInputs, { bedWeight: bedMixWeight, sfxWeight: DEFAULT_SFX_MIX_WEIGHT }));

  if (bedPath && !skipBed) {
    if (duckParams) {
      log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol} (duck mix=${duckParams.mix})`);
    } else {
      log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol} (constant under clip audio)`);
    }
  }

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

  log(`  🔊 Comp audio mix applied (bed=${!!bedPath && !skipBed}, cutSfx=${cutSfx}, highlights=${highlightMarks.length}, cuts=${cutBoundaryMarks.length})`);
  return true;
}

/**
 * Mix music bed onto a single clip segment (before concat).
 * Fixes clip 1 bed misalignment when concat timeline shifts vs full-comp bed pass.
 */
async function mixSegmentBed(inputPath, outputPath, {
  compCreative = null,
  log = () => {},
} = {}) {
  const audio = compCreative?.audio || {};
  const bedPath = resolveBedPath(audio.musicBed);
  if (!bedPath) {
    if (path.resolve(inputPath) !== path.resolve(outputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return false;
  }

  const totalDur = await probeDurationSec(inputPath);
  const bedVol = Number(audio.musicBedVolume) || 0.18;
  const bedMixWeight = Number(audio.bedMixWeight) > 0
    ? Number(audio.bedMixWeight)
    : DEFAULT_BED_MIX_WEIGHT;
  const duckParams = sidechainBedParams(audio);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur,
    bedVol,
    bedInputIdx: 1,
    duckParams,
    boundaries: [],
    sfxInputStartIdx: 2,
    sfxPaths: [],
    bedMixWeight,
  });

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-stream_loop', '-1', '-i', bedPath,
      '-filter_complex', filterParts.join(';'),
      '-map', '0:v', '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    ], { timeout: 300000, maxBuffer: 80 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });

  log(`  🎵 Segment bed: ${path.basename(bedPath)} @ ${bedVol}`);
  return true;
}

module.exports = {
  AUDIO_DIR,
  BED_FILES,
  SFX_FILES,
  resolveBedPath,
  resolveCutSfxPath,
  shouldMixCompAudio,
  sidechainBedParams,
  probeHasAudioStream,
  ensureSegmentHasAudio,
  buildAmixFilter,
  buildCompAudioFilterParts,
  mixCompAudio,
  mixSegmentBed,
  DEFAULT_BED_MIX_WEIGHT,
  DEFAULT_SFX_MIX_WEIGHT,
};
