'use strict';
/**
 * lib/clip_comp_dual_source.js — Two different sources stacked on 9:16
 * with hold-then-switch playback (Age 7 / Age 16 style).
 *
 * Phase 1: TOP plays for switchSec (trim window or explicit); BOTTOM held on first frame.
 * Phase 2: BOTTOM plays its trim; TOP held on last frame.
 * Labels burn on each pane for the full duration.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath, ffmpegEncodeArgs } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');

const HALF_W = 1080;
const HALF_H = 960; // 1080×1920 stacked

function isDualSourceStackMode(compCreative) {
  const mode = String(compCreative?.layout?.mode || '');
  const preset = String(compCreative?.preset || '');
  return mode === 'dual_source_vstack'
    || preset === 'dual_source_stack';
}

function escapeDrawtext(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function resolveTrimWindow(meta = {}, fileDurSec = 0) {
  const stagedPeak = !!(meta.vodPeakWindow || meta.stagedUrl || meta.r2Url
    || meta.game === 'import');
  let start = Number(meta.trimStart);
  let end = meta.trimEnd != null ? Number(meta.trimEnd) : null;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end <= start) {
    end = fileDurSec > 0 ? fileDurSec : start + 20;
  }
  // Staged peak / import windows are often already 0-based copies of the trim.
  // Prefer relative window length from composer when start>0 on a short file.
  let seek = start;
  let playDur = Math.max(0.5, end - start);
  if (stagedPeak && fileDurSec > 0 && fileDurSec <= playDur + 1.5 && start > 0) {
    // File is the window already — play from 0 for file duration (or remaining trim)
    seek = 0;
    playDur = Math.min(fileDurSec, playDur);
  } else if (stagedPeak && start === 0 && fileDurSec > 0) {
    playDur = Math.min(fileDurSec, playDur);
  }
  return { seek, playDur, start, end };
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 80 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tip = String(stderr || err.message || '').slice(-400);
        reject(new Error(`${label} failed: ${tip || err.message}`));
        return;
      }
      resolve();
    });
    proc.on('error', reject);
  });
}

const HALF_VF = `fps=fps=30,scale=${HALF_W}:${HALF_H}:force_original_aspect_ratio=increase,`
  + `crop=${HALF_W}:${HALF_H},setsar=1,setpts=PTS-STARTPTS`;

/**
 * Build one half-frame clip from a source window (video + optional audio).
 */
