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

/** CPD-1295 — bed roles for complementary vs hype under gameplay SFX */
const BED_META = {
  low_trap: { complement: false, label: 'hype' },
  neutral_lofi: { complement: true, label: 'lofi underscore' },
};

const SFX_FILES = {
  whoosh: 'ES_Oui (Instrumental Version) - Baha Bank$.mp3',
  impact: 'ES_BUZZER BEATER (Instrumental Version) - Demon Baby.mp3',
};

/** Default bed weight in amix — clip native stays dominant (weight 1). */
const DEFAULT_BED_MIX_WEIGHT = 0.22;
const DEFAULT_SFX_MIX_WEIGHT = 0.38;
const DEFAULT_SFX_VOLUME = 0.42;

/**
 * CPD-1295 Option B — resolve catalog key (auto_complement → quiet/lofi bed).
 * Operator `file:…` picks always win; bedStyle:'complement' upgrades catalog keys.
 */
function resolveEffectiveMusicBed(audio = {}) {
  const raw = audio.musicBed;
  if (!raw || raw === 'off') return null;
  if (String(raw).startsWith('file:')) return raw;
  if (raw === 'auto_complement' || audio.bedStyle === 'complement') {
    const pick = Object.keys(BED_META).find((k) => BED_META[k].complement);
    return pick || 'neutral_lofi';
  }
  return raw;
}

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
  // CPD-1294: FFmpeg sidechaincompress `mix` is how much of the *compressed*
  // signal to use (1 = full duck, 0 = bypass). Old mix=0.1 left ~90% unducked
  // bed under speech → music colliding with clip audio.
  return {
    threshold: 0.05,
    ratio: 6,
    attack: 12,
    release: 350,
    mix: 0.95,
    levelSc: 0.9,
  };
}

/**
 * CPD-1295 — dialogue-aware mix (Option A):
 * During speech: source full, bed near-muted.
 * Outside speech: source attenuated (game quieter), bed at creative level.
 * Default ON when a bed is ordered and duckSpeech is not false.
 */
function wantsDialogueAwareMix(audio = {}) {
  if (audio.dialogueAwareMix === false) return false;
  if (audio.dialogueAwareMix === true) return true;
  const bed = resolveEffectiveMusicBed(audio);
  return !!(bed && bed !== 'off' && audio.duckSpeech !== false);
}

function dialogueMixGains(audio = {}) {
  return {
    sourceInSpeech: Number.isFinite(Number(audio.sourceInSpeechGain))
      ? Number(audio.sourceInSpeechGain) : 1,
    sourceOutsideSpeech: Number.isFinite(Number(audio.sourceOutsideSpeechGain))
      ? Number(audio.sourceOutsideSpeechGain) : 0.32,
    bedInSpeech: Number.isFinite(Number(audio.bedInSpeechGain))
      ? Number(audio.bedInSpeechGain) : 0,
    bedOutsideSpeech: Number.isFinite(Number(audio.bedOutsideSpeechGain))
      ? Number(audio.bedOutsideSpeechGain) : 1,
  };
}

