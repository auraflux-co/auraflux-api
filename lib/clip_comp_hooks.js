'use strict';
/**
 * lib/clip_comp_hooks.js — Gemini-generated burned hook captions for clip comps.
 * Moment-only hooks (no streamer name on screen). Never passthrough Twitch/Kick clip titles.
 * Comp hooks analyze full clip video+audio first (not thumbnail/title guesses).
 */

const axios = require('axios');
const { stripDrawtextUnsafe } = require('./clip_comp_cards');

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

function isJunkHook(text, { streamer, clipTitle } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length < 8) return true;

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
  return false;
}

function normalizeHookLine(streamer, raw, clipTitle = '') {
  let line = stripDrawtextUnsafe(raw).replace(/^["']|["']$/g, '').trim();
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

function buildCompHookAnalysisPrompt(ctx = {}) {
  const desktop = isDesktopOrIrlStream(ctx);
  const desktopBlock = desktop
    ? `DESKTOP / IRL / JUST CHATTING clip — the Twitch thumbnail is usually misleading:
- Prioritize what is ON SCREEN (browser, app, gift, chat overlay, face reacting to something)
- Quote what the streamer SAYS verbatim when audible (short quote)
- Do NOT invent gameplay that is not visible`
    : `- Describe gameplay or on-screen action specifically
- Quote notable spoken lines exactly when audible`;

  return `This is a Twitch clip by streamer "${ctx.streamer || 'unknown'}". Category: ${ctx.game || 'unknown'}.
Platform clip title (often wrong — ignore it): "${ctx.title || ''}"
${desktopBlock}

Analyze the FULL video WITH AUDIO:
1. What exactly happens in the key moment (visual + audio together)
2. Exact short quote if they say something notable
3. Why it is funny, awkward, or surprising
Be specific and factual. 4-6 sentences. No hype language.`;
}

function buildHookFromAnalysisPrompt(ctx, analysis, { desktop = false } = {}) {
  const desktopHint = desktop
    ? '\nThis is a desktop/IRL clip — the hook must match what is seen/heard in the analysis, not the platform title.'
    : '';
  return `From this Twitch clip analysis, write ONE burned-in hook caption.

Streamer (context only — do NOT name them): ${ctx.streamer}
Platform title (DO NOT COPY): "${ctx.title || ''}"
Analysis: ${analysis.slice(0, 900)}
${desktopHint}

Format: 3-8 words, moment only — no streamer name, no colon prefix.
Describe ONE specific beat from the analysis (what happens or what they say).
Return ONLY the hook line.`;
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

async function analyzeClipVideoForHook(enriched) {
  try {
    const { geminiAnalyzeClip } = require('./script_gen');
    const ctx = buildClipContext(enriched);
    const videoUrl = resolveHookVideoUrl(enriched);
    if (!videoUrl) return '';

    const analysis = await geminiAnalyzeClip(videoUrl, enriched.thumbnailUrl, 'twitch', {
      streamer: ctx.streamer,
      game: ctx.game || '',
      title: ctx.title || '',
      pageUrl: enriched.pageUrl || enriched.url || '',
      analysisPrompt: buildCompHookAnalysisPrompt(ctx),
    });
    if (!analysis || analysis.length < 20) return '';

    const desktop = isDesktopOrIrlStream(ctx);
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{
          parts: [{
            text: buildHookFromAnalysisPrompt(ctx, analysis, { desktop }),
          }],
        }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.25 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    return (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  } catch (_) {
    return '';
  }
}

const GENERIC_FALLBACKS = [
  'Instant Classic Moment',
  'Chat Goes Wild',
  'Did Not See That Coming',
  'Peak Stream Chaos',
];

function genericFallbackHook(index = 0) {
  return GENERIC_FALLBACKS[index % GENERIC_FALLBACKS.length];
}

async function generateClipCompHook(clip, item, { log } = {}) {
  const enriched = await enrichClipForHook(clip, item);
  const ctx = buildClipContext(enriched, item);
  const junkOpts = { streamer: ctx.streamer, clipTitle: ctx.title };

  if (!GEMINI_APIKEY) {
    return normalizeHookLine(ctx.streamer, genericFallbackHook(0), ctx.title)
      || genericFallbackHook(0);
  }

  try {
    if (log) log('  🎬 Analyzing clip video+audio…');
    let raw = await analyzeClipVideoForHook({ ...enriched, ...ctx });
    let hook = normalizeHookLine(ctx.streamer, raw, ctx.title);

    if (isJunkHook(hook, junkOpts)) {
      if (log) log(`  ⚠️ Video hook rejected ("${hook || raw}") — thumbnail fallback`);
      const thumb = await downloadThumbnailBase64(ctx.thumbnailUrl);
      raw = await callGeminiForHook(ctx, thumb, { strict: true });
      hook = normalizeHookLine(ctx.streamer, raw, ctx.title);
    }
    if (isJunkHook(hook, junkOpts)) {
      const fallback = normalizeHookLine(ctx.streamer, genericFallbackHook(ctx.title?.length || 0), ctx.title)
        || genericFallbackHook(0);
      if (log) log(`  ⚠️ Using generic fallback: "${fallback}"`);
      return fallback;
    }
    if (log) log(`  🎣 Hook: "${hook}"`);
    return hook;
  } catch (err) {
    if (log) log(`  ⚠️ Hook generation failed: ${err.message}`);
    return normalizeHookLine(ctx.streamer, genericFallbackHook(0), ctx.title) || genericFallbackHook(0);
  }
}

async function generateClipCompHooks(clips, items, opts = {}) {
  const { log } = opts;
  const count = Math.max(clips.length, items?.length || 0);
  const hooks = [];
  for (let i = 0; i < count; i++) {
    const clip = clips[i] || {};
    const item = (items && items[i]) || {};
    const hook = await generateClipCompHook(clip, item, {
      log: log ? (m) => log(`Clip ${i + 1}${m}`) : null,
    });
    hooks.push(hook);
  }
  return hooks;
}

function hooksAreUsable(preGenerated, count) {
  return preGenerated
    && Array.isArray(preGenerated)
    && preGenerated.length >= count
    && preGenerated.slice(0, count).every((h) => {
      if (!h || isJunkHook(h)) return false;
      // Legacy "Streamer: moment" overlays must regenerate under moment-only rules
      if (/^\w[\w\s]{0,24}\s*:\s+\S/.test(String(h))) return false;
      return true;
    });
}

async function resolveHooksForAssembly({ hookItems = [], hookClips = [], preGenerated = null, log, forceRegenerate = false } = {}) {
  const count = hookClips.length;
  if (!forceRegenerate && hooksAreUsable(preGenerated, count)) {
    return preGenerated.slice(0, count);
  }
  return generateClipCompHooks(hookClips, hookItems, { log });
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
  resolveHooksForAssembly,
  isJunkHook,
  normalizeHookLine,
  stripStreamerPrefix,
  hookCopiesClipTitle,
  buildClipContext,
  burnedCaptionToClipLine,
  buildClipCompTitleContext,
  hooksAreUsable,
  isDesktopOrIrlStream,
  resolveHookVideoUrl,
  buildCompHookAnalysisPrompt,
};
