'use strict';
/**
 * lib/clip_comp_hooks.js — Gemini-generated burned hook captions for clip comps.
 * Never passthrough Twitch/Kick clip titles — creative CWN hooks only.
 */

const axios = require('axios');
const { stripDrawtextUnsafe } = require('./clip_comp_cards');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const JUNK_PATTERNS = [
  /^[a-z]{1,4}$/i,
  /^(wisdom|ggs|gg|uo|dsda|lol|omg|bruh|w tricksot)$/i,
  /wildest.*moments/i,
  /you won'?t believe/i,
  /can'?t miss/i,
  /best twitch clips/i,
  /twitch fun$/i,
];

function isJunkHook(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 12) return true;
  if (!t.includes(':')) return true;

  const colonIdx = t.indexOf(':');
  const streamerPart = t.slice(0, colonIdx).trim();
  const momentPart = t.slice(colonIdx + 1).trim();
  if (!momentPart || momentPart.length < 5) return true;
  if (/^unexpected moment$/i.test(momentPart)) return true;

  const momentWords = momentPart.split(/\s+/).filter(Boolean);
  if (momentWords.length < 2 && momentPart.length < 14) return true;

  const streamerLower = streamerPart.toLowerCase().replace(/\s+/g, '');
  const momentLower = momentPart.toLowerCase().replace(/\s+/g, '');
  if (streamerLower.startsWith(momentLower) || momentLower.startsWith(streamerLower.slice(0, momentLower.length))) {
    if (momentLower.length < 10) return true;
  }

  for (const p of JUNK_PATTERNS) {
    if (p.test(t) || p.test(momentPart)) return true;
  }
  return false;
}

function normalizeHookLine(streamer, raw) {
  let line = stripDrawtextUnsafe(raw).replace(/^["']|["']$/g, '').trim();
  if (!line) return '';
  const name = stripDrawtextUnsafe(streamer || '').trim();
  if (name) {
    const first = name.split(/\s+/)[0];
    const hasStreamer = line.toLowerCase().includes(first.toLowerCase());
    if (!hasStreamer && !line.includes(':')) {
      line = `${name}: ${line}`;
    }
  }
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
  };
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
    ? '\nSTRICT: The moment after the colon MUST be 3-6 words describing what happened — never the streamer name or a fragment of it.'
    : '';
  const prompt = `You write burned-in hook captions for a Twitch clip compilation YouTube Short.

Streamer: ${ctx.streamer}
${ctx.game ? `Game/category: ${ctx.game}` : ''}
${ctx.viewCount ? `Views: ${ctx.viewCount}` : ''}
Platform clip title (DO NOT COPY — often misleading junk): "${ctx.title || 'unknown'}"

${thumb ? 'Study the thumbnail image.' : 'No thumbnail — infer a plausible specific funny/weird moment from streamer context only.'}

OUTPUT RULES (strict):
- ONE line only, format: "${ctx.streamer}: [3-6 word specific moment]"
- WINNERS: "ExtraEmily: Wrong Shirt Gift", "Lacy: Miami Food Meltdown", "Hasan: Unexpected Reaction"
- NEVER copy the platform clip title verbatim
- NEVER use the streamer's name (or part of it) as the moment text
- NEVER generic compilation filler ("Wildest Moments", "You Won't Believe", roster lists)
- NEVER output single words, abbreviations, or junk like "wisdom", "GGs", "dsda", "uo"
- Be concrete about ONE beat — embarrassment, surprise, fail, gift gone wrong, etc.${strictLine}

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
    const TwitchClient = require('./clients/twitch_client');
    const twitch = new TwitchClient();
    let videoUrl = enriched.clipUrl || enriched.url || '';
    if (videoUrl.includes('twitch.tv') && !videoUrl.includes('clips-media')) {
      const slug = twitch.extractSlug(videoUrl);
      if (slug) {
        const helix = await twitch.getClipById(slug);
        videoUrl = twitch.thumbnailToMp4(helix.thumbnail_url) || videoUrl;
      }
    }
    const analysis = await geminiAnalyzeClip(videoUrl, enriched.thumbnailUrl, 'twitch', {
      streamer: enriched.displayName || enriched.streamer,
      game: enriched.game || '',
      title: enriched.title || '',
      pageUrl: enriched.pageUrl || enriched.url || '',
    });
    if (!analysis || analysis.length < 20) return '';
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{
          parts: [{
            text: `From this Twitch clip analysis, write ONE burned-in hook caption.

Streamer: ${enriched.displayName || enriched.streamer}
Analysis: ${analysis.slice(0, 800)}

Format: "${enriched.displayName || enriched.streamer}: [3-6 word specific moment]"
Do NOT copy the platform title. Do NOT use the streamer's name as the moment.
Return ONLY the hook line.`,
          }],
        }],
        generationConfig: { maxOutputTokens: 512, temperature: 0.3 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    return (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  } catch (_) {
    return '';
  }
}

async function generateClipCompHook(clip, item, { log } = {}) {
  const enriched = await enrichClipForHook(clip, item);
  const ctx = buildClipContext(enriched, item);

  if (!GEMINI_APIKEY) {
    return normalizeHookLine(ctx.streamer, `${ctx.streamer}: unexpected moment`);
  }

  const thumb = await downloadThumbnailBase64(ctx.thumbnailUrl);

  try {
    let raw = await callGeminiForHook(ctx, thumb);
    let hook = normalizeHookLine(ctx.streamer, raw);
    if (isJunkHook(hook)) {
      if (log) log(`  ⚠️ Hook rejected ("${hook}") — retry strict`);
      raw = await callGeminiForHook(ctx, thumb, { strict: true });
      hook = normalizeHookLine(ctx.streamer, raw);
    }
    if (isJunkHook(hook)) {
      if (log) log(`  ⚠️ Thumbnail hook failed — trying video analysis`);
      raw = await analyzeClipVideoForHook({ ...enriched, ...ctx });
      hook = normalizeHookLine(ctx.streamer, raw);
    }
    if (isJunkHook(hook)) {
      const fallback = normalizeHookLine(ctx.streamer, `${ctx.streamer}: wild NYC moment`);
      if (log) log(`  ⚠️ Using generic fallback`);
      return fallback;
    }
    if (log) log(`  🎣 Hook: "${hook}"`);
    return hook;
  } catch (err) {
    if (log) log(`  ⚠️ Hook generation failed: ${err.message}`);
    return normalizeHookLine(ctx.streamer, `${ctx.streamer}: wild moment`);
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
    && preGenerated.slice(0, count).every((h) => h && !isJunkHook(h));
}

async function resolveHooksForAssembly({ hookItems = [], hookClips = [], preGenerated = null, log, forceRegenerate = false } = {}) {
  const count = hookClips.length;
  if (!forceRegenerate && hooksAreUsable(preGenerated, count)) {
    return preGenerated.slice(0, count);
  }
  return generateClipCompHooks(hookClips, hookItems, { log });
}

function buildHookScript(clips, hooks) {
  return clips.map((c, i) => {
    const hook = hooks[i] || '';
    const name = c.displayName || c.streamer || 'clip';
    return hook ? `CLIP ${i + 1} (${name}): ${hook}` : `CLIP ${i + 1} (${name}): untitled clip`;
  }).join('\n');
}

module.exports = {
  generateClipCompHook,
  generateClipCompHooks,
  resolveHooksForAssembly,
  isJunkHook,
  normalizeHookLine,
  buildClipContext,
  buildHookScript,
  hooksAreUsable,
};
