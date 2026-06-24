'use strict';
/**
 * lib/clip_comp_timeline.js — sports/news editorial timeline (intro, bridges, outro, xfade).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');
const {
  editorialEnabled,
  isEditorialContentType,
  loadEditorialConfig,
  planEditorialTransitions,
  buildSpokenScripts,
  resolveStingPath,
} = require('./clip_comp_editorial');
const { synthesizeSpeech } = require('./clip_comp_tts');
const { renderBrandCard, renderBridgeSegment } = require('./clip_comp_cards');

async function concatWithCrossfade(segmentPaths, outputPath, crossfadeSec, log) {
  if (segmentPaths.length === 0) throw new Error('no segments');
  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath);
    return outputPath;
  }

  const durs = await Promise.all(segmentPaths.map(p => probeDurationSec(p)));
  const TRANS = Math.min(crossfadeSec, 0.8);
  const inputs = segmentPaths.flatMap(p => ['-i', p]);

  const vNorm = segmentPaths.map((_, i) =>
    `[${i}:v]fps=30,setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,`
    + `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0d1424,format=yuv420p[nv${i}]`);
  const aNorm = segmentPaths.map((_, i) =>
    `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[na${i}]`);

  const xV = [];
  const xA = [];
  let vRef = 'nv0';
  let aRef = 'na0';
  let cum = durs[0] || 1;

  for (let i = 1; i < segmentPaths.length; i++) {
    const off = Math.max(0, cum - TRANS);
    const nextV = i === segmentPaths.length - 1 ? 'vout' : `xv${i}`;
    const nextA = i === segmentPaths.length - 1 ? 'aout' : `xa${i}`;
    xV.push(`[${vRef}][nv${i}]xfade=transition=fade:duration=${TRANS}:offset=${off.toFixed(3)}[${nextV}]`);
    xA.push(`[${aRef}][na${i}]acrossfade=d=${TRANS}[${nextA}]`);
    vRef = nextV;
    aRef = nextA;
    cum += (durs[i] || 1) - TRANS;
  }

  const fc = [...vNorm, ...aNorm, ...xV, ...xA].join(';');

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      ...inputs,
      '-filter_complex', fc,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    ], { timeout: 900000, maxBuffer: 80 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });

  if (log) log(`  ✅ Editorial timeline concat (${segmentPaths.length} segments, ${TRANS}s xfade)`);
  return outputPath;
}

/**
 * Build full editorial comp from per-clip portrait files.
 * @returns {Promise<string|null>} output path or null to fall back to plain concat
 */
async function assembleClipCompEditorialTimeline({
  clipPaths,
  items = [],
  contentType,
  compCreative = null,
  asmId,
  tmpDir,
  log = () => {},
}) {
  const { shouldUseClipCompEditorial } = require('./clip_comp_editorial');
  if (!editorialEnabled() || !shouldUseClipCompEditorial(contentType, compCreative) || !clipPaths?.length) {
    return null;
  }

  const cfg = loadEditorialConfig();
  const plan = await planEditorialTransitions({ contentType, items, log: (m) => log(m) });
  const spoken = buildSpokenScripts(contentType, plan, compCreative);
  const { dateLine } = require('./clip_comp_editorial').formatEditorialDate();

  const introAudio = path.join(tmpDir, `${asmId}_ed_intro.m4a`);
  const outroAudio = path.join(tmpDir, `${asmId}_ed_outro.m4a`);
  const introTts = await synthesizeSpeech(spoken.introText, introAudio, { log: (m) => log(m) });
  const outroTts = await synthesizeSpeech(spoken.outroText, outroAudio, { log: (m) => log(m) });
  if (!introTts || !outroTts) {
    log('  ⚠️  Editorial skipped — intro/outro TTS required');
    return null;
  }

  const introCard = path.join(tmpDir, `${asmId}_ed_intro.mp4`);
  const outroCard = path.join(tmpDir, `${asmId}_ed_outro.mp4`);
  await renderBrandCard({
    networkBrand: spoken.networkBrand,
    dateLine,
    categoryLabel: spoken.categoryLabel,
    handle: spoken.handle,
    accentColor: spoken.accentColor,
    audioPath: introAudio,
    minDurationSec: cfg.cardMinDurationSec,
    outputPath: introCard,
    log: (m) => log(m),
  });
  await renderBrandCard({
    networkBrand: spoken.networkBrand,
    dateLine,
    categoryLabel: spoken.categoryLabel,
    handle: spoken.handle,
    accentColor: spoken.accentColor,
    subline: 'Follow for daily highlights',
    audioPath: outroAudio,
    minDurationSec: cfg.cardMinDurationSec,
    outputPath: outroCard,
    log: (m) => log(m),
  });

  const segments = [introCard];
  const bridges = plan.bridges || [];

  for (let i = 0; i < clipPaths.length; i++) {
    segments.push(clipPaths[i]);
    if (i >= clipPaths.length - 1) break;

    const bridge = bridges[i] || { ttsLine: 'Next up.', transition: 'crossfade_only', stingProfile: null };
    const bridgeAudio = path.join(tmpDir, `${asmId}_ed_bridge_${i}.m4a`);
    const bridgeTts = await synthesizeSpeech(bridge.ttsLine, bridgeAudio, { log: (m) => log(m) });
    if (!bridgeTts) {
      log('  ⚠️  Bridge TTS failed — editorial fallback to plain concat');
      return null;
    }

    const stingPath = bridge.transition === 'sting' ? resolveStingPath(bridge.stingProfile) : null;
    const bridgeSeg = path.join(tmpDir, `${asmId}_ed_bridge_${i}.mp4`);
    await renderBridgeSegment({
      ttsAudioPath: bridgeAudio,
      stingPath,
      stingDurationSec: cfg.stingDurationSec,
      accentColor: spoken.accentColor,
      minDurationSec: cfg.bridgeMinDurationSec,
      outputPath: bridgeSeg,
      log: (m) => log(m),
    });
    segments.push(bridgeSeg);
  }

  segments.push(outroCard);

  const outPath = path.join(tmpDir, `${asmId}_comp_editorial.mp4`);
  await concatWithCrossfade(segments, outPath, cfg.crossfadeSec, (m) => log(m));
  log(`  🎬 Editorial comp: intro + ${clipPaths.length} clips + ${bridges.length} bridges + outro`);
  return outPath;
}

module.exports = {
  assembleClipCompEditorialTimeline,
  editorialEnabled,
  isEditorialContentType,
};
