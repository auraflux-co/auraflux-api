'use strict';
/**
 * lib/clip_comp_hooks.js — Gemini-generated burned hook captions for clip comps.
 * Moment-only hooks (no streamer name on screen). Never passthrough Twitch/Kick clip titles.
 * Comp hooks analyze full clip video+audio first (not thumbnail/title guesses).
 */

const axios = require('axios');
const { stripDrawtextUnsafe } = require('./clip_comp_cards');
const { parseJsonLoose } = require('./gemini_json_parse');
const { buildChannelVoiceBlock } = require('./hook_training/channel_voice');
const { isOutcomeSpoilerHook, isFallbackHook, DEFAULT_GENERIC_FALLBACKS } = require('./hook_training/hook_validators');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const DESKTOP_CATEGORY_RE = /just\s*chatting|irl|talk\s*shows|always\s*on|special\s*events|art|music|asmr|food\s*&?\s*drink|makers\s*&?\s*crafting|podcasts|sports\s*talk|pools?\s*,?\s*hot\s*tubs?\s*&?\s*beaches|co-working|studios|watch\s*party|creative/i;

const JUNK_PATTERNS = [
  /^[a-z]{1,4}$/i,
  /^(wisdom|ggs|gg|uo|dsda|lol|omg|bruh|w tricksot)$/i,
  /wildest.*moments/i,
  /you won'?t believe/i,
  /can'?t miss/i,
  /best twitch clips/i,
  /twitch fun$/i,
  /^unexpected moment$/i,
  /^wild moment$/i,
  /^wild nyc moment$/i,
];

const VAGUE_HOOK_PATTERNS = [
  /^screaming faces?,?\s*pure chaos$/i,
  /^rapid game sounds?,?\s*intense face$/i,
  /^stadium silence to sudden roar$/i,
  /^reading a dm,?\s*group erupts laughing$/i,
  /^(pure|total|absolute)\s+chaos$/i,
  /^intense face$/i,
  /^sudden roar$/i,
  /^group erupts laughing$/i,
  /^that escalated fast$/i,
  /^wait for the beat$/i,
  /^the look says it all$/i,
  /^something went wrong$/i,
  /^(wild|pure|total)\s+(moment|chaos|energy)$/i,
];

const MOOD_ONLY_WORDS = new Set([
  'chaos', 'intense', 'wild', 'crazy', 'insane', 'roar', 'energy', 'moment', 'reaction', 'face', 'sounds',
]);

function observationMinChars() {
  const n = Number(process.env.CLIP_HOOK_OBS_MIN_CHARS || 120);
  if (!Number.isFinite(n)) return 120;
  return Math.max(80, Math.min(400, Math.floor(n)));
}

/** True when Gemini observation looks complete (not truncated mid-sentence). */
function isObservationComplete(obs) {
  const t = String(obs || '').trim();
  if (t.length < observationMinChars()) return false;
  if (/\b(with|the|their|and|a|an|in|on|of|to|for|he|she|they|one)\s*$/i.test(t)) return false;
  if (/,\s*$/.test(t)) return false;
  if (!/[.!?]["']?\s*$/.test(t)) return false;
  return true;
}

/** Reject generic mood-template hooks that could match any clip. */
function isVagueCompHook(hook, observation = '') {
  const t = String(hook || '').trim();
  if (!t) return true;
  for (const p of VAGUE_HOOK_PATTERNS) {
    if (p.test(t)) return true;
  }
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.every((w) => MOOD_ONLY_WORDS.has(w.replace(/[^a-z]/g, '')))) return true;
  const obs = String(observation || '').toLowerCase();
  const obsBare = obs.replace(/[^a-z0-9]/g, '');
  if (obs.length > 40) {
    const sigTokens = words
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 2 && !MOOD_ONLY_WORDS.has(w.replace(/[^a-z]/g, '')));
    if (sigTokens.length === 0) return true;
    const hasAnchor = sigTokens.some((w) => {
      if (/\d/.test(w)) return obsBare.includes(w) || obs.includes(w);
      return obsBare.includes(w) || obs.includes(w);
    });
    if (!hasAnchor && words.length <= 5) return true;
  }
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCompare(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the hook is essentially the Twitch clip title (or a fragment of it). */
function hookCopiesClipTitle(hook, clipTitle) {
  const h = normalizeCompare(hook);
  const t = normalizeCompare(clipTitle);
  if (!h || !t || t.length < 5) return false;
  if (h === t) return true;
  if (h.length >= 8 && t.includes(h)) return true;
  if (t.length >= 8 && h.includes(t)) return true;
  const hWords = h.split(' ').filter((w) => w.length > 2);
  const tWords = new Set(t.split(' ').filter((w) => w.length > 2));
  if (hWords.length >= 2) {
    const overlap = hWords.filter((w) => tWords.has(w)).length;
    if (overlap / hWords.length >= 0.75) return true;
  }
  return false;
}

function stripStreamerPrefix(line, streamer) {
  let t = String(line || '').trim();
  const name = stripDrawtextUnsafe(streamer || '').trim();
  if (!name) return t;
  const first = name.split(/\s+/)[0];
  if (!first || first.length < 2) return t;

  const colonRe = new RegExp(`^${escapeRegExp(first)}\\s*:\\s*`, 'i');
  if (colonRe.test(t)) t = t.replace(colonRe, '').trim();

  const possessiveRe = new RegExp(`^${escapeRegExp(first)}'s\\s+`, 'i');
  if (possessiveRe.test(t)) t = t.replace(possessiveRe, '').trim();

  const fullColonRe = new RegExp(`^${escapeRegExp(name)}\\s*:\\s*`, 'i');
  if (fullColonRe.test(t)) t = t.replace(fullColonRe, '').trim();

  return t;
}

function isJunkHook(text, { streamer, clipTitle, maxWords, observation } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return true;

  const wordMax = maxWords || Number(process.env.CLIP_HOOK_MAX_WORDS || 12);
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount > wordMax) return true;

  if (streamer && /^\w[\w\s]{0,20}\s*:\s*/.test(t)) {
    const prefix = t.split(':')[0].trim().toLowerCase();
    const first = String(streamer).split(/\s+/)[0].toLowerCase();
    if (prefix === first || first.startsWith(prefix) || prefix.startsWith(first)) return true;
  }

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 && t.length < 14) return true;

  if (streamer) {
    const first = String(streamer).split(/\s+/)[0].toLowerCase();
    const compact = t.toLowerCase().replace(/[^a-z]/g, '');
    if (compact === first.replace(/[^a-z]/g, '')) return true;
    if (compact.startsWith(first.replace(/[^a-z]/g, '')) && compact.length < first.length + 6) return true;
  }

  if (clipTitle && hookCopiesClipTitle(t, clipTitle)) return true;

  for (const p of JUNK_PATTERNS) {
    if (p.test(t)) return true;
  }
  if (isVagueCompHook(t, observation || '')) return true;
  return false;
}

