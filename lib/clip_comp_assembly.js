'use strict';
/**
 * lib/clip_comp_assembly.js — creative-mode clip comp assembly helpers (CPD-1089–1092)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { applyPortraitLayout, resolveHookSharpBottom, resolveHookPlacement, resolveHookMidY } = require('./clip_comp_layout');
const { burnRankedListOverlay } = require('./clip_comp_ranked_overlay');
const { applyGagOverlaysIfEnabled } = require('./clip_comp_gag_overlay');
const { mixCompAudio, shouldMixCompAudio, ensureSegmentHasAudio, mixSegmentBed } = require('./clip_comp_audio_mix');
const { shouldUseClipCompEditorial } = require('./clip_comp_editorial');
const { probeDurationSec } = require('./clip_comp_tts');

/** Copy to dest.part then rename — browsers keep reading the old file during reassemble. */
function publishOutputAtomically(srcPath, destPath) {
  if (path.resolve(srcPath) === path.resolve(destPath)) return destPath;
  const partPath = `${destPath}.part`;
  fs.copyFileSync(srcPath, partPath);
  fs.renameSync(partPath, destPath);
  return destPath;
}

async function buildPortraitCompSegments({
  clipFiles,
  clipSourceIndices,
  resolvedHooks,
  hookDesignSpec,
  hookItems,
  ct,
  compCreative,
  asmId,
  tmpDir,
  log = () => {},
}) {
  const { burnClipCompHookCaption } = require('./assembly_postprocess');
  const { burnClipCompShowChip } = require('./clip_comp_cards');
  const { buildSpokenScripts } = require('./clip_comp_editorial');

  const useEditorial = shouldUseClipCompEditorial(ct, compCreative);
  let editorialAccent = '#c7af4f';
  if (useEditorial) {
    try {
      editorialAccent = buildSpokenScripts(ct, { topic: '' }, compCreative).accentColor;
    } catch (_) {}
  }

  const sharpBottom = resolveHookSharpBottom(compCreative);
  const clipCount = clipFiles.length;
  const portraitClips = [];
  const segmentDurations = [];
  let sourceCaptionsDetected = false;

  for (let ci = 0; ci < clipFiles.length; ci++) {
    const pc = path.join(tmpDir, `${asmId}_comp_${ci}.mp4`);
    await applyPortraitLayout(clipFiles[ci], pc, { compCreative, log: (m) => log(`  ${m}`) });

    const pcAudio = path.join(tmpDir, `${asmId}_comp_${ci}_aud.mp4`);
    await ensureSegmentHasAudio(pc, pcAudio, { log });
    let segPath = fs.existsSync(pcAudio) ? pcAudio : pc;
    const rankedOut = path.join(tmpDir, `${asmId}_comp_${ci}_ranked.mp4`);
    await burnRankedListOverlay(segPath, rankedOut, {
      compCreative,
      clipIndex: ci,
      clipCount,
      log,
    });
    if (fs.existsSync(rankedOut)) segPath = rankedOut;

    const hookMode = compCreative?.hooks?.mode || 'both';
    const whisperExpected = compCreative?.captions?.whisper !== false && hookMode !== 'hook_only';
    if (whisperExpected && !sourceCaptionsDetected) {
      try {
        const { detectBurnedCaptions } = require('./services/frame_intel');
        const hasSourceCaps = await detectBurnedCaptions(segPath, `${asmId}_clip_${ci}`);
        if (hasSourceCaps === true) {
          sourceCaptionsDetected = true;
          log(`  📝 Clip ${ci + 1}: creator captions detected in source — will skip whisper`);
        }
      } catch (capErr) {
        log(`  ⚠️  Pre-hook caption probe failed (non-fatal): ${capErr.message.slice(0, 100)}`);
      }
    }

    const hookIdx = clipSourceIndices[ci];
    const hookTitle = (hookIdx != null ? resolvedHooks[hookIdx] : resolvedHooks[ci]) || '';
    const burnHook = hookTitle && hookMode !== 'whisper_only';
    if (burnHook) {
      const pcHook = path.join(tmpDir, `${asmId}_comp_${ci}_hook.mp4`);
      await burnClipCompHookCaption(segPath, pcHook, {
        text: hookTitle,
        designSpec: hookDesignSpec,
        contentType: ct,
        sharpBottom,
        hookPlacement: resolveHookPlacement(compCreative),
        hookMidY: resolveHookMidY(compCreative),
        log: (m) => log(m),
      });
      segPath = fs.existsSync(pcHook) ? pcHook : segPath;
    }

    if (useEditorial && compCreative?.editorial?.enabled !== false) {
      const pcChip = path.join(tmpDir, `${asmId}_comp_${ci}_chip.mp4`);
      const chipText = hookTitle.split(/[|–-]/)[0].trim().slice(0, 36)
        || buildSpokenScripts(ct, { topic: '' }, compCreative).categoryLabel;
      await burnClipCompShowChip(segPath, pcChip, {
        chipText,
        accentColor: editorialAccent,
        log: (m) => log(m),
      });
      if (fs.existsSync(pcChip)) segPath = pcChip;
    }

    const gagOut = path.join(tmpDir, `${asmId}_comp_${ci}_gag.mp4`);
    await applyGagOverlaysIfEnabled(segPath, gagOut, compCreative, { log });
    if (fs.existsSync(gagOut)) segPath = gagOut;

    if (shouldMixCompAudio(compCreative) && compCreative?.audio?.bedPerSegment) {
      const segBed = path.join(tmpDir, `${asmId}_comp_${ci}_bed.mp4`);
      await mixSegmentBed(segPath, segBed, { compCreative, log });
      if (fs.existsSync(segBed)) segPath = segBed;
    }

    portraitClips.push(segPath);
    segmentDurations.push(await probeDurationSec(segPath));
  }

  return { portraitClips, segmentDurations, useEditorial, sourceCaptionsDetected };
}

