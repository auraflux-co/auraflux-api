'use strict';
/**
 * Twitch Soup cold open (~15s montage + ElevenLabs VO + music) and credits outro.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { filterFfmpegPath, ffprobePath } = require('./ffmpeg_utils');
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

function numOr(defaults, key, fallback) {
  const v = Number(defaults?.[key]);
  return Number.isFinite(v) ? v : fallback;
}

function loadBookendsConfig(customerId = 'c0') {
  try {
    const { loadCustomerConfig } = require('./job_spec');
    const cfg = loadCustomerConfig(customerId);
    const defaults = resolveTwitchBookendsDefaults(cfg);
    return {
      coldOpen: {
        enabled: defaults.coldOpen?.enabled !== false,
        durationSec: numOr(defaults.coldOpen, 'durationSec', 15),
        musicVolume: numOr(defaults.coldOpen, 'musicVolume', 0.28),
        voVolume: numOr(defaults.coldOpen, 'voVolume', 1.0),
        montageClipSec: numOr(defaults.coldOpen, 'montageClipSec', 1.2),
        minBeatSec: numOr(defaults.coldOpen, 'minBeatSec', 2.0),
        logoSec: numOr(defaults.coldOpen, 'logoSec', 0),
        crowdBedVolume: numOr(defaults.coldOpen, 'crowdBedVolume', 0),
        musicBedKey: defaults.coldOpen?.musicBedKey || null,
        musicBedFile: defaults.coldOpen?.musicBedFile || null,
        announcerVoiceId: defaults.coldOpen?.announcerVoiceId || null,
        crowdBedFile: defaults.coldOpen?.crowdBedFile || null,
        maxDurationSec: numOr(defaults.coldOpen, 'maxDurationSec', 28),
      },
      outroCredits: {
        enabled: defaults.outroCredits?.enabled !== false,
        durationSec: numOr(defaults.outroCredits, 'durationSec', 8),
        fixedDurationSec: numOr(defaults.outroCredits, 'fixedDurationSec', 30),
        musicVolume: numOr(defaults.outroCredits, 'musicVolume', 0.32),
        scroll: defaults.outroCredits?.scroll !== false,
        scrollPxPerSec: numOr(defaults.outroCredits, 'scrollPxPerSec', 52),
        fontSize: numOr(defaults.outroCredits, 'fontSize', 36),
        musicBedKey: defaults.outroCredits?.musicBedKey || null,
      },
    };
  } catch {
    return {
      coldOpen: { enabled: true, durationSec: 15, musicVolume: 0.28, voVolume: 1, montageClipSec: 1.2, logoSec: 0, minBeatSec: 2 },
      outroCredits: { enabled: true, durationSec: 8, musicVolume: 0.32, scroll: true, fontSize: 36, scrollPxPerSec: 52 },
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
  let t = String(text || '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/…|\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
  // CPD-1222: ElevenLabs (announcer voice) reads plain streamer names correctly but
  // mangles roster phonetic spellings ("EM-ih-roo" → "Amiru", "Yawn-uh" → "Yana").
  // Phonetics leak in from script-gen setups and resolveColdOpenSpeakerName — collapse
  // every roster phonetic back to the on-air name before TTS (generalizes the old
  // hardcoded LAY-see→Lacy rule). HeyGen scenes keep phonetics; the cold open must not.
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'streamers.json'), 'utf8'))?.roster || [];
    for (const s of roster) {
      const spoken = s?.onAirName || s?.displayName;
      if (!s?.phonetic || !spoken || s.phonetic === spoken) continue;
      const esc = String(s.phonetic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\b${esc}\\b`, 'gi'), spoken);
    }
  } catch { /* roster unavailable — leave names as written */ }
  return t;
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

/** Resolve spoken name for cold-open beat (onAirName or phonetic — never login + onAir duplicate). */
function resolveColdOpenSpeakerName(streamerLabel) {
  try {
    const { resolveTwitchLogin } = require('./streamer_login');
    const login = resolveTwitchLogin(streamerLabel);
    const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'streamers.json'), 'utf8'));
    const entry = (roster.roster || []).find(
      (s) => String(s.twitchUsername || '').toLowerCase() === login
    );
    if (entry?.phonetic) return entry.phonetic;
    if (entry?.onAirName) return entry.onAirName;
  } catch (_e) { /* fallback below */ }
  return String(streamerLabel || '').trim() || 'the streamer';
}

