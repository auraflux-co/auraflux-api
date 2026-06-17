'use strict';
/**
 * lib/clip_comp_editorial.js — Gemini transition plan + fixed TTS templates
 *
 * Sports/news clip comps only. Shorts use ClipzWorld News umbrella brand on cards
 * (not VOD sub-show names like "Other Side of the Pillow").
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveClipCompVoiceKey } = require('./clip_comp');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'clip_comp_editorial.json');
const GEMINI_MODEL = process.env.CLIP_COMP_EDITORIAL_MODEL || 'gemini-2.5-flash';

function editorialEnabled() {
  return String(process.env.CLIP_COMP_EDITORIAL ?? 'on').toLowerCase() !== 'off';
}

function isEditorialContentType(contentType) {
  const base = String(contentType || '').replace(/-short$/, '');
  return base.includes('sports') || ['nba', 'basketball', 'boxing', 'hockey', 'nhl'].some(t => base.includes(t))
    || base.includes('news');
}

function loadEditorialConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {
      networkBrand: 'ClipzWorld News',
      handle: '@clipzworldnews',
      templates: {
        sports: { introTts: 'ClipzWorld News. Sports highlights for {dateLong}. {topic}.', outroTts: "That's today's rundown. Follow ClipzWorld News.", categoryLabel: 'SPORTS HIGHLIGHTS', accentColor: '#1CE8FF' },
        news: { introTts: 'ClipzWorld News. World news for {dateLong}. {topic}.', outroTts: "That's today's rundown. Follow ClipzWorld News.", categoryLabel: 'WORLD NEWS', accentColor: '#c7af4f' },
      },
      stingProfiles: {},
      stingDurationSec: 0.45,
      crossfadeSec: 0.45,
      cardMinDurationSec: 2.5,
      bridgeMinDurationSec: 2.0,
    };
  }
}

/** ET date strings for on-screen cards and TTS. */
function formatEditorialDate(date = new Date()) {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const dateLong = et.replace(/, \d{4}$/, (m) => {
    const year = m.replace(/[^\d]/g, '');
    return `, ${year}`;
  });
  return { dateLine: et, dateLong: et };
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function resolveTemplateKey(contentType) {
  return resolveClipCompVoiceKey(contentType) === 'news' ? 'news' : 'sports';
}

function clipTitles(items = []) {
  return (items || [])
    .map(it => it?.title || it?.headline || it?.clipTitle || '')
    .filter(Boolean);
}

function fallbackPlan(contentType, items = []) {
  const titles = clipTitles(items);
  const topic = titles.slice(0, 3).join(', ').slice(0, 120) || 'today\'s top stories';
  const bridges = [];
  for (let i = 0; i < Math.max(0, titles.length - 1); i++) {
    const next = titles[i + 1] || 'the next story';
    bridges.push({
      ttsLine: `Next — ${next.slice(0, 80)}.`,
      transition: 'crossfade_only',
      stingProfile: null,
    });
  }
  return { topic, bridges, introTransition: { transition: 'crossfade_only' }, outroTransition: { transition: 'crossfade_only' } };
}

async function planEditorialTransitions({ contentType, items = [], log = null }) {
  const titles = clipTitles(items);
  const n = titles.length;
  if (!n) return fallbackPlan(contentType, items);

  const key = resolveTemplateKey(contentType);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    if (log) log('  ⚠️  GEMINI_API_KEY unset — editorial fallback plan');
    return fallbackPlan(contentType, items);
  }

  const prompt = `You plan editorial transitions for a ClipzWorld News vertical short (${key}).
Clips in order (${n} total):
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Return ONLY valid JSON:
{
  "topic": "one short phrase summarizing all clips for spoken intro (max 12 words, no show franchise names)",
  "bridges": [
    {
      "ttsLine": "one short bridge sentence before clip 2 (max 15 words, host voice)",
      "transition": "sting" | "crossfade_only",
      "stingProfile": "sports_hit" | "news_ticker" | "neutral_whoosh" | null
    }
  ],
  "introTransition": { "transition": "crossfade_only" | "sting", "stingProfile": null },
  "outroTransition": { "transition": "crossfade_only" | "sting", "stingProfile": null }
}

Rules:
- bridges array length MUST be ${Math.max(0, n - 1)} (between each adjacent clip pair)
- Use "sting" only when a punchy hit fits (goal, breaking news, climax). Otherwise crossfade_only.
- Never mention Other Side of the Pillow, Because the Light Was On, Twitch Soup, or Bobby G.
- ttsLine must be speakable English, no hashtags.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      { timeout: 45000 },
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const plan = JSON.parse(cleaned);
    if (!plan.topic) plan.topic = fallbackPlan(contentType, items).topic;
    while (plan.bridges.length < Math.max(0, n - 1)) {
      plan.bridges.push(fallbackPlan(contentType, items).bridges[plan.bridges.length] || {
        ttsLine: 'Next up.',
        transition: 'crossfade_only',
        stingProfile: null,
      });
    }
    plan.bridges = plan.bridges.slice(0, Math.max(0, n - 1));
    return plan;
  } catch (e) {
    if (log) log(`  ⚠️  Editorial Gemini plan failed: ${e.message.slice(0, 100)} — fallback`);
    return fallbackPlan(contentType, items);
  }
}

function buildSpokenScripts(contentType, plan) {
  const cfg = loadEditorialConfig();
  const key = resolveTemplateKey(contentType);
  const tpl = cfg.templates[key] || cfg.templates.sports;
  const { dateLong } = formatEditorialDate();
  const topic = String(plan.topic || 'today\'s highlights').replace(/\.$/, '');
  return {
    introText: fillTemplate(tpl.introTts, { dateLong, topic }),
    outroText: fillTemplate(tpl.outroTts, { dateLong, topic }),
    categoryLabel: tpl.categoryLabel,
    accentColor: tpl.accentColor,
    networkBrand: cfg.networkBrand,
    handle: cfg.handle,
  };
}

function resolveStingPath(stingProfile) {
  if (!stingProfile) return null;
  const cfg = loadEditorialConfig();
  const rel = cfg.stingProfiles?.[stingProfile];
  if (!rel) return null;
  const abs = path.join(__dirname, '..', rel);
  return fs.existsSync(abs) ? abs : null;
}

module.exports = {
  editorialEnabled,
  isEditorialContentType,
  loadEditorialConfig,
  formatEditorialDate,
  fillTemplate,
  planEditorialTransitions,
  buildSpokenScripts,
  resolveStingPath,
  resolveTemplateKey,
  fallbackPlan,
};
