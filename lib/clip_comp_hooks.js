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
  if (!t || t.length < 10) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 && !t.includes(':')) return true;
  for (const p of JUNK_PATTERNS) {
    if (p.test(t)) return true;
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

async function generateClipCompHook(clip, item, { log } = {}) {
  const enriched = await enrichClipForHook(clip, item);
  const ctx = buildClipContext(enriched, item);

  if (!GEMINI_APIKEY) {
    return normalizeHookLine(ctx.streamer, `${ctx.streamer}: unexpected moment`);
  }

  const thumb = await downloadThumbnailBase64(ctx.thumbnailUrl);
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
- NEVER generic compilation filler ("Wildest Moments", "You Won't Believe", roster lists)
- NEVER output single words, abbreviations, or junk like "wisdom", "GGs", "dsda", "uo"
- Be concrete about ONE beat — embarrassment, surprise, fail, gift gone wrong, etc.

Return ONLY the hook line. No quotes, no explanation.`;

  const parts = [{ text: prompt }];
  if (thumb) {
    parts.push({ inline_data: { mime_type: thumb.mimeType, data: thumb.data } });
  }

  try {
    const resp = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      { contents: [{ parts }], generationConfig: { maxOutputTokens: 60, temperature: 0.4 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    const raw = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    const hook = normalizeHookLine(ctx.streamer, raw);
    if (isJunkHook(hook)) {
      const fallback = normalizeHookLine(ctx.streamer, `${ctx.streamer}: unexpected moment`);
      if (log) log(`  ⚠️ Junk hook rejected ("${hook}") — using fallback`);
      return fallback;
    }
    if (log) log(`  🎣 Hook: "${hook}"`);
    return hook;
  } catch (err) {
    if (log) log(`  ⚠️ Hook generation failed: ${err.message}`);
    return normalizeHookLine(ctx.streamer, `${ctx.streamer}: unexpected moment`);
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