function mergeSpeechWindows(windows = [], { padSec = 0.12, mergeGapSec = 0.28 } = {}) {
  const cleaned = (windows || [])
    .map((w) => ({
      start: Math.max(0, Number(w.start) - padSec),
      end: Math.max(0, Number(w.end) + padSec),
    }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start + 0.04)
    .sort((a, b) => a.start - b.start);
  if (!cleaned.length) return [];
  const out = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    const prev = out[out.length - 1];
    const cur = cleaned[i];
    if (cur.start <= prev.end + mergeGapSec) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function speechWindowsFromWhisperPayload(payload) {
  const segs = payload?.segments;
  if (!Array.isArray(segs)) return [];
  return mergeSpeechWindows(
    segs.map((s) => ({ start: Number(s.start), end: Number(s.end) })),
  );
}

/** Escape commas for ffmpeg filtergraphs (`,` separates filters). */
function escapeFilterExpr(expr) {
  return String(expr).replace(/\\/g, '\\\\').replace(/,/g, '\\,');
}

/**
 * Build ffmpeg volume eval expression: inWinGain inside speech windows, else outWinGain.
 */
function buildSpeechGainExpr(windows, inWinGain, outWinGain) {
  const inside = Number(inWinGain);
  const outside = Number(outWinGain);
  if (!windows?.length) return outside.toFixed(4);
  const cond = windows
    .map((w) => `between(t,${w.start.toFixed(3)},${w.end.toFixed(3)})`)
    .join('+');
  return `if(${cond},${inside.toFixed(4)},${outside.toFixed(4)})`;
}

async function detectSpeechWindows(inputPath, { log = () => {} } = {}) {
  if (!process.env.OPENAI_API_KEY) {
    log('  🎙️ Dialogue-aware mix: OPENAI_API_KEY missing — falling back to sidechain duck only');
    return [];
  }
  const axios = require('axios');
  const FormData = require('form-data');
  const audioPath = inputPath.replace(/\.mp4$/i, `_dlg_audio_${Date.now()}.mp3`);
  try {
    await new Promise((res, rej) => {
      execFile(ffmpegPath(), [
        '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', audioPath,
      ], { timeout: 120000, maxBuffer: 40 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
    });
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 180000,
      maxBodyLength: Infinity,
    });
    const windows = speechWindowsFromWhisperPayload(resp.data);
    log(`  🎙️ Dialogue-aware mix: ${windows.length} speech window(s) from Whisper`);
    return windows;
  } catch (err) {
    log(`  ⚠️ Dialogue-aware mix Whisper failed (${err.message}) — sidechain duck only`);
    return [];
  } finally {
    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
  }
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
  speechWindows = null,
  dialogueGains = null,
} = {}) {
  const useDlg = Array.isArray(speechWindows) && speechWindows.length > 0 && dialogueGains;
  const srcExpr = useDlg
    ? buildSpeechGainExpr(
      speechWindows,
      dialogueGains.sourceInSpeech,
      dialogueGains.sourceOutsideSpeech,
    )
    : null;
  const mainChain = srcExpr
    ? `[0:a]volume=${escapeFilterExpr(srcExpr)}:eval=frame,aformat=sample_rates=48000:channel_layouts=stereo[main]`
    : '[0:a]aformat=sample_rates=48000:channel_layouts=stereo[main]';
  const filterParts = [mainChain];
  const mixInputs = ['[main]'];
  let inputIdx = sfxInputStartIdx;

  if (bedInputIdx != null) {
    const dur = Math.max(1, totalDur).toFixed(3);
    if (useDlg) {
      const bedExpr = buildSpeechGainExpr(
        speechWindows,
        dialogueGains.bedInSpeech,
        dialogueGains.bedOutsideSpeech,
      );
      // bedVol scales the creative level; dialogue expr gates under speech
      filterParts.push(
        `[${bedInputIdx}:a]volume=${bedVol.toFixed(4)},atrim=0:${dur},asetpts=PTS-STARTPTS,` +
        `volume=${escapeFilterExpr(bedExpr)}:eval=frame[bedraw]`,
      );
      mixInputs.push('[bedraw]');
    } else {
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
  const hasDrops = !!(highlight && highlight.enabled !== false
    && (Array.isArray(highlight.drops) ? highlight.drops.length > 0 : false));
  const bedKey = resolveEffectiveMusicBed(audio);
  return !!(bedKey && bedKey !== 'off')
    || !!(audio.cutSfx && audio.cutSfx !== 'off')
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
  speechWindows: speechWindowsIn = null,
} = {}) {
  const audio = compCreative?.audio || {};
  const bedKey = resolveEffectiveMusicBed(audio);
  const bedPath = resolveBedPath(bedKey);
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
  const bedMixWeight = Number(audio.bedMixWeight) > 0
    ? Number(audio.bedMixWeight)
    : DEFAULT_BED_MIX_WEIGHT;

  let speechWindows = Array.isArray(speechWindowsIn) ? mergeSpeechWindows(speechWindowsIn) : null;
  let dialogueGains = null;
  if (bedPath && !skipBed && wantsDialogueAwareMix(audio)) {
    if (!speechWindows) {
      speechWindows = await detectSpeechWindows(inputPath, { log });
    }
    const covered = speechWindows.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
    const minCover = Number.isFinite(Number(audio.minSpeechCoverSec))
      ? Number(audio.minSpeechCoverSec)
      : Math.max(2.5, totalDur * 0.12);
    if (speechWindows.length && covered >= minCover) {
      dialogueGains = dialogueMixGains(audio);
    } else if (speechWindows.length) {
      log(`  🎙️ Dialogue-aware mix: speech cover ${covered.toFixed(1)}s < ${minCover.toFixed(1)}s — sidechain duck fallback`);
      speechWindows = [];
    }
  }
  // Sidechain only when we do not have hard speech windows (CPD-1294 fallback)
  const duckParams = (bedPath && !skipBed && !dialogueGains) ? sidechainBedParams(audio) : null;

  // Main + bed via shared builder (no SFX); SFX appended with per-mark volumes
  const { filterParts: baseParts } = buildCompAudioFilterParts({
    totalDur,
    bedVol,
    bedInputIdx,
    duckParams,
    boundaries: [],
    sfxPaths: [],
    bedMixWeight,
    speechWindows: dialogueGains ? speechWindows : null,
    dialogueGains,
  });

  const filterParts = [];
  const mixInputs = ['[main]'];
  if (baseParts && baseParts.length) {
    // Drop trailing amix from base — we rebuild after SFX
    for (const part of baseParts) {
      if (part.includes('amix=') || part.includes('[aout]')) continue;
      filterParts.push(part);
    }
    if (bedInputIdx != null) {
      mixInputs.push(duckParams ? '[bed]' : '[bedraw]');
    }
  } else {
    filterParts.push('[0:a]aformat=sample_rates=48000:channel_layouts=stereo[main]');
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
    if (dialogueGains) {
      log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol} (dialogue-aware: bed×${dialogueGains.bedInSpeech} in speech / source×${dialogueGains.sourceOutsideSpeech} outside)`);
    } else if (duckParams) {
      log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol} (duck mix=${duckParams.mix})`);
    } else {
      log(`  🎵 Music bed: ${path.basename(bedPath)} @ ${bedVol} (constant under clip audio)`);
    }
    if (bedKey && bedKey !== audio.musicBed) {
      log(`  🎵 Bed key resolved ${audio.musicBed} → ${bedKey} (complement)`);
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
  speechWindows: speechWindowsIn = null,
} = {}) {
  const audio = compCreative?.audio || {};
  const bedKey = resolveEffectiveMusicBed(audio);
  const bedPath = resolveBedPath(bedKey);
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

  let speechWindows = Array.isArray(speechWindowsIn) ? mergeSpeechWindows(speechWindowsIn) : null;
  let dialogueGains = null;
  if (wantsDialogueAwareMix(audio)) {
    if (!speechWindows) {
      speechWindows = await detectSpeechWindows(inputPath, { log });
    }
    const covered = speechWindows.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
    const minCover = Number.isFinite(Number(audio.minSpeechCoverSec))
      ? Number(audio.minSpeechCoverSec)
      : Math.max(2.5, totalDur * 0.12);
    if (speechWindows.length && covered >= minCover) {
      dialogueGains = dialogueMixGains(audio);
    } else if (speechWindows.length) {
      log(`  🎙️ Dialogue-aware mix: speech cover ${covered.toFixed(1)}s < ${minCover.toFixed(1)}s — sidechain duck fallback`);
      speechWindows = [];
    }
  }
  const duckParams = dialogueGains ? null : sidechainBedParams(audio);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur,
    bedVol,
    bedInputIdx: 1,
    duckParams,
    boundaries: [],
    sfxInputStartIdx: 2,
    sfxPaths: [],
    bedMixWeight,
    speechWindows: dialogueGains ? speechWindows : null,
    dialogueGains,
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
  BED_META,
  SFX_FILES,
  resolveBedPath,
  resolveEffectiveMusicBed,
  resolveCutSfxPath,
  shouldMixCompAudio,
  sidechainBedParams,
  wantsDialogueAwareMix,
  dialogueMixGains,
  mergeSpeechWindows,
  speechWindowsFromWhisperPayload,
  buildSpeechGainExpr,
  escapeFilterExpr,
  detectSpeechWindows,
  probeHasAudioStream,
  ensureSegmentHasAudio,
  buildAmixFilter,
  buildCompAudioFilterParts,
  mixCompAudio,
  mixSegmentBed,
  DEFAULT_BED_MIX_WEIGHT,
  DEFAULT_SFX_MIX_WEIGHT,
};
