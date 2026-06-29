'use strict';

/**
 * Talk Soup studio audience laugh — injected after each *_REACTION avatar segment.
 * Laugh clips are extracted from the same YouTube reference episodes used for TEACH.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { STUDIO_LAUGH_MARKER } = require('./heygen_script');

const FOLLOW_LINE_RE = /\n\s*Follow\s+.+?\.\s*Link in description\.?\s*$/i;

/**
 * Inject [studio laugh] pauses into Twitch Soup *_REACTION scene text.
 * - Last-clip reactions (with Follow line): reaction → [studio laugh] → Follow CTA
 * - Earlier reactions: reaction → [studio laugh] at end
 */
function injectStudioLaughPausesInScript(script, opts = {}) {
  const marker = opts.marker || STUDIO_LAUGH_MARKER;
  if (!script || typeof script !== 'string') return script;

  return script.replace(
    /===\s*([A-Z0-9_]+)\s*===\s*([\s\S]*?)(?====\s*[A-Z0-9_]+\s*===|$)/g,
    (full, sceneName, body) => {
      if (!/_REACTION$/i.test(sceneName)) return full;
      const injected = injectStudioLaughPauseInReactionText(body.trim(), { marker });
      return `=== ${sceneName} ===\n${injected}\n\n`;
    }
  );
}

function injectStudioLaughPauseInReactionText(text, opts = {}) {
  const marker = opts.marker || STUDIO_LAUGH_MARKER;
  let body = String(text || '').trim();
  if (!body) return body;
  if (/\[studio\s+laugh\]/i.test(body)) return body;

  const followMatch = body.match(FOLLOW_LINE_RE);
  if (followMatch) {
    const followLine = followMatch[0].trim();
    let reactionPart = body.slice(0, followMatch.index).trim();
    reactionPart = reactionPart.replace(/\n?\[beat\]\s*$/i, '').trim();
    return `${reactionPart}\n${marker}\n${followLine}`;
  }

  return `${body.replace(/\n?\[beat\]\s*$/i, '').trim()}\n${marker}`;
}

const REPO_ROOT = path.join(__dirname, '..');
const LAUGH_LIBRARY_DIR = path.join(REPO_ROOT, 'assets', 'audio', 'studio_laugh');
const OPERATOR_DIR = path.join(LAUGH_LIBRARY_DIR, 'operator');
const OPERATOR_SEGMENT_DIR = path.join(OPERATOR_DIR, 'segment_laughs');
const OPENING_CROWD_BED_NAMES = ['opening_crowd_bed.mp3', 'opening_crowd_bed.m4a', 'opening_crowd_bed.wav'];
const OPENING_MUSIC_BED_NAMES = ['opening_music_bed.mp3', 'opening_music_bed.m4a', 'opening_music_bed.wav'];
const LAUGH_MANIFEST_PATH = path.join(LAUGH_LIBRARY_DIR, 'manifest.json');
const DEFAULT_LAUGH_MP3 = path.join(REPO_ROOT, 'assets', 'audio', 'studio_laugh.mp3');
const PROD_LAUGH_MP3 = path.join(REPO_ROOT, '..', 'cwn-production', 'assets', 'audio', 'studio_laugh.mp3');

/** Same 4 Soup episodes as dashboard TEACH → Twitch reference library */
const DEFAULT_TEACH_TWITCH_URLS = [
  'https://www.youtube.com/watch?v=OzAQctMP53Q',
  'https://www.youtube.com/watch?v=ZopeSp8fK-0',
  'https://www.youtube.com/watch?v=XUl-BynnmCc',
  'https://www.youtube.com/watch?v=yXIWkk-p9mo'
];

function getStudioLaughConfig(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./customerConfig');
    const cfg = loadCustomerConfig(customerId, 'long-form');
    return cfg?.designDefaults?.audio?.studioLaugh || null;
  } catch (_e) {
    return null;
  }
}