async function concatPortraitClips(portraitClips, outputPath, asmId, tmpDir) {
  if (portraitClips.length === 1) {
    fs.copyFileSync(portraitClips[0], outputPath);
    return outputPath;
  }

  const listPath = path.join(tmpDir, `${asmId}_comp_concat_list.txt`);
  fs.writeFileSync(
    listPath,
    portraitClips.map(f => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n'),
  );

  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-fflags', '+genpts', '-avoid_negative_ts', 'make_zero',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  return outputPath;
}

async function assembleClipCompOutput({
  portraitClips,
  segmentDurations,
  useEditorial,
  hookItems,
  ct,
  compCreative,
  asmId,
  tmpDir,
  log = () => {},
}) {
  const outputPath = path.join(tmpDir, `${asmId}_comp_concat.mp4`);
  let editorialBuilt = false;

  if (useEditorial) {
    try {
      const { assembleClipCompEditorialTimeline } = require('./clip_comp_timeline');
      const edOut = await assembleClipCompEditorialTimeline({
        clipPaths: portraitClips,
        items: hookItems,
        contentType: ct,
        compCreative,
        asmId,
        tmpDir,
        log,
      });
      if (edOut && fs.existsSync(edOut)) {
        fs.copyFileSync(edOut, outputPath);
        editorialBuilt = true;
        log('  🎬 Editorial comp assembled (intro + bridges + outro)');
      }
    } catch (edErr) {
      log(`  ⚠️  Editorial timeline failed (non-fatal): ${edErr.message.slice(0, 140)}`);
    }
  }

  if (!editorialBuilt) {
    await concatPortraitClips(portraitClips, outputPath, asmId, tmpDir);
  }

  if (shouldMixCompAudio(compCreative)) {
    const mixedPath = path.join(tmpDir, `${asmId}_comp_audio.mp4`);
    await mixCompAudio(outputPath, mixedPath, {
      compCreative,
      clipDurationsSec: segmentDurations,
      log,
    });
    if (fs.existsSync(mixedPath)) publishOutputAtomically(mixedPath, outputPath);
  }

  return outputPath;
}

module.exports = {
  publishOutputAtomically,
  buildPortraitCompSegments,
  concatPortraitClips,
  assembleClipCompOutput,
};
