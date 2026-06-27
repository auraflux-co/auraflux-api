'use strict';
/**
 * Twitch Soup cold open (~15s montage + ElevenLabs VO + music) and credits outro.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('./ffmpeg_utils');
const { resolveFallbackBedPath, listFallbackTracks, resolveMusicDir } = require('./live_grid/fallback_music');
const { synthesizeSpeech, probeDurationSec, resolveColdOpenVoiceId } = require('./clip_comp_tts');

const TMP = path.join(__dirname, '..', 'tmp', 'bookends');

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true });
}

function resolveTwitchBookendsDefaults(cfg) {
  const dd = cfg?.designDefaults || {};
  if (dd.twitchBookends) return dd.twitchBookends;
  if (dd.audio?.twitchBookends) return dd.audio.twitchBookends;
  for (const tpl of Object.values(cfg?.templates || {})) {
    const tdd = tpl?.designDefaults || {};
    if (tdd.twitchBookends) return tdd.twitchBookends;
    if (tdd.audio?.twitchBookends) return tdd.audio.twitchBookends;
  }
  return {};
}

function loadBookendsConfig(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./job_spec');
    const cfg = loadCustomerConfig(customerId);
    const defaults = resolveTwitchBookendsDefaults(cfg);
    return {
      coldOpen: {
        enabled: defaults.coldOpen?.enabled !== false,
        durationSec: Number(defaults.coldOpen?.durationSec) || 15,
        musicVolume: Number(defaults.coldOpen?.musicVolume) || 0.28,
        voVolume: Number(defaults.coldOpen?.voVolume) || 1.0,
        montageClipSec: Number(defaults.coldOpen?.montageClipSec) || 1.2,
        logoSec: Number(defaults.coldOpen?.logoSec) || 2,
        musicBedKey: defaults.coldOpen?.musicBedKey || null,
        announcerVoiceId: defaults.coldOpen?.announcerVoiceId || null,
      },
      outroCredits: {
        enabled: defaults.outroCredits?.enabled !== false,
        durationSec: Number(defaults.outroCredits?.durationSec) || 8,
        musicVolume: Number(defaults.outroCredits?.musicVolume) || 0.32,
        scroll: defaults.outroCredits?.scroll !== false,
        musicBedKey: defaults.outroCredits?.musicBedKey || null,
      },
    };
  } catch {
    return {
      coldOpen: { enabled: true, durationSec: 15, musicVolume: 0.28, voVolume: 1, montageClipSec: 1.2, logoSec: 2 },
      outroCredits: { enabled: true, durationSec: 8, musicVolume: 0.32, scroll: true },
    };
  }
}

function isBookendsEnabled(customerId = 'c0') {
  const cfg = loadBookendsConfig(customerId);
  return cfg.coldOpen.enabled || cfg.outroCredits.enabled;
}

function resolveMusicBed(bedKey) {
  const dir = resolveMusicDir();
  if (!dir) return null;
  const tracks = listFallbackTracks(dir);
  if (!tracks.length) return resolveFallbackBedPath();
  if (bedKey) {
    const match = tracks.find((t) => path.basename(t).toLowerCase().includes(String(bedKey).toLowerCase()));
    if (match) return match;
  }
  return resolveFallbackBedPath() || tracks[0];
}

function isUnspeakableClipTitle(t) {
  const s = String(t || '').trim();
  if (!s || s.length < 4) return true;
  const letters = s.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 4) return true;
  const upperRatio = (letters.match(/[A-Z]/g) || []).length / letters.length;
  if (upperRatio > 0.45) return true;
  if (/([A-Za-z])\1{2,}/.test(s)) return true;
  if (/!{2,}|BANG|HATTRICK|DEMBELE/i.test(s) && upperRatio > 0.25) return true;
  return false;
}

function stripClipTitle(title, streamer) {
  let t = String(title || '').trim();
  t = t.replace(/[\u{1F300}-\u{1FAFF}]/gu, '').trim();
  const sn = String(streamer || '').trim();
  if (sn && t.toLowerCase().startsWith(sn.toLowerCase())) {
    t = t.slice(sn.length).replace(/^[\s:—-]+/, '').trim();
  }
  return t || '';
}

function findStreamerEntry(card, displayName) {
  const dn = String(displayName || '').toLowerCase();
  return (card?.streamers || []).find((s) =>
    String(s.displayName || '').toLowerCase() === dn
    || String(s.twitchUsername || s.username || '').toLowerCase() === dn,
  ) || null;
}

function streamerSetupPrefixes(card, beat) {
  const entry = findStreamerEntry(card, beat.streamer);
  const out = new Set();
  if (entry?.twitchUsername) {
    out.add(String(entry.twitchUsername).replace(/\s+/g, '_'));
    out.add(String(entry.twitchUsername).replace(/\s+/g, ''));
  }
  out.add(String(beat.streamer).replace(/\s+/g, '_'));
  out.add(String(beat.streamer).replace(/\s+/g, ''));
  return [...out].filter(Boolean);
}

function extractSetupLine(raw, prefixes) {
  if (!raw || typeof raw !== 'string') return '';
  for (const prefix of prefixes) {
    const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `===\\s*${esc}[_ ]CLIP1_SETUP\\s*===\\s*([\\s\\S]*?)(?=\\n\\n===|$)`,
      'i',
    );
    const m = raw.match(re);
    if (m && m[1]) {
      return m[1]
        .replace(/\[CLIP PLAYS HERE\]/gi, '')
        .replace(/\[beat\]/gi, '')
        .replace(/LAY-see/gi, 'Lacy')
        .replace(/\([^)]*\)/g, '')
        .trim()
        .split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    }
  }
  return '';
}

/** Short speakable phrase from setup — full words only, no ellipsis. */
function distillSetupPhrase(setup, maxWords = 14) {
  if (!setup) return '';
  let s = setup.replace(/\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bHere he is,?\s*/i, '').replace(/\bjust like any normal person would\.?/i, '').trim();
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s.endsWith('.') ? s.slice(0, -1) : s;
  return `${words.slice(0, maxWords).join(' ')}`;
}