function getTeachReferenceUrls(customerId = 'c0') {
  const cfg = getStudioLaughConfig(customerId) || {};
  const urls = cfg.referenceUrls || cfg.teachUrls || DEFAULT_TEACH_TWITCH_URLS;
  return (Array.isArray(urls) ? urls : []).filter(u => u && String(u).startsWith('http'));
}

function isStudioLaughEnabled(customerId = 'c0') {
  const cfg = getStudioLaughConfig(customerId);
  return cfg?.enabled !== false;
}

function readLaughManifest() {
  try {
    if (!fs.existsSync(LAUGH_MANIFEST_PATH)) return null;
    return JSON.parse(fs.readFileSync(LAUGH_MANIFEST_PATH, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function listOperatorLaughClips() {
  fs.mkdirSync(OPERATOR_SEGMENT_DIR, { recursive: true });
  const dirs = [OPERATOR_SEGMENT_DIR, OPERATOR_DIR];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp3|m4a|wav|aac)$/i.test(f)) continue;
      if (/^opening_(crowd_bed|music_bed)/i.test(f)) continue;
      const fp = path.join(dir, f);
      if (out.some((x) => x.path === fp)) continue;
      out.push({ file: f, path: fp, source: 'operator', qaPass: true });
    }
  }
  return out;
}

