/**
 * Live Grid — GPT SEO copy for the YouTube live broadcast (CPD-952)
 */

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHANNEL_NAME = process.env.YOUTUBE_CHANNEL_NAME || 'ClipzWorld News';
const CHANNEL_HASHTAG = process.env.YOUTUBE_CHANNEL_HASHTAG || '#ClipzWorldNews';

/** YouTube live chat caps posts at 200 chars — split into two lines. */
const AUDIO_INSTRUCTIONS = [
  '🔊 Members: Use !listen 1-4 to instantly choose your audio feed. Non-members automatically hear the featured stream.',
  '❤️ Like milestones unlock member !swap commands. Example: !swap 2 username (any user on Twitch). Gold border = live on-air screen.',
];

function formatAudioInstructions(sep = ' ') {
  return AUDIO_INSTRUCTIONS.join(sep);
}

function displayName(login) {
  if (!login) return '';
  return String(login)
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function formatStreamerList(streamers = []) {
  return streamers
    .filter(s => s?.login)
    .map(s => `🔥 ${s.displayName || displayName(s.login)}`)
    .join('\n');
}

function formatHashtagBlock(hashtags = []) {
  const tags = (Array.isArray(hashtags) ? hashtags : [])
    .map(h => String(h).replace(/^#+/, '').trim())
    .filter(Boolean)
    .slice(0, 15);
  if (!tags.length) return '';
  return `\n\nHashtags:\n${tags.map(h => `#${h}`).join(' ')}`;
}

/**
 * Assemble full YouTube description from GPT fields + fixed member-perk block.
 */
function buildLiveDescription({
  hookLine,
  bodyParagraph,
  streamers = [],
  disclaimer = 'No game footage. Live reactions, commentary, highlights discussion, and community watch party.',
  tags = [],
  hashtags = [],
} = {}) {
  const names = formatStreamerList(streamers);
  const tagLine = Array.isArray(tags) && tags.length
    ? `\n\nTags:\n${tags.join(', ')}`
    : '';
  return [
    hookLine || '🔴 LIVE NOW — ClipzWorld multi-stream watch party',
    '',
    bodyParagraph || 'Watch through four live Twitch creators reacting in real time:',
    '',
    names,
    '',
    'Compare reactions, switch perspectives, and join the community.',
    '',
    '🔊 Members can select audio with !listen 1-4',
    '⭐ Like milestones unlock !swap commands',
    '👑 Gold border = featured live stream',
    '',
    disclaimer,
    '',
    `Subscribe to ${CHANNEL_NAME} for more live watch parties, streamer reactions, and breaking sports coverage.`,
    tagLine,
    formatHashtagBlock(hashtags),
  ].filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && arr[i + 1] !== '')).join('\n').slice(0, 5000);
}

function appendChannelHashtag(title) {
  let t = String(title || '').trim();
  const suffix = ` | ${CHANNEL_HASHTAG}`;
  if (t.includes('ClipzWorldNews') || t.includes(CHANNEL_HASHTAG)) return t.slice(0, 100);
  const maxBody = 100 - suffix.length;
  if (t.length > maxBody) {
    t = t.slice(0, maxBody);
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > maxBody * 0.6) t = t.slice(0, lastSpace);
    t = t.replace(/[\s|,|&]+$/, '');
  }
  return (t + suffix).slice(0, 100);
}

function fallbackSeo(context = {}) {
  const streamers = context.streamers || [];
  const names = streamers.map(s => displayName(s.login)).filter(Boolean);
  const titleSuffix = names.length ? names.slice(0, 4).join(', ') : 'ClipzWorld';
  const title = appendChannelHashtag(`🔴 LIVE: ${context.headline || 'Watch Party'} | ${titleSuffix}`);
  return {
    title,
    description: buildLiveDescription({
      hookLine: `⚽ LIVE NOW: ${context.headline || 'ClipzWorld Watch Party'}`,
      streamers,
      tags: names.concat(['Live Reactions', 'Twitch Reactions', 'Watch Party', CHANNEL_NAME]),
      hashtags: ['LiveStream', 'WatchParty', 'LiveReactions', 'ClipzWorldNews'].concat(names.slice(0, 4)),
    }),
    tags: [...names, 'Live Reactions', 'Twitch Reactions', 'Watch Party', 'Multi Stream', CHANNEL_NAME],
    hashtags: ['LiveStream', 'WatchParty', 'ClipzWorldNews'],
    thumbnailHeadline: context.headline || 'LIVE WATCH PARTY',
    thumbnailSubline: context.subline || 'Multi-Stream Watch Party',
  };
}