/** Short Talk Soup phrase from episode SETUP — never raw clip titles. */
function coldOpenPhraseFromSetup(setup, streamer) {
  const speaker = resolveColdOpenSpeakerName(streamer);
  const s = String(setup || '').replace(/\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return `${speaker} has a clip you need to see`;

  if (/spelling bee/i.test(s)) {
    return `${speaker} watches a spelling bee go somewhere no one expected`;
  }
  if (/national pride|sports fan|stadium|enthusiasm to every game/i.test(s)) {
    return `${speaker} goes full stadium mode when Japan scores`;
  }
  if (/video call|casual chat|intimate moment/i.test(s)) {
    return `${speaker} keeps it together while Jason overshares on stream`;
  }
  if (/patriot|team|dressing the part/i.test(s)) {
    return `${speaker} rides for his team with zero chill`;
  }
  if (/new car|seatbelt/i.test(s)) {
    return `${speaker} treats a new car reveal like breaking news`;
  }

  let clause = s.split(/[.!?]/)[0].trim();
  // Strip leading onAirName, phonetic, or login so we never double-prefix
  for (const prefix of [speaker, streamer, 'Emily', 'Emiru', 'Yawn-uh', 'Yonna']) {
    if (!prefix) continue;
    clause = clause.replace(new RegExp(`^${String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '').trim();
  }
  clause = clause.split(',')[0].trim();
  const words = clause.split(/\s+/).slice(0, 9).join(' ');
  if (!words) return `${speaker} has a moment you need to see`;
  return `${speaker} ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
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

/** Word-weighted montage slot per streamer beat — holds image until VO passes that name. */
function computeMontageBeatDurations(beats, montageSec, cfg = {}) {
  const minBeat = Number(cfg.minBeatSec) || 2.0;
  if (!beats.length) return [];
  const weights = beats.map((b) => {
    const phrase = b.setupPhrase || coldOpenPhraseFromSetup(b.setup, b.streamer);
    return Math.max(phrase.split(/\s+/).filter(Boolean).length, 4);
  });
  const totalW = weights.reduce((a, b) => a + b, 0) || beats.length;
  let allocated = 0;
  const durs = weights.map((w, i) => {
    if (i === weights.length - 1) {
      return Math.max(minBeat, montageSec - allocated);
    }
    const d = Math.max(minBeat, (w / totalW) * montageSec);
    allocated += d;
    return d;
  });
  const sum = durs.reduce((a, b) => a + b, 0);
  if (sum > montageSec + 0.05) {
    const scale = montageSec / sum;
    return durs.map((d) => Math.max(minBeat * 0.85, d * scale));
  }
  return durs;
}

function sidebarThumbForStreamer(card, streamerName) {
  const dn = String(streamerName || '').toLowerCase();
  const saved = card?.sidebarThumbs || {};
  for (const [key, entry] of Object.entries(saved)) {
    if (entry?.localPath && fs.existsSync(entry.localPath)) {
      const rowName = String(entry.displayName || key).toLowerCase();
      if (rowName === dn || key.replace(/_/g, '') === dn.replace(/\s+/g, '')) {
        return entry.localPath;
      }
    }
  }
  const manifest = (card?.streamers || []).map((s, idx) => ({ s, idx }));
  for (const { s, idx } of manifest) {
    const name = String(s.displayName || s.twitchUsername || '').toLowerCase();
    if (name === dn) {
      const key = String(s.twitchUsername || s.displayName || idx).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const lp = saved[key]?.localPath;
      if (lp && fs.existsSync(lp)) return lp;
    }
  }
  return null;
}

/** One visual per streamer beat: sidebar thumb (preferred) or first clip for that streamer. */
function resolveColdOpenBeatSlides(card, segsToProcess, localFiles) {
  const beats = card?.coldOpen?.beats || collectColdOpenClipBeats(card);
  const clipByStreamer = new Map();
  let clipCounter = 0;
  for (let i = 0; i < segsToProcess.length; i++) {
    if (segsToProcess[i].type !== 'source_clip') continue;
    const oci = (card?.orderedClipUrls || [])[clipCounter];
    clipCounter += 1;
    if (!localFiles[i] || !fs.existsSync(localFiles[i])) continue;
    const streamer = String(oci?.displayName || oci?.streamer || '').toLowerCase();
    if (streamer && !clipByStreamer.has(streamer)) {
      clipByStreamer.set(streamer, localFiles[i]);
    }
  }
  return beats.map((b) => {
    const clip = clipByStreamer.get(String(b.streamer).toLowerCase());
    const thumb = sidebarThumbForStreamer(card, b.streamer);
    // Prefer source-clip frame — sidebar thumbs are ~4KB Twitch icons, unusable at 1080p.
    let path = clip;
    let isImage = false;
    if (!path && thumb && fs.existsSync(thumb)) {
      try {
        const sz = fs.statSync(thumb).size;
        if (sz >= 80000) {
          path = thumb;
          isImage = true;
        }
      } catch (_) { /* use clip fallback */ }
    }
    return { streamer: b.streamer, path, isImage };
  }).filter((s) => s.path);
}

/** Map cold-open beat clip URLs → downloaded local paths for montage (legacy flat list). */
function resolveColdOpenMontagePaths(card, segsToProcess, localFiles) {
  return resolveColdOpenBeatSlides(card, segsToProcess, localFiles).map((s) => s.path);
}

async function generateColdOpenVo(card, { script, jobId, log = console.log, useGemini = true } = {}) {
  let text = String(script || '').trim();
  if (!text) {
    text = useGemini ? await generateColdOpenScript(card) : buildColdOpenScriptDraft(card);
  } else {
    // CPD-1222: operator/card-supplied scripts skip generateColdOpenScript — sanitize
    // here too so roster phonetics never reach the ElevenLabs announcer.
    text = sanitizeColdOpenScript(text);
  }
  const beats = collectColdOpenClipBeats(card);
  mkdirp(path.join(TMP, jobId || 'draft'));
  const outPath = path.join(TMP, jobId || 'draft', 'cold_open_vo.m4a');
  const bookCfg = loadBookendsConfig(card?.customerId || 'c0');
  const announcerVoiceId = bookCfg.coldOpen.announcerVoiceId
    || card?.coldOpen?.announcerVoiceId
    || resolveColdOpenVoiceId();
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
const CREDITS_CANVAS_H = 1080;
const CREDITS_LINE_SPACING = 12; // must match drawtext line_spacing in renderCreditsOutro
const CREDITS_TAIL_PAD_SEC = 1.5;

/** Total scroll distance (px) for the credits text to fully clear the top of the screen. */
function creditsScrollTravelPx(text, cfg = {}) {
  const fontSize = Number(cfg.fontSize) || 36;
  const lines = String(text || '').split('\n').length;
  return CREDITS_CANVAS_H + lines * (fontSize + CREDITS_LINE_SPACING);
}

/**
 * Scroll speed (px/sec) used by the render. Starts from the configured speed and
 * speeds up when the text is too tall to clear within maxDurationSec — the scroll
 * must always complete (CPD-1215: credits were cut off mid-scroll).
 */
function resolveCreditsScrollPxPerSec(text, cfg = {}) {
  const base = Math.max(48, Math.floor(Number(cfg.scrollPxPerSec) || 52));
  const maxSec = Number(cfg.maxDurationSec) || 55;
  const travel = creditsScrollTravelPx(text, cfg);
  const required = travel / Math.max(1, maxSec - CREDITS_TAIL_PAD_SEC);
  return Math.max(base, Math.ceil(required));
}

function computeCreditsDurationSec(text, cfg = {}) {
  const minSec = Number(cfg.minDurationSec) || 12;
  const maxSec = Number(cfg.maxDurationSec) || 55;
  const body = String(text || '').trim();
  if (!body) return minSec;
  // Use the same wrapping + geometry as renderCreditsOutro so the computed
  // duration matches what actually renders (CPD-1215: scroll was cut off).
  const wrapped = wrapCreditsLines(body);
  const pxPerSec = resolveCreditsScrollPxPerSec(wrapped, cfg);
  const computed = creditsScrollTravelPx(wrapped, cfg) / pxPerSec + CREDITS_TAIL_PAD_SEC;
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
    const proc = execFile(filterFfmpegPath(), args, { maxBuffer: 80 * 1024 * 1024 });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${label} failed (${code}): ${stderr.slice(-300)}`));
    });
    proc.on('error', rej);
  });
}

async function renderMontageSlice({ srcPath, isImage, dur, outPath, streamerLabel }) {
  const vf = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p';
  const label = String(streamerLabel || '').slice(0, 24);
  const draw = label
    ? `,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='${label.replace(/'/g, "\\'")}':x=(w-text_w)/2:y=h-72:fontsize=28:fontcolor=white:borderw=2:bordercolor=black@0.7`
    : '';
  if (isImage || /\.(png|jpe?g|webp)$/i.test(srcPath)) {
    await runFfmpeg([
      '-loop', '1', '-i', srcPath,
      '-t', String(dur),
      '-vf', `${vf}${draw}`,
      '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-y', outPath,
    ], 'montage still');
  } else {
    await runFfmpeg([
      '-ss', '0', '-i', srcPath,
      '-t', String(dur),
      '-vf', `${vf}${draw}`,
      '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-y', outPath,
    ], 'montage slice');
  }
}

/**
 * Render cold open: VO-synced streamer montage + announcer VO + music (+ optional crowd bed).
 * Logo stinger is optional (logoSec=0 — never lead with double logo).
 */
async function renderColdOpen({
  clipPaths,
  beatSlides,
  voPath,
  musicPath,
  logoPath,
  outPath,
  cfg,
  log = () => {},
}) {
  const durationSec = cfg.durationSec || 15;
  const logoSec = Math.max(0, Number(cfg.logoSec) || 0);
  const vo = voPath && fs.existsSync(voPath) ? voPath : null;
  let voDur = 0;
  if (vo) {
    try { voDur = await probeDurationSec(vo); } catch { voDur = 0; }
  }
  const maxColdOpenSec = Number(cfg.maxDurationSec) || 28;
  const montageTargetSec = Math.max(
    durationSec - logoSec,
    voDur > 0 ? voDur + 0.35 : durationSec - logoSec,
  );
  const totalDur = voDur > 0
    ? Math.min(Math.max(voDur + logoSec + 0.4, durationSec), maxColdOpenSec)
    : Math.min(Math.max(durationSec, logoSec + montageTargetSec), maxColdOpenSec);
  const montageSec = Math.max(0.5, totalDur - logoSec);

  const beats = cfg.beats || [];
  const slides = (beatSlides && beatSlides.length)
    ? beatSlides
    : (clipPaths || []).filter((p) => p && fs.existsSync(p)).map((p) => ({ path: p, isImage: false, streamer: '' }));

  if (!slides.length) throw new Error('Cold open needs at least one streamer visual');

  mkdirp(path.dirname(outPath));
  const outBase = outPath.replace(/\.mp4$/i, '');
  const montageParts = [];
  const beatDurs = computeMontageBeatDurations(
    beats.length ? beats : slides.map((s) => ({ streamer: s.streamer, setup: '', setupPhrase: s.streamer })),
    montageSec,
    cfg,
  );

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const segDur = beatDurs[i] || Math.max(2, montageSec / slides.length);
    const part = `${outBase}_m${i}.mp4`;
    await renderMontageSlice({
      srcPath: slide.path,
      isImage: slide.isImage,
      dur: segDur,
      outPath: part,
      streamerLabel: slide.streamer,
    });
    montageParts.push({ path: path.resolve(part), dur: segDur });
    log(`Montage beat ${i + 1}/${slides.length}: ${slide.streamer} ${segDur.toFixed(1)}s`);
  }

  const montageList = `${outBase}_montage_list.txt`;
  fs.writeFileSync(montageList, montageParts.map((p) => `file '${p.path.replace(/'/g, "'\\''")}'`).join('\n'));
  const montagePath = `${outBase}_montage.mp4`;
  await runFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', montageList,
    '-vf', 'fps=30,format=yuv420p',
    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-y', montagePath,
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

  const musicFromOperator = (() => {
    try {
      const { resolveOpeningMusicBedPath } = require('./studio_laughter');
      return resolveOpeningMusicBedPath(cfg);
    } catch (_) { return null; }
  })();
  const music = (musicPath && fs.existsSync(musicPath) ? musicPath : null)
    || musicFromOperator
    || (resolveMusicBed(cfg.musicBedKey));
  const mv = cfg.musicVolume ?? 0.28;
  const vv = cfg.voVolume ?? 1.0;
  const cv = Number(cfg.crowdBedVolume) || 0;
  const fadeOut = Math.min(0.4, Math.max(0.15, totalDur * 0.08));
  const fadeStart = Math.max(0, totalDur - fadeOut);
  const bedFilter = (idx) => `[${idx}:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,volume=${mv.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOut.toFixed(3)}[bed]`;
  let crowdPath = null;
  if (cv > 0) {
    try {
      const { resolveOpeningCrowdBedPath } = require('./studio_laughter');
      crowdPath = resolveOpeningCrowdBedPath(cfg);
    } catch (_) { /* optional */ }
  }

  const inputs = ['-i', videoPath];
  let fc;
  if (music && vo && crowdPath && fs.existsSync(crowdPath)) {
    inputs.push('-stream_loop', '-1', '-i', music, '-i', vo, '-stream_loop', '-1', '-i', crowdPath);
    fc = [
      bedFilter(1),
      `[2:a]volume=${vv.toFixed(2)},apad=whole_dur=${totalDur}[vo]`,
      `[3:a]atrim=0:${totalDur},asetpts=PTS-STARTPTS,volume=${cv.toFixed(3)}[crowd]`,
      '[bed][vo][crowd]amix=inputs=3:duration=first:dropout_transition=0[aout]',
    ].join(';');
  } else if (music && vo) {
    inputs.push('-stream_loop', '-1', '-i', music, '-i', vo);
    fc = [
      bedFilter(1),
      `[2:a]volume=${vv.toFixed(2)},apad=whole_dur=${totalDur}[vo]`,
      '[bed][vo]amix=inputs=2:duration=first:dropout_transition=0[aout]',
    ].join(';');
  } else if (music) {
    inputs.push('-stream_loop', '-1', '-i', music);
    fc = bedFilter(1).replace('[bed]', '[aout]');
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

function wrapCreditsLines(text, maxCols = 68) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) { out.push(''); continue; }
    const words = line.split(/\s+/);
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (next.length <= maxCols) {
        cur = next;
      } else {
        if (cur) out.push(cur);
        cur = w;
      }
    }
    if (cur) out.push(cur);
  }
  return out.join('\n');
}

/**
 * Credits outro with music bed — centered scroll, readable type size.
 */
async function renderCreditsOutro({
  creditsText,
  musicPath,
  outPath,
  cfg,
  log = () => {},
}) {
  const wrapped = wrapCreditsLines(String(creditsText || '').trim().slice(0, 2800));
  if (!wrapped) return null;
  const durationSec = cfg.fixedDurationSec
    ? Number(cfg.fixedDurationSec)
    : computeCreditsDurationSec(wrapped, cfg);

  mkdirp(path.dirname(outPath));
  const textFile = outPath.replace(/\.mp4$/i, '_scroll.txt');
  fs.writeFileSync(textFile, wrapped, 'utf8');
  const textFileEsc = textFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const music = musicPath && fs.existsSync(musicPath) ? musicPath : resolveMusicBed(cfg.musicBedKey);
  const mv = cfg.musicVolume ?? 0.32;
  const scroll = cfg.scroll !== false;
  const fontSize = Number(cfg.fontSize) || 36;
  // Speed must let the full text clear the top within durationSec (incl. fixedDurationSec).
  const travelPx = creditsScrollTravelPx(wrapped, cfg);
  const scrollPxPerSec = Math.max(
    Math.max(48, Math.floor(Number(cfg.scrollPxPerSec) || 52)),
    Math.ceil(travelPx / Math.max(1, durationSec - CREDITS_TAIL_PAD_SEC)),
  );
  const yExpr = scroll
    ? `h-t*${scrollPxPerSec}`
    : '(h-text_h)/2';

  const font = '/System/Library/Fonts/Supplemental/Arial.ttf';
  const fontArg = fs.existsSync(font) ? `fontfile=${font}:` : '';

  const dt = [
    `drawtext=${fontArg}textfile='${textFileEsc}'`,
    `fontsize=${fontSize}`,
    'fontcolor=white@0.95',
    'x=(w-text_w)/2',
    `y=${yExpr}`,
    'line_spacing=12',
    'borderw=2',
    'bordercolor=black@0.65',
  ].join(':');
  const vf = `drawbox=x=0:y=0:w=1920:h=1080:color=black@0.92:t=fill,${dt}`;

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
  log(`Credits outro rendered: ${path.basename(outPath)} (${durationSec}s, ${wrapped.split('\n').length} lines)`);
  return outPath;
}

/** Append tail MP4 to main via MPEG-TS concat (avoids MP4 timestamp corruption). */
async function appendMp4TailViaTs(mainPath, tailPath, log = () => {}) {
  const tmpOut = mainPath.replace(/\.mp4$/i, '_with_credits.mp4');
  // Re-encode concat — stream-copy TS mux caused non-monotonic DTS at the splice (~463s).
  await runFfmpeg([
    '-i', mainPath,
    '-i', tailPath,
    '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]',
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-fflags', '+genpts',
    '-movflags', '+faststart',
    '-y', tmpOut,
  ], 'append credits concat');
  const { probeMp4DecodeIntegrity } = require('./ffmpeg_utils');
  const integrity = await probeMp4DecodeIntegrity(tmpOut);
  if (!integrity.ok) {
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    throw new Error(`Credits append produced bad timestamps: ${integrity.errors.join('; ')}`);
  }
  try { fs.unlinkSync(mainPath); } catch (_) {}
  fs.renameSync(tmpOut, mainPath);
  log(`Credits tail appended (re-encoded) → ${path.basename(mainPath)}`);
}

/**
 * Render credits from card publishCopy and append to assembled MP4.
 * Call after SEO + chapter injection — not during initial group stitch.
 */
/** Minimum assembled runtime when credits scroll is enabled (~7:45). */
const TWITCH_SOUP_MIN_WITH_CREDITS_SEC = 495;

/**
 * Block publish when long-form Twitch Soup is missing the credits outro.
 * Sync flag check lives in operator_creative_guard; this adds duration probe.
 */
async function assertTwitchSoupPublishReady({
  card,
  jobSpec,
  mainMp4Path,
  customerId = 'c0',
} = {}) {
  const bookCfg = loadBookendsConfig(customerId);
  if (!bookCfg.outroCredits?.enabled) return { ready: true, reasons: [] };

  const ct = String(jobSpec?.contentType || card?.contentType || '').toLowerCase();
  const isLong = ct.includes('twitch') && !jobSpec?.isShort && !card?.clipsOnly;
  if (!isLong) return { ready: true, reasons: [] };

  const reasons = [];
  const creditsFlag = !!(
    card?.creditsOutroAppended
    || jobSpec?.creditsOutroAppended
    || jobSpec?.state?.savedOutputs?.creditsOutroAppended
  );
  if (!creditsFlag) {
    reasons.push('Credits outro not marked appended (creditsOutroAppended !== true)');
  }

  const mp4 = mainMp4Path
    || card?.outputPath
    || jobSpec?.assembledPath
    || jobSpec?.state?.savedOutputs?.assembledPath;
  if (mp4 && fs.existsSync(mp4)) {
    try {
      const dur = await probeDurationSec(mp4);
      if (dur < TWITCH_SOUP_MIN_WITH_CREDITS_SEC) {
        reasons.push(
          `MP4 duration ${dur.toFixed(1)}s < ${TWITCH_SOUP_MIN_WITH_CREDITS_SEC}s — credits outro likely missing`,
        );
      }
    } catch (err) {
      reasons.push(`Cannot probe MP4 duration: ${err.message}`);
    }
  } else if (!creditsFlag) {
    reasons.push('Assembled MP4 missing — cannot verify credits outro duration');
  }

  return { ready: reasons.length === 0, reasons };
}

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
  try {
    const existingDur = await probeDurationSec(mainMp4Path);
    if (existingDur >= TWITCH_SOUP_MIN_WITH_CREDITS_SEC) {
      log(`Skip credits append — ${existingDur.toFixed(1)}s already includes outro`);
      return { appended: false, reason: 'duration_suggests_credits_present', durationSec: existingDur };
    }
  } catch (_) { /* probe optional */ }
  if (card?.creditsOutroAppended === true) {
    return { appended: false, reason: 'already_appended' };
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

/**
 * Pre-assembly gate — validate card inputs before burning ffmpeg/HeyGen time.
 * Called at /assemble entry for twitch long-form jobs.
 */
async function verifyTwitchSoupPreAssembly({ card, customerId = 'c0', log = () => {} }) {
  const bookCfg = loadBookendsConfig(customerId);
  const blockers = [];
  const notes = [];

  const clips = card?.orderedClipUrls || [];
  const setupScenes = (card?.script?.scenes || []).filter((s) => s.hasClipInsert || /_CLIP\d+_SETUP$/i.test(s.name || ''));
  if (setupScenes.length && clips.length < setupScenes.length) {
    blockers.push(`orderedClipUrls ${clips.length}/${setupScenes.length} — clip count mismatch`);
  }
  clips.forEach((c, i) => {
    const url = c?.url || c?.clipUrl || c?.geminiUrl;
    if (!url) blockers.push(`clip ${i + 1} missing URL`);
  });

  const heygenJobs = card?.heygen?.videoJobs || [];
  let expectedHeygenCount = heygenJobs.length;
  try {
    const { buildHeyGenSceneRows } = require('./scene_scaffold_panel');
    const scaffold = buildHeyGenSceneRows({
      card,
      script: card?.script?.raw || card?.script,
      contentType: card?.contentType || 'twitch',
    });
    if (scaffold.heygenSceneCount) expectedHeygenCount = scaffold.heygenSceneCount;
  } catch (_) { /* fall back to videoJobs length */ }
  if (expectedHeygenCount && heygenJobs.length < expectedHeygenCount) {
    blockers.push(`HeyGen ${heygenJobs.length}/${expectedHeygenCount} scenes — incomplete before assembly`);
  }
  const incompleteHg = heygenJobs.filter((j) => j.status && j.status !== 'completed');
  if (incompleteHg.length) {
    blockers.push(`HeyGen incomplete: ${incompleteHg.map((j) => j.sceneName || j.heygenTitle).join(', ')}`);
  }

  if (bookCfg.coldOpen.enabled && coldOpenApproved(card)) {
    if (!card.coldOpen?.voPath || !fs.existsSync(card.coldOpen.voPath)) {
      blockers.push('Cold open VO approved but file missing on disk');
    } else {
      try {
        const voDur = await probeDurationSec(card.coldOpen.voPath);
        if (!Number.isFinite(voDur) || voDur < 3) blockers.push(`Cold open VO too short (${voDur}s)`);
      } catch (e) {
        blockers.push(`Cold open VO unreadable: ${e.message}`);
      }
    }
    const beats = card.coldOpen?.beats || collectColdOpenClipBeats(card);
    beats.forEach((b, i) => {
      if (!b.clipUrl) blockers.push(`Cold open beat ${i + 1} (${b.streamer}) missing clipUrl`);
    });
  }

  let isStudioLaughEnabled;
  try {
    ({ isStudioLaughEnabled, listLaughLibraryClips, resolveOpeningCrowdBedPath } = require('./studio_laughter'));
  } catch (_) { isStudioLaughEnabled = () => false; }

  if (isStudioLaughEnabled(customerId)) {
    const laughs = listLaughLibraryClips ? listLaughLibraryClips() : [];
    const reactionCount = (card?.script?.scenes || []).filter((s) => /_REACTION$/i.test(s.name || '')).length;
    if (!laughs.length) {
      blockers.push('Studio laugh enabled but no QA-passed or operator laugh clips — drop files in assets/audio/studio_laugh/operator/segment_laughs/');
    } else if (reactionCount > laughs.length) {
      notes.push(`Laugh library ${laughs.length} clips for ${reactionCount} reactions — will rotate`);
    }
  }

  if (bookCfg.coldOpen.enabled && coldOpenApproved(card) && Number(bookCfg.coldOpen.musicVolume) > 0) {
    const { resolveOpeningMusicBedPath } = require('./studio_laughter');
    const bed = resolveOpeningMusicBedPath(bookCfg.coldOpen);
    if (!bed) {
      blockers.push('Cold open music bed enabled but operator/opening_music_bed.mp3 missing');
    }
  }
  if (bookCfg.coldOpen.enabled && coldOpenApproved(card) && Number(bookCfg.coldOpen.crowdBedVolume) > 0) {
    const bed = resolveOpeningCrowdBedPath ? resolveOpeningCrowdBedPath(bookCfg.coldOpen) : null;
    if (!bed) {
      blockers.push('Cold open crowd bed enabled but operator/opening_crowd_bed.mp3 missing');
    }
  }

  if (bookCfg.outroCredits.enabled) {
    const creditsText = creditsTextFromCard(card);
    if (!creditsText || creditsText.length < 20) {
      blockers.push('Credits outro enabled but publishCopy description too short');
    }
  }

  const ok = blockers.length === 0;
  if (ok) {
    log(`✅ Twitch Soup pre-assembly check passed${notes.length ? ` (${notes.join('; ')})` : ''}`);
  } else {
    log(`❌ Twitch Soup pre-assembly FAILED: ${blockers.join(' | ')}`);
  }
  return { ok, blockers, notes };
}

/**
 * Post-assembly verification — creative bookends must be present or job is not review-ready.
 * Gates 3a/4 do not check cold open / studio laugh / credits; this closes that gap.
 */
async function verifyTwitchSoupAssembly({
  mainMp4Path,
  asmId,
  card,
  segsToProcess,
  localFiles,
  customerId = 'c0',
  creditsAppended = false,
  studioLaughBuilt = null,
  studioLaughExpected = null,
  coldOpenSec = 0,
  log = () => {},
}) {
  const bookCfg = loadBookendsConfig(customerId);
  const blockers = [];
  const notes = [];

  if (mainMp4Path && fs.existsSync(mainMp4Path)) {
    try {
      const dur = await probeDurationSec(mainMp4Path);
      if (dur < 420) notes.push(`Runtime ${dur.toFixed(0)}s — shorter than typical Soup (~7:30+)`);
    } catch (_) { /* non-fatal */ }
    const { probeMp4DecodeIntegrity } = require('./ffmpeg_utils');
    const integrity = await probeMp4DecodeIntegrity(mainMp4Path);
    if (!integrity.ok) {
      blockers.push(`MP4 decode integrity failed: ${integrity.errors.join('; ')}`);
    }
  } else {
    blockers.push('Final MP4 missing');
  }

  if (bookCfg.coldOpen.enabled && card && coldOpenApproved(card)) {
    const tmpDir = path.join(__dirname, '..', 'tmp');
    const coldPath = fs.existsSync(path.join(tmpDir, `${asmId}_cold_open.mp4`))
      ? path.join(tmpDir, `${asmId}_cold_open.mp4`)
      : path.join(path.dirname(mainMp4Path || ''), `${asmId}_cold_open.mp4`);
    if (!fs.existsSync(coldPath)) {
      blockers.push('Cold open not rendered (approved card missing cold_open mp4)');
    } else if (bookCfg.coldOpen.logoSec === 0 && fs.existsSync(coldPath.replace('.mp4', '_logo.mp4'))) {
      blockers.push('logoSec=0 but logo stinger file exists — double-logo risk');
    } else if (Number(coldOpenSec) <= 0) {
      try {
        const coDur = await probeDurationSec(coldPath);
        if (coDur < 5) blockers.push(`Cold open too short (${coDur.toFixed(1)}s)`);
      } catch (_) {
        blockers.push('Cold open file unreadable');
      }
    }
    if (!card.coldOpen?.voPath || !fs.existsSync(card.coldOpen.voPath)) {
      notes.push('Cold open announcer VO path missing — montage may be silent');
    }
  }

  if (bookCfg.outroCredits.enabled && !creditsAppended) {
    blockers.push('Credits outro not appended');
  }

  let isStudioLaughEnabled;
  try {
    ({ isStudioLaughEnabled } = require('./studio_laughter'));
  } catch (_) { isStudioLaughEnabled = () => false; }

  if (isStudioLaughEnabled(customerId)) {
    const expected = studioLaughExpected != null
      ? studioLaughExpected
      : (segsToProcess || []).filter(
        (s) => s.studioLaughAfter || (s.type === 'avatar' && /_REACTION$/i.test(s.label || '')),
      ).length;
    const built = studioLaughBuilt != null
      ? studioLaughBuilt
      : (segsToProcess || []).filter((s, i) => s.type === 'studio_laughter' && localFiles?.[i]).length;
    if (expected > 0 && built < expected) {
      blockers.push(`Studio laugh incomplete: ${built}/${expected} segments`);
    }
  }

  const ok = blockers.length === 0;
  if (ok) {
    log(`✅ Twitch Soup output verification passed${notes.length ? ` (${notes.join('; ')})` : ''}`);
  } else {
    log(`❌ Twitch Soup output verification FAILED: ${blockers.join(' | ')}`);
    if (notes.length) log(`   Notes: ${notes.join('; ')}`);
  }
  return { ok, blockers, notes };
}

function formatTimestampSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function segmentRundownLabel(seg) {
  const label = String(seg?.label || seg?.name || '').trim();
  const type = seg?.type || 'avatar';
  if (type === 'studio_laughter') return `Studio laugh — after ${seg.holdFromLabel || label.replace(/_LAUGHTER$/i, '')}`;
  if (type === 'source_clip') return `Twitch clip — ${label || 'source'}`;
  if (/^INTRO$/i.test(label)) return 'Bobby G INTRO (main show starts — cold open music cuts)';
  if (/_REACTION$/i.test(label)) return `Bobby G reaction — ${label}`;
  if (/_SETUP$/i.test(label) || /_CLIP\d+_SETUP$/i.test(label)) return `Bobby G setup — ${label}`;
  if (/^OUTRO$/i.test(label)) return 'Bobby G OUTRO';
  if (/^LACY_/i.test(label)) return label.replace(/_/g, ' ');
  if (/^JASON_/i.test(label)) return label.replace(/_/g, ' ');
  if (/^RON_/i.test(label)) return label.replace(/_/g, ' ');
  if (/^MARLON_/i.test(label)) return label.replace(/_/g, ' ');
  return label || type;
}

function segmentFeatureKey(seg) {
  const label = String(seg?.label || '').trim();
  const type = seg?.type || 'avatar';
  if (type === 'studio_laughter') return 'studio_laugh';
  if (type === 'source_clip') return 'twitch_clip';
  if (/^INTRO$/i.test(label)) return 'bobby_intro';
  if (/_REACTION$/i.test(label)) return 'bobby_reaction';
  if (/^OUTRO$/i.test(label)) return 'outro';
  return 'avatar_segment';
}

/**
 * Post-assembly QA rundown — timestamp every Soup feature before operator review.
 */
async function buildTwitchSoupPostAssemblyRundown({
  asmId,
  jobId,
  card,
  segsToProcess = [],
  segmentDurations = [],
  coldOpenSec = 0,
  bodySecBeforeCredits = null,
  creditsSec = 0,
  mainMp4Path,
  verifyResult = {},
  customerId = 'c0',
  studioLaughBuilt = null,
  studioLaughExpected = null,
}) {
  const bookCfg = loadBookendsConfig(customerId);
  const entries = [];
  const qaFeatures = [];
  let cursor = 0;

  let totalSec = bodySecBeforeCredits;
  if (mainMp4Path && fs.existsSync(mainMp4Path)) {
    try { totalSec = await probeDurationSec(mainMp4Path); } catch (_) { /* keep estimate */ }
  } else if (bodySecBeforeCredits != null && creditsSec > 0) {
    totalSec = bodySecBeforeCredits + creditsSec;
  } else if (cursor > 0) {
    totalSec = cursor + (creditsSec || 0);
  }

  if (bookCfg.coldOpen.enabled && coldOpenSec > 0) {
    entries.push({
      startSec: 0,
      endSec: coldOpenSec,
      timestamp: formatTimestampSec(0),
      endTimestamp: formatTimestampSec(coldOpenSec),
      feature: 'cold_open',
      label: 'Cold open — streamer montage + announcer VO + Forsaken opening bed',
      checks: ['montage_visuals', 'announcer_vo', 'opening_music_bed'],
    });
    qaFeatures.push({
      feature: 'cold_open',
      timestamp: formatTimestampSec(0),
      endTimestamp: formatTimestampSec(coldOpenSec),
      expected: true,
      status: coldOpenSec > 0 ? 'pass' : 'fail',
      note: 'Hard cut to Bobby G INTRO at end',
    });
    cursor = coldOpenSec;
  }

  let laughCount = 0;
  let clipCount = 0;
  for (let i = 0; i < segsToProcess.length; i++) {
    const seg = segsToProcess[i];
    const dur = Number(segmentDurations[i]) || 0;
    if (dur <= 0) continue;
    const feature = segmentFeatureKey(seg);
    const entry = {
      startSec: cursor,
      endSec: cursor + dur,
      timestamp: formatTimestampSec(cursor),
      endTimestamp: formatTimestampSec(cursor + dur),
      durationSec: Math.round(dur * 10) / 10,
      feature,
      label: segmentRundownLabel(seg),
      segmentLabel: seg.label || seg.name || null,
      checks: feature === 'studio_laugh'
        ? ['reaction_laugh_audio', 'still_frame_hold']
        : feature === 'twitch_clip'
          ? ['source_clip', 'chrome_overlay']
          : ['heygen_avatar', 'chrome_overlay'],
    };
    entries.push(entry);
    if (feature === 'studio_laugh') laughCount++;
    if (feature === 'twitch_clip') clipCount++;
    if (/^INTRO$/i.test(String(seg.label || ''))) {
      qaFeatures.push({
        feature: 'bobby_intro',
        timestamp: formatTimestampSec(cursor),
        expected: true,
        status: 'pass',
        note: 'Opening music must not bleed past this point',
      });
    }
    cursor += dur;
  }

  const creditsStart = bodySecBeforeCredits != null && bodySecBeforeCredits > 0
    ? bodySecBeforeCredits
    : cursor;
  if (bookCfg.outroCredits.enabled && creditsSec > 0) {
    entries.push({
      startSec: creditsStart,
      endSec: totalSec || creditsStart + creditsSec,
      timestamp: formatTimestampSec(creditsStart),
      endTimestamp: formatTimestampSec(totalSec || creditsStart + creditsSec),
      durationSec: creditsSec,
      feature: 'credits_outro',
      label: 'Credits outro — scroll publish description',
      checks: ['credits_scroll', 'credits_music'],
    });
    qaFeatures.push({
      feature: 'credits_outro',
      timestamp: formatTimestampSec(creditsStart),
      expected: true,
      status: verifyResult.creditsAppended !== false ? 'pass' : 'fail',
    });
  }

  if (bookCfg.coldOpen.enabled) {
    qaFeatures.push({
      feature: 'opening_music_bed',
      timestamp: '0:00',
      endTimestamp: formatTimestampSec(coldOpenSec || 0),
      expected: Number(bookCfg.coldOpen.musicVolume) > 0,
      status: coldOpenSec > 0 && Number(bookCfg.coldOpen.musicVolume) > 0 ? 'pass' : 'skip',
    });
  }

  let isStudioLaughEnabled;
  try {
    ({ isStudioLaughEnabled } = require('./studio_laughter'));
  } catch (_) { isStudioLaughEnabled = () => false; }
  const expectedLaughs = studioLaughExpected != null
    ? studioLaughExpected
    : (segsToProcess || []).filter((s) => s.type === 'studio_laughter').length;
  const builtLaughs = studioLaughBuilt != null
    ? studioLaughBuilt
    : laughCount;
  qaFeatures.push({
    feature: 'studio_laugh',
    expected: isStudioLaughEnabled(customerId),
    count: builtLaughs,
    expectedCount: expectedLaughs,
    status: !isStudioLaughEnabled(customerId)
      ? 'skip'
      : builtLaughs >= expectedLaughs && expectedLaughs > 0
        ? 'pass'
        : builtLaughs > 0 ? 'warn' : 'fail',
    timestamps: entries.filter((e) => e.feature === 'studio_laugh').map((e) => e.timestamp),
  });

  qaFeatures.push({
    feature: 'twitch_clips',
    expectedCount: (segsToProcess || []).filter((s) => s.type === 'source_clip').length,
    count: clipCount,
    status: clipCount > 0 ? 'pass' : 'fail',
  });

  qaFeatures.push({
    feature: 'decode_integrity',
    expected: true,
    status: verifyResult.decodeOk !== false ? 'pass' : 'fail',
  });

  qaFeatures.push({
    feature: 'operator_thumbnail',
    expected: true,
    status: card?.thumbnailDriveUrl || card?.operatorThumbnailPath ? 'pass' : 'warn',
    note: card?.thumbnailSource || (card?.operatorThumbnailPath ? 'operator_canva' : 'auto'),
  });

  const blockers = [...(verifyResult.blockers || [])];
  const failedFeatures = qaFeatures.filter((f) => f.status === 'fail');
  for (const f of failedFeatures) {
    blockers.push(`QA feature failed: ${f.feature}${f.timestamps ? ` (expected at ${f.timestamps.join(', ')})` : ''}`);
  }

  return {
    ok: blockers.length === 0,
    asmId,
    jobId,
    builtAt: new Date().toISOString(),
    totalDurationSec: totalSec,
    coldOpenSec,
    bodySecBeforeCredits,
    creditsSec,
    studioLaughCount: laughCount,
    twitchClipCount: clipCount,
    entries,
    qaFeatures,
    blockers,
    notes: verifyResult.notes || [],
    previewChecks: entries.map((e) => ({
      at: e.timestamp,
      listenFor: e.feature === 'cold_open'
        ? 'Announcer VO + Forsaken bed (no Bobby G voice yet)'
        : e.feature === 'studio_laugh'
          ? 'Komedia crowd laugh burst'
          : e.feature === 'bobby_intro'
            ? 'Bobby G host voice — music should be gone'
            : e.feature === 'credits_outro'
              ? 'Credits scroll + bed'
              : null,
      lookFor: e.label,
    })),
  };
}

function formatPostAssemblyRundownText(rundown) {
  if (!rundown) return '';
  const lines = [
    '═══════════════════════════════════════════════════',
    `POST-ASSEMBLY RUNDOWN — ${rundown.jobId || rundown.asmId}`,
    `Total: ${formatTimestampSec(rundown.totalDurationSec)} (${Math.round(rundown.totalDurationSec || 0)}s)`,
    rundown.ok ? 'Status: ✅ PASS — ready for operator preview' : 'Status: ❌ FAIL — fix before operator review',
    '───────────────────────────────────────────────────',
    'TIMELINE (scrub preview to these marks):',
  ];
  for (const e of rundown.entries || []) {
    lines.push(`  ${e.timestamp}–${e.endTimestamp}  [${e.feature}] ${e.label}`);
  }
  lines.push('───────────────────────────────────────────────────');
  lines.push('FEATURE QA:');
  for (const f of rundown.qaFeatures || []) {
    const extra = f.count != null ? ` (${f.count}/${f.expectedCount ?? '?'})` : '';
    const ts = f.timestamp ? ` @ ${f.timestamp}` : '';
    lines.push(`  ${f.status === 'pass' ? '✅' : f.status === 'warn' ? '⚠️' : f.status === 'skip' ? '—' : '❌'} ${f.feature}${extra}${ts}${f.note ? ` — ${f.note}` : ''}`);
  }
  if (rundown.blockers?.length) {
    lines.push('BLOCKERS:');
    for (const b of rundown.blockers) lines.push(`  • ${b}`);
  }
  lines.push('═══════════════════════════════════════════════════');
  return lines.join('\n');
}

function savePostAssemblyRundown(asmId, rundown) {
  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${asmId}_post_rundown.json`);
  fs.writeFileSync(outPath, JSON.stringify(rundown, null, 2));
  return outPath;
}

/**
 * Rebuild postAssemblyRundown by probing per-segment tmp MP4s from a prior assembly.
 * Used to backfill jobs affected by CPD-1134 (segmentDurations shadowing bug).
 */
async function rebuildPostAssemblyRundownFromTmpSegments({
  asmId,
  jobId,
  card,
  segsToProcess = [],
  coldOpenSec = 0,
  bodySecBeforeCredits = null,
  creditsSec = 0,
  mainMp4Path = null,
  verifyResult = {},
  customerId = 'c0',
  studioLaughBuilt = null,
  studioLaughExpected = null,
  tmpDir = path.join(__dirname, '..', 'tmp'),
  probeAsmId = null,
}) {
  const probePrefix = probeAsmId || asmId;
  const segmentDurations = [];
  for (let i = 0; i < segsToProcess.length; i++) {
    const prefix = `${probePrefix}_${i}_`;
    let hit = null;
    try {
      const exts = ['.mp4', '.ts'];
      for (const ext of exts) {
        const files = fs.readdirSync(tmpDir).filter((f) => (
          f.startsWith(prefix)
          && f.endsWith(ext)
          && !/_with_crowd|_muted/i.test(f)
        ));
        if (files.length) {
          files.sort();
          hit = path.join(tmpDir, files[0]);
          break;
        }
      }
    } catch (_) { /* non-fatal */ }
    if (hit && fs.existsSync(hit)) {
      try {
        segmentDurations[i] = await probeDurationSec(hit);
      } catch (_) {
        segmentDurations[i] = 0;
      }
    } else {
      segmentDurations[i] = 0;
    }
  }
  return buildTwitchSoupPostAssemblyRundown({
    asmId,
    jobId,
    card,
    segsToProcess,
    segmentDurations,
    coldOpenSec,
    bodySecBeforeCredits,
    creditsSec,
    mainMp4Path,
    verifyResult,
    customerId,
    studioLaughBuilt,
    studioLaughExpected,
  });
}

module.exports = {
  loadBookendsConfig,
  isBookendsEnabled,
  collectColdOpenClipBeats,
  buildColdOpenScriptDraft,
  sanitizeColdOpenScript,
  coldOpenPhraseFromSetup,
  generateColdOpenScript,
  generateColdOpenVo,
  resolveColdOpenBeatSlides,
  resolveColdOpenMontagePaths,
  computeMontageBeatDurations,
  wrapCreditsLines,
  coldOpenApproved,
  creditsTextFromCard,
  computeCreditsDurationSec,
  renderColdOpen,
  renderCreditsOutro,
  appendCreditsOutroToVideo,
  appendMp4TailViaTs,
  resolveMusicBed,
  probeDurationSec,
  verifyTwitchSoupPreAssembly,
  verifyTwitchSoupAssembly,
  assertTwitchSoupPublishReady,
  TWITCH_SOUP_MIN_WITH_CREDITS_SEC,
  buildTwitchSoupPostAssemblyRundown,
  formatPostAssemblyRundownText,
  savePostAssemblyRundown,
  rebuildPostAssemblyRundownFromTmpSegments,
  formatTimestampSec,
};