function normalizeHookLine(streamer, raw, clipTitle = '') {
  let line = sanitizeTvClean(stripDrawtextUnsafe(raw).replace(/^["']|["']$/g, '').trim());
  line = line.replace(/^\*+|\*+$/g, '').trim();
  line = stripStreamerPrefix(line, streamer);
  if (!line) return '';
  if (clipTitle && hookCopiesClipTitle(line, clipTitle)) return '';
  return line.slice(0, 72);
}

function buildClipContext(clip = {}, item = {}) {
  return {
    streamer: clip.displayName || clip.streamer || item.displayName || item.streamer || 'Streamer',
    game: clip.game || item.game || clip.category || item.category || '',
    title: clip.title || item.title || clip.clipTitle || item.clipTitle || '',
    thumbnailUrl: clip.thumbnailUrl || item.thumbnailUrl || clip.thumbnail || item.thumbnail || '',
    viewCount: clip.viewCount || item.viewCount || clip.views || item.views || null,
    pageUrl: clip.pageUrl || item.pageUrl || clip.url || item.url || '',
    clipUrl: clip.clipUrl || clip.mp4Url || clip.url || item.clipUrl || item.url || '',
  };
}

/** Desktop / IRL / Just Chatting — thumbnail is usually misleading. */
function isDesktopOrIrlStream(ctx = {}) {
  const game = String(ctx.game || ctx.category || '').trim();
  if (!game) return true;
  if (/^\d+$/.test(game)) return true;
  return DESKTOP_CATEGORY_RE.test(game);
}

/** Prefer resolved MP4 or Twitch clip page (yt-dlp) — never thumbnail preview MP4. */
function resolveHookVideoUrl(enriched = {}) {
  const clipUrl = enriched.clipUrl || enriched.mp4Url || '';
  const pageUrl = enriched.pageUrl || '';
  const rawUrl = enriched.url || '';
  if (/clips-media|production\.clips\.twimg|\.mp4(\?|$)/i.test(clipUrl)) return clipUrl;
  if (/clips-media|\.mp4(\?|$)/i.test(rawUrl)) return rawUrl;
  if (/twitch\.tv\/\w+\/clip\//i.test(pageUrl)) return pageUrl;
  if (/twitch\.tv\/\w+\/clip\//i.test(rawUrl)) return rawUrl;
  return pageUrl || clipUrl || rawUrl;
}

const TV_CLEAN_REPLACEMENTS = [
  [/\bf+u+c+k+(?:ing|er|ed|s|t)?\b/gi, '—'],
  [/\bs+h+i+t+(?:ty|s|head)?\b/gi, '—'],
  [/\bb+i+t+c+h+(?:es|y)?\b/gi, '—'],
  [/\bp+u+s+s+y\b/gi, '—'],
  [/\bn+i+g+g+(?:er|a|as)?\b/gi, '—'],
  [/\bf[\*#@]{2,}/gi, '—'],
];

function sanitizeTvClean(text) {
  let out = String(text || '');
  for (const [re, rep] of TV_CLEAN_REPLACEMENTS) {
    re.lastIndex = 0;
    out = out.replace(re, rep);
  }
  return out.replace(/\s{2,}/g, ' ').replace(/\s+—\s+/g, ' ').trim();
}

function buildCompHookAnalysisPrompt(ctx = {}) {
  const desktop = isDesktopOrIrlStream(ctx);
  const desktopBlock = desktop
    ? `DESKTOP / IRL / JUST CHATTING — thumbnail is often misleading. Weight ON-SCREEN action (browser, gift, chat overlay, faces, props) equally with speech.`
    : `Gameplay clip — describe visible action AND reactions together.`;

  return `Twitch clip by "${ctx.streamer || 'unknown'}". Category: ${ctx.game || 'unknown'}.
Platform title (IGNORE — often wrong): "${ctx.title || ''}"
${desktopBlock}

Watch the FULL clip — video AND audio are ONE moment. Write 4-6 factual sentences covering:
1. VISUAL: who/what on screen, body language, chat overlay, setting, key action
2. AUDIO: tone, reaction sounds, and a short quote ONLY if speech is central to the beat
3. COMBINED BEAT: the single funniest, awkward, or surprising moment (visual + audio together)

Do NOT write a hook yet. Do NOT prioritize spoken words over visuals. No hype. No streamer name in the observation.`;
}

function buildVisualPassPrompt(ctx = {}) {
  const desktop = isDesktopOrIrlStream(ctx);
  return `Twitch clip by "${ctx.streamer || 'unknown'}". Category: ${ctx.game || 'unknown'}.
Platform title (IGNORE): "${ctx.title || ''}"
${desktop ? 'DESKTOP/IRL — on-screen action matters as much as speech.' : 'Gameplay — describe what happens on screen.'}

Watch the clip. VISUAL PASS ONLY — describe ONLY what you SEE:
- Who/what is on screen, body language, props, browser, chat overlay, setting
- The key visible action or reaction
3-4 factual sentences. No hook yet. No streamer name. No hype.`;
}

function buildAudioPassPrompt(ctx = {}) {
  return `Same Twitch clip. Platform title (IGNORE): "${ctx.title || ''}".

AUDIO PASS ONLY — describe ONLY what you HEAR:
- Tone, reaction sounds, laughter, silence beats
- Quote speech ONLY if words are central to the moment (max one short quote)
2-3 factual sentences. No hook yet. No streamer name. No hype.`;
}

function buildStrictRewatchPrompt(ctx = {}) {
  return `${buildCompHookAnalysisPrompt(ctx)}

STRICT REWATCH — a previous hook was rejected. Re-analyze the clip with maximum specificity.
Name the exact visual action AND audio beat together. No generic "chat goes wild" unless chat overlay is literally the beat.`;
}

function clipHookGeminiPassCount() {
  const n = Number(process.env.CLIP_HOOK_GEMINI_PASSES || 3);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

function clipHookQaMaxRetries() {
  const n = Number(process.env.CLIP_HOOK_QA_MAX_RETRIES || 2);
  if (!Number.isFinite(n)) return 2;
  return Math.max(0, Math.min(3, Math.floor(n)));
}

async function mergeObservationPasses(ctx, visual, audio, { log } = {}) {
  const v = String(visual || '').trim();
  const a = String(audio || '').trim();
  if (!v && !a) return '';
  if (!v) return a;
  if (!a) return v;
  if (!GEMINI_APIKEY) return `${v}\n\n${a}`;

  const prompt = `Merge these two observations of the SAME Twitch clip into one 4-6 sentence factual observation.

VISUAL PASS:
${v.slice(0, 700)}

AUDIO PASS:
${a.slice(0, 700)}

Platform title (IGNORE): "${ctx.title || ''}"

Rules:
- One combined beat (visual + audio together)
- No hook line yet
- No streamer name
- TV-clean, no hype
Return ONLY the merged observation.`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 45000 },
  );
  const merged = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  const combined = merged || `${v}\n\n${a}`;
  if (isObservationComplete(combined)) return combined;
  if (log && typeof log === 'function') log('  ⚠️ Merge observation truncated — retrying with higher token budget…');
  const retryResp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    {
      contents: [{ parts: [{ text: `${prompt}\n\nIMPORTANT: Write 4-6 COMPLETE sentences ending with proper punctuation.` }] }],
      generationConfig: { maxOutputTokens: 3072, temperature: 0.15 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 45000 },
  );
  const retryMerged = (retryResp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return isObservationComplete(retryMerged) ? retryMerged : (retryMerged || combined);
}

function buildHookFromObservationPrompt(ctx, observation, { desktop = false, strict = false, fixDirective = null } = {}) {
  const { buildExamplesBlock, loadHookExamples, hookMaxWords, hookTargetWords } = require('./clip_hook_machine');
  const desktopHint = desktop
    ? '\nDesktop/IRL — hook must reflect what is SEEN and heard, not the platform title.'
    : '';
  const strictHint = strict
    ? `\nSTRICT: Hyper-specific curiosity gap. Must NOT match platform title. ${hookTargetWords()} words ideal.`
    : '';
  const fixHint = fixDirective
    ? `\nPREVIOUS HOOK REJECTED BY QA — fix: ${fixDirective}`
    : '';
  const { examples, patterns } = loadHookExamples();
  return `${buildChannelVoiceBlock()}

${buildExamplesBlock({ examples, patterns })}

Write ONE burned-in on-screen hook from this observation (visual + audio beat together).

Streamer (context only — do NOT name them): ${ctx.streamer}
Platform title (DO NOT COPY): "${ctx.title || ''}"
Observation: ${observation.slice(0, 900)}
${desktopHint}${strictHint}${fixHint}

Rules:
- ONE line (two lines ONLY if absolutely necessary; max 72 characters total)
- ${hookTargetWords()} words ideal, ${hookMaxWords()} words maximum — moment only, no streamer name, no colon prefix
- Curiosity gap: tease the setup — do NOT give away the punchline or full outcome
- Pattern interrupt or high-energy tease — not generic compilation filler
- Must reflect VISUAL action AND audio together
- TV-clean: no profanity, slurs, or sexual terms (YouTube Shorts policy)
- Do NOT copy the platform clip title
Return ONLY the hook line.`;
}

function buildHookFromAnalysisPrompt(ctx, analysis, opts = {}) {
  return buildHookFromObservationPrompt(ctx, analysis, opts);
}

function parseGeminiJsonBlock(raw) {
  return parseJsonLoose(raw);
}

async function enrichClipForHook(clip = {}, item = {}) {
  const merged = { ...item, ...clip };
  if (merged.thumbnailUrl && merged.game) return merged;

  const pageUrl = merged.pageUrl || merged.url || '';
  if (!pageUrl || !process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_TOKEN) {
    return merged;
  }

  try {
    const TwitchClient = require('./clients/twitch_client');
    const twitch = new TwitchClient();
    const slug = twitch.extractSlug(pageUrl);
    if (!slug) return merged;
    const helix = await twitch.getClipById(slug);
    return {
      ...merged,
      thumbnailUrl: merged.thumbnailUrl || helix.thumbnail_url || '',
      game: merged.game || helix.game_id || '',
      viewCount: merged.viewCount || merged.views || helix.view_count || null,
      title: merged.title || helix.title || '',
      displayName: merged.displayName || helix.broadcaster_name || merged.streamer || '',
      streamer: merged.streamer || helix.broadcaster_name || merged.displayName || '',
      pageUrl: pageUrl || merged.pageUrl || '',
    };
  } catch (_) {
    return merged;
  }
}

async function downloadThumbnailBase64(thumbnailUrl) {
  if (!thumbnailUrl) return null;
  try {
    const resp = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 12000 });
    const mimeType = (resp.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    return { data: Buffer.from(resp.data).toString('base64'), mimeType };
  } catch (_) {
    return null;
  }
}

async function callGeminiForHook(ctx, thumb, { strict = false } = {}) {
  const strictLine = strict
    ? '\nSTRICT: 3-8 words describing ONE specific beat. No streamer name. Must NOT match or paraphrase the platform clip title.'
    : '';
  const desktopHint = isDesktopOrIrlStream(ctx)
    ? '\nDesktop/IRL stream — describe on-screen action or spoken beat, not generic reactions.'
    : '';
  const prompt = `You write burned-in hook captions for a Twitch clip compilation YouTube Short.

Streamer (for context only — do NOT put their name in the hook): ${ctx.streamer}
${ctx.game ? `Game/category: ${ctx.game}` : ''}
${ctx.viewCount ? `Views: ${ctx.viewCount}` : ''}
Platform clip title (DO NOT COPY OR PARAPHRASE — often misleading junk): "${ctx.title || 'unknown'}"

${thumb ? 'Study the thumbnail image.' : 'No thumbnail — infer a plausible specific funny/weird moment from context only.'}

OUTPUT RULES (strict):
- ONE line only: 3-8 words, Title Case or sentence case — the moment beat only
- WINNERS: "Wrong Shirt Gift", "Back for the Old Clips", "Miami Food Meltdown", "Tequila Shot Face"
- NEVER include the streamer's name or login in the hook text
- NEVER use "Streamer:" or any colon-prefix format
- NEVER copy or lightly reword the platform clip title
- NEVER generic compilation filler ("Wildest Moments", "You Won't Believe", roster lists)
- NEVER output single words, abbreviations, or junk like "wisdom", "GGs", "dsda", "uo"
- Be concrete about ONE beat — embarrassment, surprise, fail, gift gone wrong, etc.${desktopHint}${strictLine}

Return ONLY the hook line. No quotes, no explanation.`;

  const parts = [{ text: prompt }];
  if (thumb) {
    parts.push({ inline_data: { mime_type: thumb.mimeType, data: thumb.data } });
  }

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    { contents: [{ parts }], generationConfig: { maxOutputTokens: 512, temperature: strict ? 0.2 : 0.4 } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
  );
  return (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function analyzeClipObservation(enriched, item) {
  const ctx = buildClipContext(enriched, item);
  const videoUrl = resolveHookVideoUrl(enriched);
  if (!videoUrl || !GEMINI_APIKEY) return '';

  const { geminiAnalyzeClip } = require('./script_gen');
  const analysis = await geminiAnalyzeClip(videoUrl, enriched.thumbnailUrl, 'twitch', {
    streamer: ctx.streamer,
    game: ctx.game || '',
    title: ctx.title || '',
    pageUrl: enriched.pageUrl || enriched.url || '',
    analysisPrompt: buildCompHookAnalysisPrompt(ctx),
  });
  return String(analysis || '').trim();
}

async function analyzeClipObservationMultiPass(enriched, item, { log } = {}) {
  const ctx = buildClipContext(enriched, item);
  const videoUrl = resolveHookVideoUrl(enriched);
  if (!videoUrl || !GEMINI_APIKEY) return '';

  const passes = clipHookGeminiPassCount();
  if (passes <= 1) {
    return analyzeClipObservation(enriched, item);
  }

  const { openGeminiClipSession } = require('./script_gen');
  const meta = {
    streamer: ctx.streamer,
    game: ctx.game || '',
    title: ctx.title || '',
    pageUrl: enriched.pageUrl || enriched.url || '',
  };

  let session;
  try {
    session = await openGeminiClipSession(videoUrl, enriched.thumbnailUrl, 'twitch', meta);
    if (!session.available) return '';

    if (log) log('  🎬 Gemini pass 1 — visual…');
    const visual = await session.query(buildVisualPassPrompt(ctx));
    if (log) log('  🎬 Gemini pass 2 — audio…');
    const audio = await session.query(buildAudioPassPrompt(ctx));
    await session.close();
    session = null;

    let observation;
    if (passes >= 3) {
      if (log) log('  🎬 Gemini pass 3 — merge observation…');
      observation = await mergeObservationPasses(ctx, visual, audio, { log });
    } else {
      observation = [visual, audio].filter(Boolean).join('\n\n');
    }
    if (observation && !isObservationComplete(observation)) {
      if (log) log('  ⚠️ Observation incomplete after multi-pass — strict rewatch…');
      const rewatch = await strictVideoRewatchObservation(enriched, item, { log });
      if (rewatch && isObservationComplete(rewatch)) observation = rewatch;
    }
    return observation;
  } catch (err) {
    if (log) log(`  ⚠️ Multi-pass observation failed: ${err.message}`);
    return analyzeClipObservation(enriched, item);
  } finally {
    if (session) await session.close();
  }
}

async function strictVideoRewatchObservation(enriched, item, { log } = {}) {
  const ctx = buildClipContext(enriched, item);
  const videoUrl = resolveHookVideoUrl(enriched);
  if (!videoUrl || !GEMINI_APIKEY) return '';

  const { openGeminiClipSession } = require('./script_gen');
  let session;
  try {
    if (log) log('  🔁 Strict video rewatch…');
    session = await openGeminiClipSession(videoUrl, enriched.thumbnailUrl, 'twitch', {
      streamer: ctx.streamer,
      game: ctx.game || '',
      title: ctx.title || '',
      pageUrl: enriched.pageUrl || enriched.url || '',
    });
    if (!session.available) return '';
    return session.query(buildStrictRewatchPrompt(ctx), { temperature: 0.15 });
  } catch (err) {
    if (log) log(`  ⚠️ Strict rewatch failed: ${err.message}`);
    return '';
  } finally {
    if (session) await session.close();
  }
}

async function writeHookFromObservation(ctx, observation, { strict = false, fixDirective = null } = {}) {
  if (!observation || observation.length < 20 || !GEMINI_APIKEY) return '';
  const desktop = isDesktopOrIrlStream(ctx);
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
    {
      contents: [{ parts: [{ text: buildHookFromObservationPrompt(ctx, observation, { desktop, strict, fixDirective }) }] }],
      generationConfig: { maxOutputTokens: 512, temperature: strict ? 0.15 : 0.25 },
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 25000 },
  );
  return (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function produceHookWithQa(ctx, observation, junkOpts, { log, clipIndex = 0 } = {}) {
  const { claudeClipHookQA } = require('./gates/clip_hook_qa');
  const {
    generateHookCandidates,
    sortHookCandidates,
    hookMaxWords,
    hookTargetWords,
    hookCandidateCount,
    normalizeCandidate,
  } = require('./clip_hook_machine');
  const maxRetries = clipHookQaMaxRetries();
  let hook = '';
  let hookQa = { passed: false, score: 0, violations: [], attempts: 0 };
  let fixDirective = null;
  let hookCandidates = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!observation) break;
    if (!isObservationComplete(observation)) {
      if (log) log('  ⚠️ Observation too short or truncated — hook quality blocked until rewatch');
      fixDirective = 'Observation incomplete — write hook from a specific visible object or spoken detail only.';
      if (attempt >= maxRetries) break;
      continue;
    }
    junkOpts.observation = observation;

    if (log) log(`  🎯 Hook Machine — ${attempt === 0 ? 'generating ranked candidates' : `retry ${attempt + 1}`}…`);
    const { candidates, rawCount } = await generateHookCandidates(ctx, observation, { fixDirective, log });
    hookCandidates = sortHookCandidates(candidates).map((c) => normalizeCandidate(c));

    if (log && hookCandidates[0]) {
      const c0 = hookCandidates[0];
      log(`  📊 Rank #1: "${c0.text}" [${c0.formula || '?'}] (tension ${c0.tensionScore || '?'}) — ${(c0.why || '').slice(0, 60)}`);
    }
    if (log && rawCount === 0) log('  ⚠️ Hook Machine returned no candidates — single-shot fallback');

    const isUsable = (text) => {
      const normalized = normalizeHookLine(ctx.streamer, text, ctx.title);
      if (!normalized) return false;
      if (isFallbackHook(normalized, GENERIC_FALLBACKS)) return false;
      if (isOutcomeSpoilerHook(normalized)) return false;
      const words = normalized.split(/\s+/).filter(Boolean).length;
      if (words > hookMaxWords()) return false;
      return !isJunkHook(normalized, { ...junkOpts, observation });
    };

    let qaWinner = null;
    const qaBatch = hookCandidates.slice(0, hookCandidateCount());
    for (const cand of qaBatch) {
      const normalized = normalizeHookLine(ctx.streamer, cand.text, ctx.title);
      if (!isUsable(normalized)) continue;

      const qa = await claudeClipHookQA({
        observation,
        hook: normalized,
        platformTitle: ctx.title,
        streamer: ctx.streamer,
        clipIndex,
        candidateMeta: cand,
      });
      cand.text = normalized;
      cand.qaScore = qa.score;
      cand.qaPassed = qa.passed;

      if (qa.passed) {
        qaWinner = { hook: normalized, hookQa: { ...qa, attempts: attempt + 1 }, cand };
        break;
      }
      if (!fixDirective && qa.fixDirective) fixDirective = qa.fixDirective;
      if (log) log(`  ⚠️ Candidate fail (${qa.score}): "${normalized}" — ${(qa.violations || []).slice(0, 1).join('; ')}`);
    }

    if (qaWinner) {
      hookCandidates = hookCandidates.map((c) => ({
        ...c,
        selected: c.text === qaWinner.cand.text && c.rank === qaWinner.cand.rank,
      }));
      if (log) log(`  ✅ Hook QA pass (${qaWinner.hookQa.score}): "${qaWinner.hook}"`);
      return { hook: qaWinner.hook, hookQa: qaWinner.hookQa, hookCandidates };
    }

    let rawHook = '';
    if (qaBatch.length) {
      rawHook = await writeHookFromObservation(ctx, observation, {
        strict: attempt > 0,
        fixDirective,
      });
    }

    hook = normalizeHookLine(ctx.streamer, rawHook, ctx.title);
    hookQa.attempts = attempt + 1;

    if (hook && isUsable(hook)) {
      hookQa = { ...hookQa, ...(await claudeClipHookQA({
        observation,
        hook,
        platformTitle: ctx.title,
        streamer: ctx.streamer,
        clipIndex,
      })) };
      hookQa.attempts = attempt + 1;
      if (hookQa.passed) {
        if (log) log(`  ✅ Hook QA pass (${hookQa.score}): "${hook}" (fallback writer)`);
        return { hook, hookQa, hookCandidates };
      }
    }

    if (isJunkHook(hook, { ...junkOpts, observation }) || isFallbackHook(hook, GENERIC_FALLBACKS)) {
      if (log) log(`  ⚠️ Hook rejected locally ("${hook || rawHook}")`);
      fixDirective = fixDirective || `Specific curiosity gap — ${hookTargetWords()} words ideal, ${hookMaxWords()} max. Name a concrete object/action from the observation. No mood-only filler or outcome spoilers.`;
      continue;
    }

    if (log) log(`  ⚠️ Claude hook QA fail (${hookQa.score}): ${(hookQa.violations || []).slice(0, 2).join('; ')}`);
    fixDirective = hookQa.fixDirective
      || `Rewrite with curiosity gap — ${hookTargetWords()} words ideal, ${hookMaxWords()} max. Tease setup, not punchline.`;
  }

  return { hook, hookQa, hookCandidates };
}

async function analyzeClipMomentBundle(clip, item, { log, clipIndex = 0 } = {}) {
  const enriched = await enrichClipForHook(clip, item);
  const ctx = buildClipContext(enriched, item);
  const junkOpts = { streamer: ctx.streamer, clipTitle: ctx.title, observation: '' };

  let observation = '';
  let hook = '';
  let hookQa = null;
  let hookCandidates = [];

  try {
    if (log) log('  🎬 Analyzing clip (multi-pass visual + audio)…');
    observation = await analyzeClipObservationMultiPass(enriched, item, { log });

    if (observation && !isObservationComplete(observation)) {
      if (log) log('  🔁 Observation truncated — strict video rewatch before hooks…');
      const rewatchObs = await strictVideoRewatchObservation(enriched, item, { log });
      if (rewatchObs && isObservationComplete(rewatchObs)) observation = rewatchObs;
    }

    if (observation) {
      junkOpts.observation = observation;
      const result = await produceHookWithQa(ctx, observation, junkOpts, { log, clipIndex });
      hook = result.hook;
      hookQa = result.hookQa;
      hookCandidates = result.hookCandidates || [];
    }

    if (isJunkHook(hook, { ...junkOpts, observation }) || (hookQa && !hookQa.passed)) {
      if (log) log('  🔁 Hook still weak — strict video rewatch + retry…');
      const rewatch = await strictVideoRewatchObservation(enriched, item, { log });
      if (rewatch) {
        observation = rewatch;
        const retry = await produceHookWithQa(ctx, observation, junkOpts, { log, clipIndex });
        hook = retry.hook;
        hookQa = retry.hookQa;
        hookCandidates = retry.hookCandidates || hookCandidates;
      }
    }

    if (isJunkHook(hook, { ...junkOpts, observation }) || isFallbackHook(hook, GENERIC_FALLBACKS)) {
      hook = normalizeHookLine(ctx.streamer, genericFallbackHook(ctx.title?.length || 0), ctx.title)
        || genericFallbackHook(0);
      if (log) log(`  ⚠️ Using generic fallback: "${hook}"`);
      hookQa = { passed: false, score: 0, violations: ['generic_fallback'], attempts: hookQa?.attempts || 0 };
    } else if (log && hook) {
      log(`  🎣 Hook: "${hook}"`);
    }
  } catch (err) {
    if (log) log(`  ⚠️ Clip analysis failed: ${err.message}`);
    hook = normalizeHookLine(ctx.streamer, genericFallbackHook(0), ctx.title) || genericFallbackHook(0);
    hookQa = { passed: false, score: 0, violations: [err.message], attempts: 0 };
  }

  return {
    streamer: ctx.streamer,
    displayName: enriched.displayName || ctx.streamer,
    platformTitle: ctx.title || '',
    game: ctx.game || '',
    observation: observation || `Moment from ${ctx.streamer} (analysis unavailable).`,
    hook,
    hookQa,
    hookCandidates,
  };
}

async function analyzeClipVideoForHook(enriched) {
  const bundle = await analyzeClipMomentBundle(enriched, enriched, {});
  return bundle.hook;
}

const GENERIC_FALLBACKS = DEFAULT_GENERIC_FALLBACKS;

function genericFallbackHook(index = 0) {
  return GENERIC_FALLBACKS[index % GENERIC_FALLBACKS.length];
}

async function generateClipCompHook(clip, item, { log } = {}) {
  const bundle = await analyzeClipMomentBundle(clip, item, { log });
  return bundle.hook;
}

async function pickLeadStreamerAndTitle(clipEntries, { isComp = false, log, compCreative = null } = {}) {
  const count = clipEntries.length;
  if (compCreative?.hooks?.rankedList?.enabled) {
    const { buildRankedListTitleDraft } = require('./clip_comp_titles');
    const draft = buildRankedListTitleDraft(compCreative) || 'Top 5 Funniest Streamer Moments — Wait for #1';
    const name = String(compCreative.hooks.rankedList.streamer || '').trim()
      || clipEntries[0]?.displayName
      || clipEntries[0]?.streamer
      || 'Streamer';
    const slotCount = Math.max(2, Number(compCreative.hooks.rankedList.slotCount) || 5);
    if (log) log(`  🏆 Ranked list title seed: "${draft.slice(0, 60)}"`);
    return {
      leadClipIndex: 0,
      leadStreamer: name,
      leadTitleDraft: draft.slice(0, 72),
      leadReason: `Ranked Top ${slotCount} countdown — title must use ranked/list framing, not single-moment comp copy.`,
    };
  }
  if (!count) {
    return { leadClipIndex: 0, leadStreamer: 'Streamer', leadTitleDraft: 'Viral Twitch Moment' };
  }
  if (count === 1) {
    const c = clipEntries[0];
    const name = c.displayName || c.streamer || 'Streamer';
    const moment = burnedCaptionToClipLine(c.hook) || 'Clip Highlight';
    return {
      leadClipIndex: 0,
      leadStreamer: name,
      leadTitleDraft: sanitizeTvClean(`${name}'s ${moment}`).slice(0, 72),
      leadReason: 'Single-clip short — lead is the only clip.',
    };
  }

  if (!GEMINI_APIKEY) {
    const c = clipEntries[0];
    const name = c.displayName || c.streamer || 'Streamer';
    return {
      leadClipIndex: 0,
      leadStreamer: name,
      leadTitleDraft: `${name}'s Highlight and more...`,
      leadReason: 'Fallback — first clip.',
    };
  }

  const summary = clipEntries.map((c, i) => (
    `CLIP ${i + 1} — ${c.displayName || c.streamer}\n`
    + `  Observation: ${(c.observation || '').slice(0, 320)}\n`
    + `  Burned hook: ${c.hook || '(none)'}`
  )).join('\n\n');

  const prompt = `You are picking the LEAD streamer and YouTube Shorts title for a Twitch clip compilation.

${summary}

Pick the clip with the strongest click potential (specific moment beats roster filler).
Write a YouTube title DRAFT (ChatGPT will refine for SEO next):
- Feature the LEAD streamer's name (login or display) naturally — not "Name:" prefix
- Describe THEIR specific moment from the observation — not generic "funny twitch clips"
- Multi-clip comp: end with " and more..." (before any #Shorts — omit #Shorts here)
- Max 72 characters, TV-clean (no profanity/slurs)
- Do NOT copy burned hook text verbatim; rewrite for title CTR

Return ONLY JSON:
{"leadClipIndex":0,"leadStreamer":"name","leadTitleDraft":"...","leadReason":"one sentence"}`;

  try {
    let raw = '';
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
        {
          contents: [{ parts: [{ text: attempt === 0 ? prompt : `${prompt}\n\nReturn ONLY minified JSON. No markdown fences.` }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.3 },
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 35000 },
      );
      raw = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      parsed = parseGeminiJsonBlock(raw);
      if (parsed && parsed.leadTitleDraft) break;
      if (log && attempt === 0) log('  ⚠️ Lead title JSON parse failed — retrying');
    }
    if (parsed && parsed.leadTitleDraft) {
      let idx = Number(parsed.leadClipIndex);
      if (!Number.isFinite(idx) || idx < 0 || idx >= count) idx = 0;
      const draft = sanitizeTvClean(String(parsed.leadTitleDraft || '').trim());
      const withMore = isComp && !/and more/i.test(draft) ? `${draft.replace(/\.\.\.$/, '')} and more...` : draft;
      if (log) log(`  🏷 Lead: ${parsed.leadStreamer || clipEntries[idx].displayName} — "${withMore.slice(0, 60)}"`);
      return {
        leadClipIndex: idx,
        leadStreamer: parsed.leadStreamer || clipEntries[idx].displayName || clipEntries[idx].streamer,
        leadTitleDraft: withMore.slice(0, 72),
        leadReason: parsed.leadReason || parsed.reason || '',
      };
    }
  } catch (err) {
    if (log) log(`  ⚠️ Lead title pick failed: ${err.message}`);
  }

  const c0 = clipEntries[0];
  const name = c0.displayName || c0.streamer || 'Streamer';
  return {
    leadClipIndex: 0,
    leadStreamer: name,
    leadTitleDraft: `${name}'s Highlight and more...`,
    leadReason: 'Fallback after lead pick error.',
  };
}

/**
 * Full Gemini creative brief: per-clip observations + hooks + lead title draft.
 * Passed to ChatGPT for SEO refinement at publish-copy time.
 */
async function generateClipCompCreativeBrief(clips, items, opts = {}) {
  const { log } = opts;
  const count = Math.max(clips.length, items?.length || 0);
  const clipEntries = [];
  for (let i = 0; i < count; i++) {
    const clip = clips[i] || {};
    const item = (items && items[i]) || {};
    const bundle = await analyzeClipMomentBundle(clip, item, {
      log: log ? (m) => log(`Clip ${i + 1}${m}`) : null,
      clipIndex: i,
    });
    clipEntries.push({ index: i, ...bundle });
  }
  const isComp = count > 1;
  const lead = await pickLeadStreamerAndTitle(clipEntries, { isComp, log, compCreative: opts.compCreative || null });
  return {
    clipCount: count,
    isComp,
    leadClipIndex: lead.leadClipIndex,
    leadStreamer: lead.leadStreamer,
    leadTitleDraft: lead.leadTitleDraft,
    leadReason: lead.leadReason || '',
    clips: clipEntries,
    generatedAt: new Date().toISOString(),
  };
}

const CLIP_COMP_BRIEF_TIMEOUT_DEFAULT_MS = 180000;
const CLIP_COMP_BRIEF_TIMEOUT_MIN_MS = 15000;

function clipCompBriefTimeoutMs() {
  const raw = process.env.CLIP_COMP_BRIEF_TIMEOUT_MS;
  const parsed = parseInt(raw || String(CLIP_COMP_BRIEF_TIMEOUT_DEFAULT_MS), 10)
    || CLIP_COMP_BRIEF_TIMEOUT_DEFAULT_MS;
  if (raw != null && String(raw).trim() !== '') return Math.max(1, parsed);
  return Math.max(CLIP_COMP_BRIEF_TIMEOUT_MIN_MS, parsed);
}

/**
 * Title-based hooks when Gemini brief stalls or errors — assembly must still run.
 */
async function buildFallbackClipCompBrief(clips, items, opts = {}) {
  const { log, compCreative = null } = opts;
  const count = Math.max(clips.length, items?.length || 0);
  const clipEntries = [];
  for (let i = 0; i < count; i++) {
    const clip = clips[i] || {};
    const item = (items && items[i]) || {};
    const ctx = buildClipContext(clip, item);
    const hook = normalizeHookLine(ctx.streamer, genericFallbackHook(i), ctx.title)
      || genericFallbackHook(i);
    if (log) log(`  ⚠️ Fallback hook clip ${i + 1}: "${hook}"`);
    clipEntries.push({
      index: i,
      streamer: ctx.streamer,
      displayName: item.displayName || clip.displayName || ctx.streamer,
      platformTitle: ctx.title || '',
      game: ctx.game || '',
      observation: `Moment from ${ctx.streamer} (Gemini brief skipped — using title fallback).`,
      hook,
      hookQa: { passed: false, score: 0, violations: ['fallback_brief'], attempts: 0 },
    });
  }
  const isComp = count > 1;
  const lead = await pickLeadStreamerAndTitle(clipEntries, { isComp, log, compCreative });
  return {
    clipCount: count,
    isComp,
    leadClipIndex: lead.leadClipIndex,
    leadStreamer: lead.leadStreamer,
    leadTitleDraft: lead.leadTitleDraft,
    leadReason: lead.leadReason || 'fallback_brief',
    clips: clipEntries,
    generatedAt: new Date().toISOString(),
    fallbackBrief: true,
  };
}

/**
 * Race Gemini brief generation against a timeout; never throw — always returns a brief.
 */
async function generateClipCompCreativeBriefWithTimeout(clips, items, opts = {}) {
  const { log } = opts;
  let timer;
  const timeoutMs = clipCompBriefTimeoutMs();
  try {
    const briefPromise = module.exports.generateClipCompCreativeBrief(clips, items, opts);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Creative brief timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([briefPromise, timeoutPromise]);
  } catch (err) {
    if (log) log(`  ⚠️ Brief generation failed (${err.message}) — using title fallback hooks`);
    return buildFallbackClipCompBrief(clips, items, opts);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generateClipCompHooks(clips, items, opts = {}) {
  const brief = await generateClipCompCreativeBrief(clips, items, opts);
  return brief.clips.map((c) => c.hook);
}

function briefHooksAreQaReady(preBrief, count) {
  if (!preBrief?.clips?.length) return false;
  const clips = preBrief.clips.slice(0, count);
  if (clips.length < count) return false;
  return clips.every((c) => c.hook
    && c.hookQa?.passed === true
    && !isFallbackHook(c.hook, GENERIC_FALLBACKS)
    && !isOutcomeSpoilerHook(c.hook));
}

function hooksAreUsable(preGenerated, count, { brief = null } = {}) {
  if (brief && briefHooksAreQaReady(brief, count)) return true;
  return preGenerated
    && Array.isArray(preGenerated)
    && preGenerated.length >= count
    && preGenerated.slice(0, count).every((h) => {
      if (!h || isJunkHook(h)) return false;
      if (isFallbackHook(h, GENERIC_FALLBACKS)) return false;
      if (isOutcomeSpoilerHook(h)) return false;
      if (/^\w[\w\s]{0,24}\s*:\s+\S/.test(String(h))) return false;
      return true;
    });
}

async function resolveHooksForAssembly({ hookItems = [], hookClips = [], preGenerated = null, preBrief = null, log, forceRegenerate = false } = {}) {
  const count = hookClips.length;
  if (!forceRegenerate && preBrief && briefHooksAreQaReady(preBrief, count)) {
    if (log) log('  ✓ Using generate-time hooks (QA passed — skipping assembly regen)');
    return { hooks: preBrief.clips.slice(0, count).map((c) => c.hook), brief: preBrief };
  }
  if (!forceRegenerate && preBrief && hooksAreUsable(preBrief.clips?.map((c) => c.hook) || preGenerated, count, { brief: preBrief })) {
    return { hooks: preBrief.clips.slice(0, count).map((c) => c.hook), brief: preBrief };
  }
  if (!forceRegenerate && hooksAreUsable(preGenerated, count)) {
    const hooks = preGenerated.slice(0, count);
    const brief = buildBriefFromHooks(hookClips, hookItems, hooks);
    return { hooks, brief };
  }
  const brief = await generateClipCompCreativeBrief(hookClips, hookItems, { log });
  return { hooks: brief.clips.map((c) => c.hook), brief };
}

/** Reconstruct a minimal brief when only legacy hook strings exist on the card. */
function buildBriefFromHooks(clips, items, hooks) {
  const clipEntries = hooks.map((hook, i) => {
    const clip = clips[i] || {};
    const item = (items && items[i]) || {};
    const ctx = buildClipContext(clip, item);
    return {
      index: i,
      streamer: ctx.streamer,
      displayName: clip.displayName || ctx.streamer,
      platformTitle: ctx.title || '',
      observation: `Burned hook: ${hook}`,
      hook,
    };
  });
  const leadIdx = 0;
  const lead = clipEntries[leadIdx] || {};
  const name = lead.displayName || lead.streamer || 'Streamer';
  return {
    clipCount: clipEntries.length,
    isComp: clipEntries.length > 1,
    leadClipIndex: leadIdx,
    leadStreamer: name,
    leadTitleDraft: clipEntries.length > 1 ? `${name}'s Highlight and more...` : `${name}'s Highlight`,
    leadReason: 'Reconstructed from saved hooks.',
    clips: clipEntries,
    generatedAt: new Date().toISOString(),
  };
}

/** Structured handoff for ChatGPT publish-copy (refine — do not ignore). */
function buildClipCompSeoInput(brief, compCreative = null) {
  if (!brief || !Array.isArray(brief.clips)) return '';
  const lines = [
    'GEMINI CREATIVE BRIEF — factual source for SEO copy (ChatGPT refines this):',
  ];

  if (compCreative?.hooks?.rankedList?.enabled) {
    const { buildRankedListHeader, buildRankedListTitleDraft } = require('./clip_comp_titles');
    const rl = compCreative.hooks.rankedList;
    const slotCount = Math.max(2, Number(rl.slotCount) || 5);
    const streamer = String(rl.streamer || brief.leadStreamer || 'Streamer').trim();
    const titleSeed = buildRankedListTitleDraft(compCreative) || brief.leadTitleDraft || '';
    lines.push(
      'VIDEO FORMAT: Stream Serpent ranked countdown list — NOT a generic highlight reel or single-moment comp.',
      `On-screen header burned in video: ${buildRankedListHeader(compCreative)}`,
      `Required YouTube title framing (use as bestTitle seed): "${titleSeed}"`,
      `Description MUST open with Top ${slotCount} / ranked countdown language for ${streamer}'s ${rl.theme || 'funniest'} moments — tease the #1 payoff.`,
      '',
    );
  }

  lines.push(
    `Lead streamer: ${brief.leadStreamer || 'unknown'}`,
    `Lead title draft (improve for CTR/SEO — use as seed for bestTitle): ${brief.leadTitleDraft || ''}`,
    brief.leadReason ? `Why lead: ${brief.leadReason}` : '',
    `Clips: ${brief.clipCount || brief.clips.length}${brief.isComp ? ' (compilation)' : ' (solo short)'}`,
    '',
  );
  for (const c of brief.clips) {
    lines.push(`CLIP ${(c.index ?? 0) + 1} — ${c.displayName || c.streamer || 'Streamer'}`);
    if (c.platformTitle) lines.push(`  Platform title (do not reuse): "${c.platformTitle}"`);
    lines.push(`  Observation (visual+audio): ${(c.observation || '').slice(0, 500)}`);
    lines.push(`  Burned on-screen hook: ${c.hook || '(none)'}`);
    lines.push('');
  }
  lines.push('ChatGPT: Rewrite lead title for YouTube Shorts CTR. Write description, tags, hashtags from observations. TV-clean metadata — no heavy profanity.');
  if (compCreative?.hooks?.rankedList?.enabled) {
    lines.push('Ranked list: title + description MUST say Top N / ranked / countdown — do NOT treat this as a single viral moment with "and more..." only.');
  }
  return lines.filter(Boolean).join('\n');
}

/** Legacy "Streamer: moment" captions → moment only for title context. */
function burnedCaptionToClipLine(burnedCaption) {
  const t = String(burnedCaption || '').trim();
  if (!t.includes(':')) return t;
  const moment = t.slice(t.indexOf(':') + 1).trim();
  return moment || t;
}

/** GPT context for rewritten YouTube titles — moment lines only, not raw Twitch titles. */
function buildClipCompTitleContext(clips, burnedCaptions) {
  return clips.map((c, i) => {
    const moment = burnedCaptionToClipLine(burnedCaptions[i] || '');
    const name = c.displayName || c.streamer || 'clip';
    const twitchTitle = c.title || c.clipTitle || '';
    const titleNote = twitchTitle ? ` (platform title was "${twitchTitle}" — do not reuse)` : '';
    return moment
      ? `CLIP ${i + 1} (${name}): ${moment}${titleNote}`
      : `CLIP ${i + 1} (${name}): untitled clip${titleNote}`;
  }).join('\n');
}

module.exports = {
  generateClipCompHook,
  generateClipCompHooks,
  generateClipCompCreativeBrief,
  generateClipCompCreativeBriefWithTimeout,
  buildFallbackClipCompBrief,
  resolveHooksForAssembly,
  isJunkHook,
  normalizeHookLine,
  sanitizeTvClean,
  stripStreamerPrefix,
  hookCopiesClipTitle,
  buildClipContext,
  burnedCaptionToClipLine,
  buildClipCompTitleContext,
  buildClipCompSeoInput,
  buildBriefFromHooks,
  hooksAreUsable,
  briefHooksAreQaReady,
  isOutcomeSpoilerHook,
  isFallbackHook,
  isDesktopOrIrlStream,
  resolveHookVideoUrl,
  buildCompHookAnalysisPrompt,
  buildVisualPassPrompt,
  buildAudioPassPrompt,
  clipHookGeminiPassCount,
  clipHookQaMaxRetries,
  mergeObservationPasses,
  produceHookWithQa,
  pickLeadStreamerAndTitle,
  isVagueCompHook,
  isObservationComplete,
  observationMinChars,
};