/**
 * @param {Object} context
 * @param {Array<{login:string,displayName?:string,viewers?:number,role?:string}>} context.streamers
 * @param {string} [context.programMode]
 * @param {string} [context.headline] — event / show headline
 * @param {string} [context.subline]
 * @returns {Promise<{title:string,description:string,tags:string[],hashtags:string[],thumbnailHeadline:string,thumbnailSubline:string}|null>}
 */
async function generateGridSeo(context = {}) {
  const streamers = context.streamers || [];
  if (!streamers.length && !context.headline && !context.programMode) return null;

  if (context.programMode === 'news_desk') {
    return fallbackSeo({
      ...context,
      headline: context.headline || 'ClipzWorld News Desk',
      subline: context.subline || 'Breaking News & Analysis',
    });
  }

  if (!process.env.OPENAI_API_KEY) return fallbackSeo(context);

  try {
    const roster = streamers.map(s =>
      `${s.displayName || displayName(s.login)} (@${s.login}${s.viewers ? `, ${s.viewers} viewers` : ''}${s.role ? `, ${s.role}` : ''})`
    ).join('; ');
    const exampleTitle =
      '🔴 LIVE: Brazil 🇧🇷 vs Morocco 🇲🇦 | FIFA World Cup Watch Party ⚽ | iShowSpeed, Lacy, ExtraEmily & OW_Esports | #ClipzWorldNews';

    const systemPrompt = `You write YouTube LIVE stream SEO for ${CHANNEL_NAME} (@clipzworldnews).
Multi-view 2×2 grid — streamers on screen now: ${roster || 'TBD'}.
Program mode: ${context.programMode || 'grid'}.
Headline/context: ${context.headline || context.subline || 'live watch party'}.

Return JSON only:
{
  "title": "...",
  "hookLine": "one-line LIVE NOW opener with emojis",
  "bodyParagraph": "1-2 sentences describing the watch party",
  "disclaimer": "rights-safe line — no game footage, reactions only",
  "tags": ["20-25 YouTube search tags, NO hash prefixes, comma-ready strings like Brazil vs Morocco"],
  "hashtags": ["12-18 hashtag words without # prefix"],
  "thumbnailHeadline": "short bold text for thumbnail, max 6 words",
  "thumbnailSubline": "secondary line, max 8 words"
}

TITLE rules:
- Start with 🔴 LIVE:
- Max 100 chars total INCLUDING channel hashtag ${CHANNEL_HASHTAG} at the end (~15 chars reserved for hashtag)
- Name up to 4 on-screen streamers when relevant — abbreviate if needed (e.g. OW_Esports not OW Esports)
- Example shape: ${exampleTitle}

TAGS: discovery-focused (teams, event, streamer names, watch party, live reactions).
HASHTAGS: include ClipzWorldNews, event tags, streamer names (no spaces in compound tags like OWEsports).
Be honest — no fake claims about official broadcast rights.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate live stream SEO JSON now.' },
      ],
    });
    const text = (response.choices[0]?.message?.content || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackSeo(context);
    const seo = JSON.parse(jsonMatch[0]);
    if (!seo.title) return fallbackSeo(context);

    return {
      title: appendChannelHashtag(seo.title),
      description: buildLiveDescription({
        hookLine: seo.hookLine,
        bodyParagraph: seo.bodyParagraph,
        streamers,
        disclaimer: seo.disclaimer,
        tags: seo.tags,
        hashtags: seo.hashtags,
      }),
      tags: Array.isArray(seo.tags) ? seo.tags : [],
      hashtags: Array.isArray(seo.hashtags) ? seo.hashtags : [],
      thumbnailHeadline: String(seo.thumbnailHeadline || context.headline || 'LIVE').slice(0, 80),
      thumbnailSubline: String(seo.thumbnailSubline || context.subline || 'Watch Party').slice(0, 80),
    };
  } catch (_) {
    return fallbackSeo(context);
  }
}

module.exports = {
  generateGridSeo,
  buildLiveDescription,
  appendChannelHashtag,
  fallbackSeo,
  AUDIO_INSTRUCTIONS,
  formatAudioInstructions,
  displayName,
};