function sanitizeColdOpenScript(text) {
  return String(text || '')
    .replace(/LAY-see/gi, 'Lacy')
    .replace(/\s*—\s*/g, ', ')
    .replace(/…|\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

/** One preview beat per streamer — first clip in episode order. */
function collectColdOpenClipBeats(card) {
  const clips = card?.orderedClipUrls || [];
  const raw = card?.script?.raw || (typeof card?.script === 'string' ? card.script : '');
  const seen = new Set();
  const beats = [];

  for (const c of clips) {
    const streamer = c.displayName || c.streamer || 'Streamer';
    const key = String(c.streamer || streamer).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const prefixes = streamerSetupPrefixes(card, { streamer });
    const setup = extractSetupLine(raw, prefixes);
    const rawTitle = stripClipTitle(c.title, streamer);
    const titleOk = rawTitle && !isUnspeakableClipTitle(rawTitle);
    const setupPhrase = distillSetupPhrase(setup);

    beats.push({
      streamer,
      title: c.title || '',
      setup,
      setupPhrase,
      tease: setupPhrase || (titleOk ? rawTitle : 'has a moment worth seeing'),
      clipUrl: c.url || c.clipUrl || '',
    });
  }
  return beats.slice(0, 6);
}

/** Short Talk Soup phrase from episode SETUP — never raw clip titles. */
function coldOpenPhraseFromSetup(setup, streamer) {
  const s = String(setup || '').replace(/\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return `${streamer} has a clip you need to see`;

  if (/spelling bee/i.test(s)) {
    return `${streamer} watches a spelling bee go somewhere no one expected`;
  }
  if (/national pride|sports fan|stadium|enthusiasm to every game/i.test(s)) {
    return `${streamer} goes full stadium mode when Japan scores`;
  }
  if (/video call|casual chat|intimate moment/i.test(s)) {
    return `${streamer} keeps it together while Jason overshares on stream`;
  }
  if (/patriot|team|dressing the part/i.test(s)) {
    return `${streamer} rides for his team with zero chill`;
  }
  if (/new car|seatbelt/i.test(s)) {
    return `${streamer} treats a new car reveal like breaking news`;
  }

  let clause = s.split(/[.!?]/)[0].replace(new RegExp(`^${streamer}\\s+`, 'i'), '').trim();
  clause = clause.split(',')[0].trim();
  const words = clause.split(/\s+/).slice(0, 9).join(' ');
  return `${streamer} ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

function buildColdOpenScriptDraft(card) {
  const beats = collectColdOpenClipBeats(card);
  if (!beats.length) {
    return 'Tonight on Twitch Soup, the clips that broke chat and somehow still made the cut. Let\'s get into it.';
  }

  const phrases = beats.map((b) => coldOpenPhraseFromSetup(b.setup, b.streamer));
  return sanitizeColdOpenScript(`Tonight on Twitch Soup. ${phrases.join('. ')}. Let's get into it.`);
}

async function generateColdOpenScript(card) {
  const beats = collectColdOpenClipBeats(card);
  if (!beats.length) return buildColdOpenScriptDraft(card);

  const apiKey = process.env.GEMINI_APIKEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return buildColdOpenScriptDraft(card);

  const beatLines = beats.map((b) => {
    const lines = [`Streamer: ${b.streamer}`];
    if (b.setupPhrase) lines.push(`Episode tease (use this, do NOT use raw clip title): ${b.setupPhrase}`);
    if (b.setup && b.setup !== b.setupPhrase) lines.push(`Full setup: ${b.setup.slice(0, 160)}`);
    if (b.title && isUnspeakableClipTitle(b.title)) {
      lines.push(`Raw clip title (DO NOT speak verbatim — meme/shout text): ${b.title}`);
    } else if (b.title) {
      lines.push(`Clip title (paraphrase only if setup missing): ${b.title}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  const system = `You write Talk Soup cold-open VO for "Twitch Soup" (Bobby G host).
Output ONE flowing paragraph for ElevenLabs TTS — no quotes, no labels, no em-dashes.
Target 40–55 words (~12–15 seconds). Dry Joel McHale energy, PG-13.

RULES:
- Use the episode setup lines — NEVER read Twitch clip titles verbatim (no ALL CAPS, no "BANGGG", no meme spellings).
- Phonetics: say "Lacy" not "LAY-see".
- Complete every sentence — NO ellipsis, NO trailing "In The", NO cut-off phrases.
- Integrate streamer names naturally in prose (not "Lacy — title").
- End with "Let's get into it."`;

  const user = `Write cold-open VO. Montage cuts to each streamer in this order:\n\n${beatLines}`;

  try {
    const axios = require('axios');
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }],
        generationConfig: { temperature: 0.65, maxOutputTokens: 320 },
      },
      { timeout: 45000 },
    );
    const text = sanitizeColdOpenScript(
      resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim(),
    );
    const words = text ? text.split(/\s+/).length : 0;
    const hasScream = /[A-Z]{4,}|BANGGG|HATTRICKK/i.test(text || '');
    const bad = !text || words < 28 || /…|\.\.\./.test(text || '') || hasScream;
    if (!bad) {
      return text.replace(/^["']|["']$/g, '').trim();
    }
    console.warn(`[cold-open] Gemini script rejected (${words} words, scream=${hasScream}) — using setup draft`);
  } catch (e) {
    console.warn(`[cold-open] Gemini script failed: ${e.message}`);
  }
  return buildColdOpenScriptDraft(card);
}

/** Map cold-open beat clip URLs → downloaded local paths for montage. */
function resolveColdOpenMontagePaths(card, segsToProcess, localFiles) {
  const beats = card?.coldOpen?.beats || collectColdOpenClipBeats(card);
  const paths = [];
  let clipCounter = 0;
  for (let i = 0; i < segsToProcess.length; i++) {
    if (segsToProcess[i].type !== 'source_clip') continue;
    const oci = (card?.orderedClipUrls || [])[clipCounter];
    clipCounter += 1;
    if (!localFiles[i] || !fs.existsSync(localFiles[i])) continue;
    const url = oci?.url || oci?.clipUrl || '';
    const streamer = oci?.displayName || oci?.streamer || '';
    const matched = beats.find((b) =>
      (b.clipUrl && url && b.clipUrl === url)
      || String(b.streamer).toLowerCase() === String(streamer).toLowerCase(),
    );
    if (matched && !paths.includes(localFiles[i])) {
      paths.push(localFiles[i]);
    }
  }
  if (paths.length >= 2) return paths.slice(0, beats.length);
  return localFiles.filter((f, i) => f && segsToProcess[i]?.type === 'source_clip');
}

async function generateColdOpenVo(card, { script, jobId, log = console.log, useGemini = true } = {}) {
  let text = String(script || '').trim();
  if (!text) {
    text = useGemini ? await generateColdOpenScript(card) : buildColdOpenScriptDraft(card);
  }
  const beats = collectColdOpenClipBeats(card);
  mkdirp(path.join(TMP, jobId || 'draft'));
  const outPath = path.join(TMP, jobId || 'draft', 'cold_open_vo.m4a');
  const bookCfg = loadBookendsConfig(card?.customerId || 'c0');
  const announcerVoiceId = bookCfg.coldOpen.announcerVoiceId || resolveColdOpenVoiceId();
  const result = await synthesizeSpeech(text, outPath, {
    log: (m) => log(m),
    voiceId: announcerVoiceId,
  });
  if (!result) throw new Error('ElevenLabs TTS failed — check ELEVENLABS_API_KEY and voice ID');
  return {
    script: text,
    voPath: result.audioPath,
    durationSec: result.durationSec,
    beats,
    montageClipUrls: beats.map((b) => b.clipUrl).filter(Boolean),
    announcerVoiceId,
  };
}

function coldOpenApproved(card) {
  const co = card?.coldOpen || {};
  return co.approved === true && co.audioApproved === true && co.voPath && fs.existsSync(co.voPath);
}

/**
 * Duration for credits scroll — scales with YouTube description length.
 * @param {string} text - full description to scroll
 * @param {object} cfg - outroCredits config (minDurationSec, maxDurationSec, scrollPxPerSec)
 */
function computeCreditsDurationSec(text, cfg = {}) {
  const minSec = Number(cfg.minDurationSec) || 12;
  const maxSec = Number(cfg.maxDurationSec) || 55;
  const scrollPxPerSec = Number(cfg.scrollPxPerSec) || 46;
  const body = String(text || '').trim();
  if (!body) return minSec;
  const lines = body.split('\n').length;
  const chars = body.length;
  // ~32px per line at fontsize 22; add char-based slack for wrapped paragraphs.
  const scrollDistance = Math.max(720, lines * 32 + chars * 0.12);
  const computed = scrollDistance / scrollPxPerSec + 2.5;
  return Math.min(maxSec, Math.max(minSec, Math.ceil(computed)));
}

function creditsTextFromCard(card) {
  const desc = card?.publishCopy?.youtube?.description
    || card?.state?.savedOutputs?.publishCopy?.youtube?.description
    || card?.publishCopy?.description
    || '';
  if (desc.trim()) return desc.trim();

  const streamers = (card.streamers || []).map((s) => s.displayName || s.twitchUsername).filter(Boolean);
  const title = card.title || card.script?.title || 'Twitch Soup';
  const lines = [
    title,
    '',
    streamers.length ? `Featuring: ${streamers.join(', ')}` : '',
    '',
    'Clips courtesy of Twitch creators. Commentary is transformative.',
    '',
    card.publishCopy?.youtube?.title ? `Watch: ${card.publishCopy.youtube.title}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

async function runFfmpeg(args, label) {
  return new Promise((res, rej) => {
    const proc = execFile(ffmpegPath(), args, { maxBuffer: 80 * 1024 * 1024 });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${label} failed (${code}): ${stderr.slice(-300)}`));
    });
    proc.on('error', rej);
  });
}

/**
 * Render ~15s cold open: logo stinger + clip montage + VO + music bed.
 */
async function renderColdOpen({
  clipPaths,
  voPath,
  musicPath,
  logoPath,
  outPath,
  cfg,
  log = () => {},
}) {
  const durationSec = cfg.durationSec || 15;
  const logoSec = Math.min(cfg.logoSec || 2, durationSec * 0.25);
  const vo = voPath && fs.existsSync(voPath) ? voPath : null;
  let voDur = 0;
  if (vo) {
    try { voDur = await probeDurationSec(vo); } catch { voDur = 0; }
  }
  const montageTargetSec = Math.max(
    durationSec - logoSec,
    voDur > 0 ? voDur + 0.35 : durationSec - logoSec,
  );
  const totalDur = Math.min(Math.max(durationSec, logoSec + montageTargetSec), 20);
  const montageSec = Math.max(0.5, totalDur - logoSec);
  const perClip = cfg.montageClipSec || 1.5;
  const clips = (clipPaths || []).filter((p) => p && fs.existsSync(p));
  if (!clips.length) throw new Error('Cold open needs at least one source clip');

  mkdirp(path.dirname(outPath));
  const outBase = outPath.replace(/\.mp4$/i, '');
  const montageParts = [];
  // Loop clip beats until montage fills VO window (one hit per streamer, then repeat).
  let mi = 0;
  while (montageParts.reduce((s, p) => s + p.dur, 0) < montageSec - 0.05) {
    const clip = clips[mi % clips.length];
    const remaining = montageSec - montageParts.reduce((s, p) => s + p.dur, 0);
    if (remaining <= 0.05) break;
    const segDur = Math.min(perClip, remaining);
    const part = `${outBase}_m${montageParts.length}.mp4`;
    await runFfmpeg([
      '-ss', '0',
      '-i', clip,
      '-t', String(segDur),
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30',
      '-an',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-y', part,
    ], 'montage slice');
    montageParts.push({ path: path.resolve(part), dur: segDur });
    mi += 1;
    if (mi > 200) break;
  }

  const montageList = `${outBase}_montage_list.txt`;
  fs.writeFileSync(montageList, montageParts.map((p) => `file '${p.path.replace(/'/g, "'\\''")}'`).join('\n'));
  const montagePath = `${outBase}_montage.mp4`;
  await runFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', montageList,
    '-c', 'copy', '-y', montagePath,
  ], 'montage concat');

  const logo = logoPath && fs.existsSync(logoPath) ? logoPath : null;
  let videoPath = montagePath;
  if (logo && logoSec > 0) {
    const logoVid = `${outBase}_logo.mp4`;
    await runFfmpeg([
      '-f', 'lavfi', '-i', `color=c=black:s=1920x1080:d=${logoSec}`,
      '-loop', '1', '-i', logo,
      '-filter_complex', `[1:v]scale=480:-2[lg];[0:v][lg]overlay=(W-w)/2:(H-h)/2:format=auto:shortest=1[v]`,
      '-map', '[v]', '-t', String(logoSec), '-r', '30',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-y', logoVid,
    ], 'logo stinger');
    const withLogoList = `${outBase}_with_logo_list.txt`;
    fs.writeFileSync(withLogoList, [
      `file '${path.resolve(logoVid).replace(/'/g, "'\\''")}'`,
      `file '${path.resolve(montagePath).replace(/'/g, "'\\''")}'`,
    ].join('\n'));
    const withLogo = `${outBase}_with_logo.mp4`;
    await runFfmpeg([
      '-f', 'concat', '-safe', '0', '-i', withLogoList,
      '-c', 'copy', '-y', withLogo,
    ], 'logo+montage');
    videoPath = withLogo;
  }

  const music = musicPath && fs.existsSync(musicPath) ? musicPath : resolveMusicBed(cfg.musicBedKey);
  const mv = cfg.musicVolume ?? 0.28;
  const vv = cfg.voVolume ?? 1.0;

  const inputs = ['-i', videoPath];
  let fc;
  if (music && vo) {
    inputs.push('-stream_loop', '-1', '-i', music, '-i', vo);
    fc = [
      `[1:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,volume=${mv.toFixed(3)}[bed]`,
      `[2:a]volume=${vv.toFixed(2)},apad=whole_dur=${totalDur}[vo]`,
      '[bed][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]',
    ].join(';');
  } else if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    fc = `[1:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,volume=${mv.toFixed(3)}[aout]`;
  } else if (vo) {
    inputs.push('-i', vo);
    fc = `[1:a]volume=${vv.toFixed(2)},apad=whole_dur=${totalDur}[aout]`;
  } else {
    fc = null;
  }

  const args = [
    ...inputs,
    '-t', String(totalDur),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  ];
  if (fc) {
    args.push('-filter_complex', fc, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-ar', '44100', '-ac', '2');
  } else {
    args.push('-an');
  }
  args.push('-y', outPath);
  await runFfmpeg(args, 'cold open mux');
  log(`Cold open rendered: ${path.basename(outPath)} (${totalDur.toFixed(1)}s, ${montageParts.length} montage hits)`);
  return outPath;
}

/**
 * Credits outro with music bed — text matches YouTube description when available.
 */
async function renderCreditsOutro({
  creditsText,
  musicPath,
  outPath,
  cfg,
  log = () => {},
}) {
  const text = String(creditsText || '').trim().slice(0, 2800);
  if (!text) return null;
  const durationSec = cfg.fixedDurationSec
    ? Number(cfg.fixedDurationSec)
    : computeCreditsDurationSec(text, cfg);

  mkdirp(path.dirname(outPath));
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\n/g, '\\n');

  const music = musicPath && fs.existsSync(musicPath) ? musicPath : resolveMusicBed(cfg.musicBedKey);
  const mv = cfg.musicVolume ?? 0.32;
  const scroll = cfg.scroll !== false;
  const yExpr = scroll
    ? `h-t*${Math.max(40, Math.floor(720 / durationSec))}`
    : '(h-text_h)/2';

  const font = '/System/Library/Fonts/Supplemental/Arial.ttf';
  const fontArg = fs.existsSync(font) ? `fontfile=${font}:` : '';

  const vf = `drawbox=x=0:y=0:w=1920:h=1080:color=black@0.92:t=fill,drawtext=${fontArg}text='${escaped}':fontsize=22:fontcolor=white:x=(w-text_w)/2:y=${yExpr}:line_spacing=8`;

  const inputs = ['-f', 'lavfi', '-i', `color=c=black:s=1920x1080:d=${durationSec}:r=30`];
  let args;
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    args = [
      ...inputs,
      '-filter_complex', `[0:v]${vf}[v];[1:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS,volume=${mv.toFixed(3)}[aout]`,
      '-map', '[v]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', '-y', outPath,
    ];
  } else {
    args = [
      ...inputs,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-y', outPath,
    ];
  }

  await runFfmpeg(args, 'credits outro');
  log(`Credits outro rendered: ${path.basename(outPath)} (${durationSec}s, ${text.split('\n').length} lines)`);
  return outPath;
}

/** Append tail MP4 to main via MPEG-TS concat (avoids MP4 timestamp corruption). */
async function appendMp4TailViaTs(mainPath, tailPath, log = () => {}) {
  const tsPaths = [];
  for (let i = 0; i < 2; i++) {
    const src = i === 0 ? mainPath : tailPath;
    const tsPath = mainPath.replace(/\.mp4$/i, `_append_${i}.ts`);
    await runFfmpeg([
      '-i', src,
      '-c', 'copy',
      '-bsf:v', 'h264_mp4toannexb',
      '-f', 'mpegts',
      '-y', tsPath,
    ], `append ts ${i}`);
    tsPaths.push(tsPath);
  }
  const tmpOut = mainPath.replace(/\.mp4$/i, '_with_credits.mp4');
  await runFfmpeg([
    '-i', `concat:${tsPaths.join('|')}`,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    '-y', tmpOut,
  ], 'append credits concat');
  for (const tsPath of tsPaths) {
    try { fs.unlinkSync(tsPath); } catch (_) {}
  }
  try { fs.unlinkSync(mainPath); } catch (_) {}
  fs.renameSync(tmpOut, mainPath);
  log(`Credits tail appended → ${path.basename(mainPath)}`);
}

/**
 * Render credits from card publishCopy and append to assembled MP4.
 * Call after SEO + chapter injection — not during initial group stitch.
 */
async function appendCreditsOutroToVideo({
  mainMp4Path,
  card,
  asmId,
  customerId = 'c0',
  log = () => {},
}) {
  if (!mainMp4Path || !fs.existsSync(mainMp4Path)) {
    return { appended: false, reason: 'missing_main_mp4' };
  }
  const bookCfg = loadBookendsConfig(customerId);
  if (!bookCfg.outroCredits?.enabled) {
    return { appended: false, reason: 'outro_disabled' };
  }
  const creditsText = creditsTextFromCard(card);
  if (!creditsText || creditsText.length < 20) {
    return { appended: false, reason: 'no_publish_description' };
  }
  const durationSec = computeCreditsDurationSec(creditsText, bookCfg.outroCredits);
  const outroPath = path.join(path.dirname(mainMp4Path), `${asmId || 'asm'}_credits_outro.mp4`);
  const musicPath = resolveMusicBed(bookCfg.outroCredits.musicBedKey || bookCfg.coldOpen?.musicBedKey);
  const rendered = await renderCreditsOutro({
    creditsText,
    musicPath,
    outPath: outroPath,
    cfg: bookCfg.outroCredits,
    log,
  });
  if (!rendered || !fs.existsSync(outroPath)) {
    return { appended: false, reason: 'render_failed' };
  }
  await appendMp4TailViaTs(mainMp4Path, outroPath, log);
  try { fs.unlinkSync(outroPath); } catch (_) {}
  return { appended: true, durationSec, creditsTextLen: creditsText.length };
}

module.exports = {
  loadBookendsConfig,
  isBookendsEnabled,
  collectColdOpenClipBeats,
  buildColdOpenScriptDraft,
  generateColdOpenScript,
  generateColdOpenVo,
  resolveColdOpenMontagePaths,
  coldOpenApproved,
  creditsTextFromCard,
  computeCreditsDurationSec,
  renderColdOpen,
  renderCreditsOutro,
  appendCreditsOutroToVideo,
  appendMp4TailViaTs,
  resolveMusicBed,
  probeDurationSec,
};