function resolveOpeningCrowdBedPath(cfg = {}) {
  if (cfg.crowdBedFile) {
    const custom = path.isAbsolute(cfg.crowdBedFile)
      ? cfg.crowdBedFile
      : path.join(LAUGH_LIBRARY_DIR, cfg.crowdBedFile);
    if (fs.existsSync(custom)) return custom;
  }
  for (const name of OPENING_CROWD_BED_NAMES) {
    const fp = path.join(OPERATOR_DIR, name);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

/** Operator cold-open music bed (e.g. Forsaken) — plays only inside cold open MP4, hard cut before Bobby G INTRO. */
function resolveOpeningMusicBedPath(cfg = {}) {
  if (cfg.musicBedFile) {
    const custom = path.isAbsolute(cfg.musicBedFile)
      ? cfg.musicBedFile
      : path.join(LAUGH_LIBRARY_DIR, cfg.musicBedFile);
    if (fs.existsSync(custom)) return custom;
  }
  for (const name of OPENING_MUSIC_BED_NAMES) {
    const fp = path.join(OPERATOR_DIR, name);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

function listLaughLibraryClips({ includeUnqa = false } = {}) {
  const operator = listOperatorLaughClips();
  if (operator.length) return operator;

  const manifest = readLaughManifest();
  const usable = [];
  if (manifest?.operatorClips?.length) {
    for (const c of manifest.operatorClips) {
      const fp = c.path || path.join(OPERATOR_SEGMENT_DIR, c.file);
      if (fs.existsSync(fp)) usable.push({ ...c, path: fp, qaPass: true });
    }
    if (usable.length) return usable;
  }
  if (manifest?.clips?.length) {
    for (const c of manifest.clips) {
      if (!c.file) continue;
      const fp = path.join(LAUGH_LIBRARY_DIR, c.file);
      if (!fs.existsSync(fp)) continue;
      if (!includeUnqa && c.qaPass !== true) continue;
      usable.push({ ...c, path: fp });
    }
    if (usable.length) return usable;
  }
  return [];
}

function resolveLaughAudioPath(pickIndex = 0) {
  const clips = listLaughLibraryClips();
  if (clips.length) {
    const idx = Math.abs(pickIndex) % clips.length;
    return clips[idx].path || path.join(LAUGH_LIBRARY_DIR, clips[idx].file);
  }
  if (fs.existsSync(DEFAULT_LAUGH_MP3) && fs.statSync(DEFAULT_LAUGH_MP3).size > 1000) {
    return DEFAULT_LAUGH_MP3;
  }
  if (fs.existsSync(PROD_LAUGH_MP3) && fs.statSync(PROD_LAUGH_MP3).size > 1000) {
    return PROD_LAUGH_MP3;
  }
  return null;
}

async function probeDuration(filePath) {
  const { ffprobePath } = require('./ffmpeg_utils');
  const { stdout } = await execFileAsync(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filePath
  ]);
  const n = parseFloat(String(stdout).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function youtubeIdFromUrl(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : 'ref';
}

function parseSilenceDetectLog(stderr) {
  const starts = [...String(stderr).matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...String(stderr).matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const silences = [];
  for (let i = 0; i < starts.length; i++) {
    if (Number.isFinite(starts[i]) && Number.isFinite(ends[i])) {
      silences.push({ start: starts[i], end: ends[i] });
    }
  }
  return silences;
}

/** Sound bursts between consecutive silences — studio audience laughs on Soup sit in these gaps. */
function findLaughCandidates(silences, totalDuration, opts = {}) {
  const skipIntroSec = Number(opts.skipIntroSec) || 35;
  const minDur = Number(opts.minDurationSec) || 0.75;
  const maxDur = Number(opts.maxDurationSec) || 4.5;
  const candidates = [];
  const sorted = [...silences].sort((a, b) => a.start - b.start);

  for (let i = 0; i < sorted.length - 1; i++) {
    const preSilence = sorted[i];
    const laughStart = preSilence.end;
    const laughEnd = sorted[i + 1].start;
    const dur = laughEnd - laughStart;
    const preSilenceDur = preSilence.end - preSilence.start;

    if (laughStart < skipIntroSec) continue;
    if (dur < minDur || dur > maxDur) continue;

    candidates.push({
      start: laughStart,
      duration: dur,
      score: scoreLaughSegment(dur, preSilenceDur)
    });
  }

  // Trailing sound after last silence (rare — usually outro)
  if (sorted.length) {
    const last = sorted[sorted.length - 1];
    const dur = totalDuration - last.end;
    if (last.end >= skipIntroSec && dur >= minDur && dur <= maxDur) {
      candidates.push({
        start: last.end,
        duration: dur,
        score: scoreLaughSegment(dur, 0)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function scoreLaughSegment(duration, preSilenceDur = 0) {
  let score = 0;
  if (duration >= 0.9 && duration <= 3.8) score += 10;
  if (duration >= 1.2 && duration <= 2.8) score += 8;
  if (duration >= 0.75 && duration < 0.9) score += 3;
  if (duration > 3.8) score -= 3;
  // Soup pattern: brief host pause then crowd burst
  if (preSilenceDur >= 0.15 && preSilenceDur <= 1.2) score += 5;
  return score;
}

async function downloadReferenceAudio(url, destPath) {
  await execFileAsync('yt-dlp', [
    '--quiet', '--no-warnings', '-f', 'bestaudio/best',
    '-o', destPath, '--no-playlist', url
  ], { timeout: 180000 });
}

async function runSilenceDetect(audioPath) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), [
      '-i', audioPath,
      '-af', 'silencedetect=noise=-32dB:d=0.14',
      '-f', 'null', '-'
    ], { maxBuffer: 20 * 1024 * 1024 }, (_err, _stdout, stderr) => {
      resolve(String(stderr || ''));
    });
  });
}

async function detectLaughCandidatesInFile(audioPath, opts = {}) {
  const totalDuration = await probeDuration(audioPath);
  if (!totalDuration) return [];

  const stderr = await runSilenceDetect(audioPath);
  const silences = parseSilenceDetectLog(stderr);
  return findLaughCandidates(silences, totalDuration, opts);
}

async function extractLaughClip(sourceAudio, startSec, durationSec, outPath, fadeSec = 0.12) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  const fadeOutStart = Math.max(0, durationSec - 0.28);
  await execFileAsync(ffmpegPath(), [
    '-y', '-ss', String(startSec), '-t', String(durationSec),
    '-i', sourceAudio,
    '-af', `afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fadeOutStart}:d=0.28`,
    outPath
  ], { timeout: 60000 });
}

/**
 * Pull audience laugh clips from all TEACH Soup reference URLs.
 */
async function buildLaughLibraryFromReferences(urls, opts = {}) {
  fs.mkdirSync(LAUGH_LIBRARY_DIR, { recursive: true });

  const maxPerVideo = Number(opts.maxClipsPerVideo) || 6;
  const minPerVideo = Number(opts.minClipsPerVideo) || 2;
  const allClips = [];
  const errors = {};

  for (const url of urls) {
    const vid = youtubeIdFromUrl(url);
    const tmpAudio = path.join(LAUGH_LIBRARY_DIR, `_src_${vid}.m4a`);
    try {
      console.log(`[studio-laugh] Downloading Soup ref: ${url}`);
      await downloadReferenceAudio(url, tmpAudio);

      const candidates = await detectLaughCandidatesInFile(tmpAudio, opts);
      const picked = [];
      for (const cand of candidates) {
        if (picked.some(p => Math.abs(p.start - cand.start) < 10)) continue;
        picked.push(cand);
        if (picked.length >= maxPerVideo) break;
      }
      if (picked.length < minPerVideo) {
        console.warn(`[studio-laugh] Only ${picked.length} laugh candidates for ${vid} — using what we found`);
      }

      let clipNum = 0;
      for (const cand of picked) {
        clipNum++;
        const fileName = `laugh_${vid}_${String(clipNum).padStart(2, '0')}.mp3`;
        const outPath = path.join(LAUGH_LIBRARY_DIR, fileName);
        await extractLaughClip(tmpAudio, cand.start, cand.duration, outPath);
        const dur = await probeDuration(outPath);
        if (!dur || dur < 0.5) continue;
        allClips.push({
          file: fileName,
          sourceUrl: url,
          sourceVideoId: vid,
          startSec: Math.round(cand.start * 100) / 100,
          durationSec: Math.round(dur * 100) / 100,
          score: cand.score
        });
        console.log(`[studio-laugh]   ✓ ${fileName} @ ${cand.start.toFixed(1)}s (${dur.toFixed(2)}s)`);
      }
    } catch (e) {
      errors[url] = e.message;
      console.warn(`[studio-laugh] Failed ${url}: ${e.message}`);
    } finally {
      try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch (_e) { /* non-fatal */ }
    }
  }

  // Remove stale clips not in this run
  const keepFiles = new Set(allClips.map(c => c.file));
  if (fs.existsSync(LAUGH_LIBRARY_DIR)) {
    for (const f of fs.readdirSync(LAUGH_LIBRARY_DIR)) {
      if (f.startsWith('_src_')) continue;
      if (f.endsWith('.mp3') && !keepFiles.has(f)) {
        try { fs.unlinkSync(path.join(LAUGH_LIBRARY_DIR, f)); } catch (_e) { /* non-fatal */ }
      }
    }
  }

  const manifest = {
    builtAt: new Date().toISOString(),
    source: 'teach_soup_references',
    referenceUrls: urls,
    clipCount: allClips.length,
    clips: allClips
  };
  fs.writeFileSync(LAUGH_MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  // Legacy single-file fallback for tools expecting studio_laugh.mp3
  if (allClips.length) {
    fs.copyFileSync(path.join(LAUGH_LIBRARY_DIR, allClips[0].file), DEFAULT_LAUGH_MP3);
  }

  console.log(`[studio-laugh] ✅ Library: ${allClips.length} clips from ${urls.length} Soup episodes`);
  return { ok: allClips.length > 0, clipCount: allClips.length, clips: allClips, errors, manifestPath: LAUGH_MANIFEST_PATH };
}

async function ensureLaughLibrary(customerId = 'c0', opts = {}) {
  const clips = listLaughLibraryClips();
  if (clips.length && !opts.forceRebuild) {
    return { ok: true, clipCount: clips.length, rebuilt: false };
  }
  const urls = getTeachReferenceUrls(customerId);
  if (!urls.length) {
    throw new Error('No TEACH reference URLs configured for studio laugh extraction');
  }
  const cfg = getStudioLaughConfig(customerId) || {};
  return {
    ...(await buildLaughLibraryFromReferences(urls, {
      maxClipsPerVideo: cfg.maxClipsPerVideo || 6,
      minClipsPerVideo: cfg.minClipsPerVideo || 2,
      ...opts
    })),
    rebuilt: true
  };
}

/**
 * Resolve a laugh clip — rotates through library so reactions don't repeat the same burst.
 */
async function ensureStudioLaughAudio(customerId = 'c0', pickIndex = 0) {
  let clipPath = resolveLaughAudioPath(pickIndex);
  if (clipPath) return clipPath;

  await ensureLaughLibrary(customerId);
  clipPath = resolveLaughAudioPath(pickIndex);
  if (!clipPath) {
    throw new Error(
      'Studio laugh library empty — drop MP3s in assets/audio/studio_laugh/operator/segment_laughs/ '
      + 'or run POST /studio-laugh/qa-library after extract'
    );
  }
  return clipPath;
}

function injectStudioLaughterSegments(segmentData, contentType, opts = {}) {
  const customerId = opts.customerId || 'c0';
  if (contentType !== 'twitch' || !Array.isArray(segmentData)) return segmentData;
  if (!isStudioLaughEnabled(customerId)) return segmentData;

  const filtered = segmentData.filter((s) => s.type !== 'studio_laughter');
  segmentData.length = 0;
  segmentData.push(...filtered);

  let laughIdx = 0;
  for (const seg of segmentData) {
    const label = seg.label || '';
    if (seg.type === 'avatar' && /_REACTION$/i.test(label)) {
      seg.studioLaughAfter = true;
      seg.laughPickIndex = laughIdx++;
    }
  }
  return segmentData;
}

/**
 * Crowd laugh hold clip — frozen last frame of reaction + operator crowd audio only.
 * Prefer mixCrowdLaughOnReaction for Talk Soup (no concat demuxer drift).
 */
async function buildCrowdHoldClip(holdVideoPath, outputPath, laughAudioPath, opts = {}) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  const maxDur = Number(opts.maxDurationSec) || 4.5;
  const volume = Number(opts.volume) || 0.85;
  const skipTrim = opts.skipTrimLaugh ?? isOperatorLaughPath(laughAudioPath);

  const trimmedLaugh = outputPath.replace(/\.mp4$/i, '_laugh.aac');
  const laughSource = skipTrim ? laughAudioPath : trimmedLaugh;
  if (!skipTrim) {
    await trimLaughAudio(laughAudioPath, trimmedLaugh);
  }
  let laughDur = (await probeDuration(laughSource)) || (await probeDuration(laughAudioPath)) || 2.5;
  laughDur = Math.min(maxDur, Math.max(0.6, laughDur));
  const segDur = laughDur + 0.05;

  const stillPath = outputPath.replace(/\.mp4$/i, '_still.jpg');
  await extractHoldStillFrame(holdVideoPath, stillPath);

  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,`,
    `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,`,
    `fps=30,trim=duration=${segDur.toFixed(3)},setpts=PTS-STARTPTS[v];`,
    `[1:a]volume=${volume},afade=t=in:st=0:d=0.05,`,
    `afade=t=out:st=${Math.max(0, laughDur - 0.25)}:d=0.25[a]`,
  ].join('');

  await execFileAsync(ffmpegPath(), [
    '-y', '-loop', '1', '-framerate', '30', '-i', stillPath,
    '-i', laughSource,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-t', String(segDur),
    '-movflags', '+faststart',
    outputPath,
  ], { timeout: 120000 });

  try { fs.unlinkSync(stillPath); } catch (_) {}
  if (!skipTrim) {
    try { fs.unlinkSync(trimmedLaugh); } catch (_) {}
  }
  return { outputPath, laughDur: segDur };
}

function isOperatorLaughPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  return norm.includes('/operator/') || norm.includes('/segment_laughs/');
}

/**
 * Find the HeyGen <break> pause window in a rendered reaction (silence gap in audio).
 */
async function detectHeyGenPauseWindow(mediaPath, opts = {}) {
  const minPause = Number(opts.minPauseSec) || 2.2;
  const maxPause = Number(opts.maxPauseSec) || 5.5;
  const targetPause = Number(opts.targetPauseSec) || 4;
  const totalDuration = await probeDuration(mediaPath);
  if (!totalDuration) return null;

  const stderr = await runSilenceDetect(mediaPath);
  const silences = parseSilenceDetectLog(stderr);
  const gaps = silences
    .map((s) => ({
      start: s.start,
      end: s.end,
      duration: s.end - s.start,
      hasSpeechAfter: s.end < totalDuration - 0.6,
    }))
    .filter((g) => g.duration >= minPause && g.duration <= maxPause);

  if (!gaps.length) return null;

  gaps.sort((a, b) => {
    if (a.hasSpeechAfter !== b.hasSpeechAfter) return a.hasSpeechAfter ? -1 : 1;
    return Math.abs(a.duration - targetPause) - Math.abs(b.duration - targetPause);
  });
  return gaps[0];
}

/**
 * Mix operator crowd laugh onto a reaction scene — audio only, video stream copy.
 * Crowd plays during the HeyGen script pause window ([studio laugh] → <break time="4s"/>).
 * Skips mix when no pause window is detected (old renders without script pause).
 */
async function mixCrowdLaughOnReaction(reactionMp4, opts = {}) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  const { probeMp4DecodeIntegrity } = require('./ffmpeg_utils');
  const customerId = opts.customerId || 'c0';
  const laughCfg = getStudioLaughConfig(customerId) || {};
  const maxDur = Number(opts.maxDurationSec) || laughCfg.maxDurationSec || 4.8;
  const volume = Number(opts.volume) || laughCfg.volume || 0.85;
  const pauseSec = Number(opts.reactionPauseSec ?? laughCfg.reactionPauseSec) || 4;

  const laughAudio = opts.laughAudioPath
    || await ensureStudioLaughAudio(customerId, opts.laughPickIndex ?? 0);
  const outPath = opts.outputPath || reactionMp4.replace(/\.mp4$/i, '_with_crowd.mp4');

  const pauseWindow = await detectHeyGenPauseWindow(reactionMp4, { targetPauseSec: pauseSec });
  if (!pauseWindow) {
    if (opts.log) opts.log('No HeyGen pause window — skip crowd mix (re-render reaction with [studio laugh] in script)');
    return reactionMp4;
  }

  const isClip2Reaction = /_CLIP2_REACTION$/i.test(String(opts.sceneLabel || ''));
  const segDur = (await probeDuration(reactionMp4)) || null;

  const rawLaughDur = (await probeDuration(laughAudio)) || 2.5;
  const laughDur = Math.min(maxDur, Math.max(0.5, rawLaughDur), pauseWindow.duration + 0.15);
  const crowdStartSec = pauseWindow.start;
  const crowdEndSec = crowdStartSec + laughDur;
  const crowdDelayMs = Math.round(crowdStartSec * 1000);
  const fadeInSec = 0.12;
  const fadeOutSec = isClip2Reaction ? 0.55 : 0.45;
  const fadeOutStart = Math.max(0, laughDur - fadeOutSec);

  const crowdChain = [
    `[1:a]volume=${volume}`,
    `atrim=0:${laughDur.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `afade=t=in:st=0:d=${fadeInSec}`,
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutSec}`,
    `adelay=${crowdDelayMs}|${crowdDelayMs}[crowd]`,
  ].join(',');
  const duckEnd = crowdEndSec + (isClip2Reaction ? 0.35 : 0.08);
  let filter = [
    crowdChain,
    `[0:a]volume=volume='if(between(t,${crowdStartSec.toFixed(3)},${duckEnd.toFixed(3)}),0.12,1)':eval=frame[base]`,
    '[base][crowd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]',
  ].join(';');
  if (isClip2Reaction && segDur && segDur > 1) {
    const tailFade = 0.45;
    const tailSt = Math.max(0, segDur - tailFade);
    filter = `${filter};[aout]afade=t=out:st=${tailSt.toFixed(3)}:d=${tailFade.toFixed(3)}[aout2]`;
  }
  const audioMap = isClip2Reaction && segDur && segDur > 1 ? '[aout2]' : '[aout]';

  await execFileAsync(ffmpegPath(), [
    '-y', '-i', reactionMp4, '-i', laughAudio,
    '-filter_complex', filter,
    '-map', '0:v', '-map', audioMap,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ], { timeout: 180000 });

  const integrity = await probeMp4DecodeIntegrity(outPath);
  if (!integrity.ok) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    throw new Error(`Reaction+crowd mix failed decode QA: ${integrity.errors.join('; ')}`);
  }
  if (opts.log) {
    opts.log(`Crowd mixed in HeyGen pause (${path.basename(outPath)}, ${crowdStartSec.toFixed(2)}s–${(crowdStartSec + laughDur).toFixed(2)}s)`);
  }
  return outPath;
}

/**
 * Append crowd laugh on the reaction scene — delegates to mixCrowdLaughOnReaction.
 * Replaces separate LAUGHTER stitch segments (Talk Soup pause beat).
 */
async function appendStudioLaughTailToReaction(reactionMp4, opts = {}) {
  return mixCrowdLaughOnReaction(reactionMp4, opts);
}

async function trimLaughAudio(inPath, outPath) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', inPath,
    '-af', 'silenceremove=start_periods=1:start_silence=0.02:start_threshold=-38dB:stop_periods=1:stop_silence=0.04:stop_threshold=-38dB',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    outPath,
  ], { timeout: 60000 });
}

async function extractHoldStillFrame(holdVideoPath, stillPath) {
  const { ffmpegPath } = require('./ffmpeg_utils');
  try {
    await execFileAsync(ffmpegPath(), [
      '-y', '-sseof', '-0.05', '-i', holdVideoPath,
      '-vframes', '1', '-q:v', '2', stillPath,
    ], { timeout: 60000 });
    return;
  } catch (_) { /* fall through */ }
  const dur = (await probeDuration(holdVideoPath)) || 1;
  const ss = Math.max(0, dur - 0.15);
  await execFileAsync(ffmpegPath(), [
    '-y', '-ss', String(ss), '-i', holdVideoPath,
    '-vframes', '1', '-q:v', '2', stillPath,
  ], { timeout: 60000 });
}

async function buildStudioLaughSegment(holdVideoPath, outputPath, laughAudioPath, opts = {}) {
  const { probeMp4DecodeIntegrity } = require('./ffmpeg_utils');
  await buildCrowdHoldClip(holdVideoPath, outputPath, laughAudioPath, opts);
  const integrity = await probeMp4DecodeIntegrity(outputPath);
  if (!integrity.ok) {
    try { fs.unlinkSync(outputPath); } catch (_) {}
    throw new Error(`Studio laugh segment failed decode QA: ${integrity.errors.join('; ')}`);
  }
  return outputPath;
}

module.exports = {
  REPO_ROOT,
  LAUGH_LIBRARY_DIR,
  OPERATOR_DIR,
  OPERATOR_SEGMENT_DIR,
  LAUGH_MANIFEST_PATH,
  DEFAULT_TEACH_TWITCH_URLS,
  getStudioLaughConfig,
  getTeachReferenceUrls,
  isStudioLaughEnabled,
  readLaughManifest,
  listOperatorLaughClips,
  listLaughLibraryClips,
  resolveOpeningCrowdBedPath,
  resolveOpeningMusicBedPath,
  resolveLaughAudioPath,
  ensureStudioLaughAudio,
  ensureLaughLibrary,
  buildLaughLibraryFromReferences,
  injectStudioLaughterSegments,
  injectStudioLaughPausesInScript,
  injectStudioLaughPauseInReactionText,
  detectHeyGenPauseWindow,
  buildCrowdHoldClip,
  mixCrowdLaughOnReaction,
  appendStudioLaughTailToReaction,
  buildStudioLaughSegment,
  trimLaughAudio,
  probeDuration,
  detectLaughCandidatesInFile,
};