async function renderHalfClip({
  srcPath, seek, durationSec, outPath, withAudio = true,
}) {
  const args = [
    '-ss', Number(seek).toFixed(3),
    '-i', srcPath,
    '-t', Number(durationSec).toFixed(3),
    '-vf', HALF_VF,
    ...ffmpegEncodeArgs(true),
  ];
  if (withAudio) {
    args.push('-af', 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-pix_fmt', 'yuv420p', '-y', outPath);
  await runFfmpeg(args, 'half-clip');
  return outPath;
}

/** First-frame still held for durationSec (no audio). */
async function renderHalfHoldStill({
  srcPath, seek, durationSec, outPath, tmpDir, asmId, tag,
}) {
  const stillPath = path.join(tmpDir, `${asmId}_${tag}_still.png`);
  await runFfmpeg([
    '-ss', Number(seek).toFixed(3),
    '-i', srcPath,
    '-frames:v', '1',
    '-vf', `scale=${HALF_W}:${HALF_H}:force_original_aspect_ratio=increase,crop=${HALF_W}:${HALF_H}`,
    '-y', stillPath,
  ], 'still-frame');
  await runFfmpeg([
    '-loop', '1',
    '-i', stillPath,
    '-t', Number(durationSec).toFixed(3),
    '-vf', `fps=fps=30,scale=${HALF_W}:${HALF_H},setsar=1,format=yuv420p`,
    ...ffmpegEncodeArgs(true),
    '-an',
    '-y', outPath,
  ], 'still-hold');
  try { fs.unlinkSync(stillPath); } catch (_) { /* ignore */ }
  return outPath;
}

/** Extend last frame of an existing half clip by holdSec (keeps audio padded silent). */
async function extendWithLastFrameHold(srcHalfPath, holdSec, outPath) {
  const hold = Math.max(0.05, Number(holdSec) || 0);
  await runFfmpeg([
    '-i', srcHalfPath,
    '-vf', `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`,
    '-af', `apad=pad_dur=${hold.toFixed(3)}`,
    ...ffmpegEncodeArgs(true),
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-pix_fmt', 'yuv420p',
    '-y', outPath,
  ], 'last-frame-hold');
  return outPath;
}

async function concatTwo(a, b, outPath, withAudio) {
  const listPath = `${outPath}.txt`;
  fs.writeFileSync(listPath, [
    `file '${String(a).replace(/'/g, "'\\''")}'`,
    `file '${String(b).replace(/'/g, "'\\''")}'`,
  ].join('\n'));
  const args = [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-fflags', '+genpts', '-avoid_negative_ts', 'make_zero',
    ...ffmpegEncodeArgs(true),
    '-pix_fmt', 'yuv420p',
  ];
  if (withAudio) {
    args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', '-y', outPath);
  await runFfmpeg(args, 'concat-two');
  try { fs.unlinkSync(listPath); } catch (_) { /* ignore */ }
  return outPath;
}

function resolvePaneLabels(compCreative) {
  const labels = compCreative?.layout?.paneLabels || {};
  return {
    top: String(labels.top || 'Age 7').slice(0, 24),
    bottom: String(labels.bottom || 'Age 16').slice(0, 24),
  };
}

/** Same relative spot in each half — default top-center of that pane. */
function resolvePaneLabelPlacement(compCreative) {
  const raw = String(
    compCreative?.layout?.paneLabelAnchor
    || compCreative?.layout?.paneLabels?.anchor
    || 'top',
  ).toLowerCase();
  const anchor = raw === 'bottom' ? 'bottom' : 'top';
  const inset = 40;
  const fontSize = 56;
  const textBlockH = fontSize + 28; // approx box padding
  let topY;
  let bottomY;
  if (anchor === 'bottom') {
    topY = HALF_H - inset - textBlockH;
    bottomY = (HALF_H * 2) - inset - textBlockH;
  } else {
    topY = inset;
    bottomY = HALF_H + inset;
  }
  return {
    anchor,
    fontSize,
    topY: Math.max(8, Math.round(topY)),
    bottomY: Math.max(HALF_H + 8, Math.round(bottomY)),
  };
}

function buildDualPaneLabelFilter(compCreative) {
  const labels = resolvePaneLabels(compCreative);
  const place = resolvePaneLabelPlacement(compCreative);
  const topLabel = escapeDrawtext(labels.top);
  const botLabel = escapeDrawtext(labels.bottom);
  const fs = place.fontSize;
  // Shared style: centered, bold, dark pill — identical placement within each pane.
  const style =
    `fontsize=${fs}:fontcolor=white:borderw=4:bordercolor=black@0.9:`
    + `box=1:boxcolor=black@0.72:boxborderw=14`;
  return (
    `[0:v][1:v]vstack=inputs=2[vs];`
    + `[vs]drawtext=text='${topLabel}':${style}:x=(w-text_w)/2:y=${place.topY},`
    + `drawtext=text='${botLabel}':${style}:x=(w-text_w)/2:y=${place.bottomY}[vout]`
  );
}

/**
 * Assemble dual-source hold/switch stack → single 1080×1920 mp4.
 */
async function assembleDualSourceStack({
  clipFiles,
  clipMetas = [],
  compCreative,
  asmId,
  tmpDir,
  log = () => {},
}) {
  if (!Array.isArray(clipFiles) || clipFiles.length !== 2) {
    throw new Error('dual_source_stack requires exactly 2 clips (top, bottom)');
  }
  const topPath = clipFiles[0];
  const bottomPath = clipFiles[1];
  if (!fs.existsSync(topPath) || !fs.existsSync(bottomPath)) {
    throw new Error('dual_source_stack: missing source file(s)');
  }

  const topMeta = clipMetas[0] || {};
  const bottomMeta = clipMetas[1] || {};
  const topFileDur = await probeDurationSec(topPath);
  const bottomFileDur = await probeDurationSec(bottomPath);
  const topWin = resolveTrimWindow(topMeta, topFileDur);
  const bottomWin = resolveTrimWindow(bottomMeta, bottomFileDur);

  const layout = compCreative?.layout || {};
  let switchSec = layout.switchAtSec != null ? Number(layout.switchAtSec) : null;
  if (!Number.isFinite(switchSec) || switchSec <= 0) {
    switchSec = topWin.playDur; // Mark Out / trim length of top clip
  }
  switchSec = Math.max(0.5, Math.min(switchSec, topWin.playDur));
  const bottomPlay = Math.max(0.5, bottomWin.playDur);
  const totalDur = switchSec + bottomPlay;

  log(`  📐 dual_source_stack: top plays ${switchSec.toFixed(1)}s (hold bottom) → bottom plays ${bottomPlay.toFixed(1)}s (hold top) · total ${totalDur.toFixed(1)}s`);

  const topPlayPath = path.join(tmpDir, `${asmId}_dual_top_play.mp4`);
  const topTimelinePath = path.join(tmpDir, `${asmId}_dual_top_tl.mp4`);
  const bottomHoldPath = path.join(tmpDir, `${asmId}_dual_bot_hold.mp4`);
  const bottomPlayPath = path.join(tmpDir, `${asmId}_dual_bot_play.mp4`);
  const bottomTimelinePath = path.join(tmpDir, `${asmId}_dual_bot_tl.mp4`);
  const stackedPath = path.join(tmpDir, `${asmId}_dual_stacked.mp4`);
  const labeledPath = path.join(tmpDir, `${asmId}_dual_labeled.mp4`);

  await renderHalfClip({
    srcPath: topPath,
    seek: topWin.seek,
    durationSec: switchSec,
    outPath: topPlayPath,
    withAudio: true,
  });
  await extendWithLastFrameHold(topPlayPath, bottomPlay, topTimelinePath);

  await renderHalfHoldStill({
    srcPath: bottomPath,
    seek: bottomWin.seek,
    durationSec: switchSec,
    outPath: bottomHoldPath,
    tmpDir,
    asmId,
    tag: 'bot',
  });
  await renderHalfClip({
    srcPath: bottomPath,
    seek: bottomWin.seek,
    durationSec: bottomPlay,
    outPath: bottomPlayPath,
    withAudio: true,
  });
  // Video-only concat for bottom timeline (hold has no audio track — avoid concat demuxer mismatch).
  await concatTwo(bottomHoldPath, bottomPlayPath, bottomTimelinePath, false);

  // Prefer audio from the already-rendered bottom half clip (guaranteed AAC when source had audio),
  // then fall back to extracting from the original bottom source.
  const bottomAudioPath = path.join(tmpDir, `${asmId}_dual_bot_a.m4a`);
  let hasBottomAudio = false;
  const audioCandidates = [
    { label: 'bottom-half-audio', args: ['-i', bottomPlayPath, '-vn', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-y', bottomAudioPath] },
    {
      label: 'bottom-source-audio',
      args: [
        '-ss', bottomWin.seek.toFixed(3),
        '-i', bottomPath,
        '-t', bottomPlay.toFixed(3),
        '-vn',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2',
        '-y', bottomAudioPath,
      ],
    },
  ];
  for (const cand of audioCandidates) {
    if (hasBottomAudio) break;
    try {
      await runFfmpeg(cand.args, cand.label);
      // Do not rely on probeDurationSec — docker-wrapped ffprobe can return 0 and skip the mix.
      const bytes = fs.existsSync(bottomAudioPath) ? fs.statSync(bottomAudioPath).size : 0;
      hasBottomAudio = bytes > 1000;
      if (hasBottomAudio) log(`  🔊 dual_source_stack bottom audio via ${cand.label} (${bytes} bytes)`);
    } catch (err) {
      log(`  ⚠️ dual_source_stack ${cand.label} failed: ${err.message || err}`);
      hasBottomAudio = false;
    }
  }
  if (!hasBottomAudio) {
    log('  ⚠️ dual_source_stack: no bottom audio — phase 2 will be silent (TOP audio only)');
  }

  const delayMs = Math.round(switchSec * 1000);
  const labels = resolvePaneLabels(compCreative);
  const place = resolvePaneLabelPlacement(compCreative);
  const labelFilter = buildDualPaneLabelFilter(compCreative);
  log(`  🏷 dual_source_stack labels "${labels.top}" / "${labels.bottom}" · anchor=${place.anchor} (same place in each pane)`);

  if (hasBottomAudio) {
    await runFfmpeg([
      '-i', topTimelinePath,
      '-i', bottomTimelinePath,
      '-i', bottomAudioPath,
      '-filter_complex',
      `${labelFilter};`
      // Delay bottom to phase 2; keep full level (normalize=0). Top is silent after switch via apad.
      + `[2:a]aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[ba];`
      + `[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[ta];`
      + `[ta][ba]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`,
      '-map', '[vout]',
      '-map', '[aout]',
      ...ffmpegEncodeArgs(true),
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-t', totalDur.toFixed(3),
      '-movflags', '+faststart',
      '-y', labeledPath,
    ], 'vstack-mix');
  } else {
    await runFfmpeg([
      '-i', topTimelinePath,
      '-i', bottomTimelinePath,
      '-filter_complex', labelFilter,
      '-map', '[vout]',
      '-map', '0:a?',
      ...ffmpegEncodeArgs(true),
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-t', totalDur.toFixed(3),
      '-movflags', '+faststart',
      '-y', labeledPath,
    ], 'vstack');
  }

  if (!fs.existsSync(labeledPath)) {
    throw new Error('dual_source_stack produced no output');
  }
  // Keep stackedPath alias for callers that expect a stable name
  fs.copyFileSync(labeledPath, stackedPath);
  log(`  ✅ dual_source_stack ready (${totalDur.toFixed(1)}s) · labels "${labels.top}" / "${labels.bottom}" · bottomAudio=${hasBottomAudio}`);
  return {
    outputPath: labeledPath,
    switchSec,
    bottomPlaySec: bottomPlay,
    totalDur,
    paneLabels: labels,
    hasBottomAudio,
  };
}

/**
 * Reject picker placeholder names that poison GPT into "Local import Twitch…" SEO.
 */
function isGarbageImportTalentName(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (/^local:\/\//i.test(s)) return true;
  if (/^(local\s*import|yt_?paste|cwn_import)/i.test(s)) return true;
  if (/^youtube\s*import\b/i.test(s)) return true;
  if (/^reel[_-]/i.test(s)) return true;
  if (/^[0-9a-f]{8,}(\.mp4)?$/i.test(s)) return true;
  return false;
}

async function fetchYoutubeOembedMeta(pageUrl) {
  const u = String(pageUrl || '');
  if (!/youtube\.com|youtu\.be/i.test(u)) return null;
  try {
    const axios = require('axios');
    const { data } = await axios.get('https://www.youtube.com/oembed', {
      params: { url: u, format: 'json' },
      timeout: 8000,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const title = String(data?.title || '').replace(/\s*#Shorts\s*$/i, '').trim();
    const author = String(data?.author_name || '').trim();
    if (!title && !author) return null;
    return { title, author };
  } catch (_) {
    return null;
  }
}

/**
 * Whisper-only C11 skips Hook Machine — rebuild SEO brief from Age labels + real source titles
 * (YouTube oEmbed when possible). Never use Local import / yt_paste as talent.
 */
async function enrichDualSourceSeoBrief(card) {
  if (!card || !isDualSourceStackMode(card.compCreative || { preset: card.compCreativePreset })) {
    return card?.clipCompBrief || null;
  }
  const labels = resolvePaneLabels(card.compCreative || {});
  const clips = Array.isArray(card.orderedClipUrls) ? card.orderedClipUrls : [];
  const { detectUrlPlatform } = require('./publish_seo_context');

  const briefClips = [];
  for (let i = 0; i < Math.max(clips.length, 2); i += 1) {
    const clip = clips[i] || {};
    const label = i === 0 ? labels.top : labels.bottom;
    const pageUrl = clip.pageUrl || clip.url || '';
    let platform = String(clip.platform || '').toLowerCase()
      || detectUrlPlatform(pageUrl)
      || detectUrlPlatform(clip.mp4Url || '')
      || (/youtube\s*import/i.test(String(clip.title || '')) ? 'youtube' : '')
      || (clip.game === 'import' || /^local:\/\//i.test(pageUrl) ? 'import' : 'unknown');

    let sourceTitle = String(clip.title || clip.clipTitle || '').trim();
    let sourceAuthor = '';
    if (platform === 'youtube' || /youtube\.com|youtu\.be/i.test(pageUrl)) {
      platform = 'youtube';
      const oembed = await fetchYoutubeOembedMeta(pageUrl);
      if (oembed?.title) sourceTitle = oembed.title;
      if (oembed?.author) sourceAuthor = oembed.author;
    }
    if (isGarbageImportTalentName(sourceTitle) || /^youtube\s*import\b/i.test(sourceTitle)) {
      sourceTitle = sourceAuthor || label;
    }

    briefClips.push({
      index: i,
      streamer: label,
      displayName: label,
      platformTitle: sourceTitle,
      platform,
      sourceAuthor: sourceAuthor || null,
      observation:
        `Then/Now pane labeled "${label}". Real source: "${sourceTitle}"${sourceAuthor ? ` (channel ${sourceAuthor})` : ''}. `
        + `9:16 stack compares ${labels.top} (TOP) vs ${labels.bottom} (BOTTOM). `
        + 'NOT a Twitch highlight, NOT a streamer named Local import or yt_paste.',
      hook: label,
    });
  }

  const ytClip = briefClips.find((c) => c.platform === 'youtube' && c.platformTitle);
  const leadDraft = ytClip
    ? `${labels.top} vs ${labels.bottom}: ${String(ytClip.platformTitle).slice(0, 55)}`
    : `${labels.top} vs ${labels.bottom} — Then vs Now`;

  card.clipCompBrief = {
    ...(card.clipCompBrief || {}),
    clipCount: briefClips.length,
    isComp: true,
    leadClipIndex: 0,
    leadStreamer: `${labels.top} vs ${labels.bottom}`,
    sourceChannel: ytClip?.sourceAuthor || null,
    leadTitleDraft: leadDraft,
    leadReason: 'C11 dual_source_stack Then/Now — Age labels + real source titles (not Local import)',
    dualSourceStack: true,
    sourceVideoPreferred: true,
    clips: briefClips,
    generatedAt: new Date().toISOString(),
  };
  // Empty streamers for C11 — channel lives on brief.sourceChannel only.
  // Putting oEmbed author in streamers made titles "neneroyalmoments: …".
  card.streamers = [];
  return card.clipCompBrief;
}

module.exports = {
  isDualSourceStackMode,
  assembleDualSourceStack,
  resolveTrimWindow,
  resolvePaneLabels,
  resolvePaneLabelPlacement,
  buildDualPaneLabelFilter,
  enrichDualSourceSeoBrief,
  isGarbageImportTalentName,
  escapeDrawtext,
};
