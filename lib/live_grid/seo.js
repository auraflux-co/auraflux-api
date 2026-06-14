/**
 * Live Grid — YouTube live SEO: title, description, tags (CPD-952)
 */

const OpenAI = require('openai');

let _openai;
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const CHANNEL_NAME = process.env.YOUTUBE_CHANNEL_NAME || 'ClipzWorld News';
const CHANNEL_HASHTAG = process.env.YOUTUBE_CHANNEL_HASHTAG || '#ClipzWorldNews';

/** YouTube live chat caps posts at 200 chars — split into two lines. */
const AUDIO_INSTRUCTIONS = [
  '🔊 Members: Use !listen 1-4 to instantly choose your audio feed. Non-members automatically hear the featured stream.',
  '❤️ Like milestones unlock member !swap commands. Example: !swap 2 username (any user on Twitch). Gold border = live on-air screen.',
];

/** Core discovery tags — always included when room allows (grid mode). */
const GRID_TAG_BASE = [
  'twitch live',
  'live stream',
  'watch party',
  'twitch multistream',
  'multiview twitch',
  'streamer reactions',
  'live react',
  'irl stream',
  'gaming live',
  'just chatting',
  'twitch streamers',
  'clipzworld',
  'clipzworld news',
];

const NEWS_TAG_BASE = [
  'breaking news',
  'news live',
  'live news',
  'news analysis',
  'clipzworld news',
  'news desk',
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

function normalizeTag(t) {
  return String(t || '').replace(/^#+/, '').replace(/[<>]/g, '').trim();
}

/** Build YouTube API tags (500-char cumulative limit enforced downstream). */
function buildYoutubeTags(streamers = [], { mode = 'grid', headline = '' } = {}) {
  const names = streamers
    .map(s => s?.login)
    .filter(Boolean)
    .map(l => String(l).toLowerCase());

  const displayNames = streamers
    .map(s => displayName(s.login))
    .filter(Boolean);

  const pool = mode === 'news_desk'
    ? [...NEWS_TAG_BASE]
    : [...GRID_TAG_BASE];

  for (const login of names) {
    pool.push(login);
    pool.push(login.replace(/_/g, ' '));
  }
  for (const dn of displayNames) {
    pool.push(dn);
    pool.push(dn.replace(/\s+/g, ''));
  }

  if (mode === 'grid') {
    pool.push('four streamers', '2x2 grid', 'twitch grid', 'multi stream');
  }
  if (mode === 'event_night' && headline) {
    pool.push(String(headline).slice(0, 40));
    pool.push('event live', 'watch party live');
  }

  const out = [];
  let total = 0;
  for (let t of pool.map(normalizeTag).filter(Boolean)) {
    if (t.length > 100) t = t.slice(0, 100);
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (out.includes(t)) continue;
    if (total + cost > 450) break;
    out.push(t);
    total += cost;
    if (out.length >= 40) break;
  }
  return out;
}

function formatStreamerList(streamers = [], { withQuadrant = false } = {}) {
  return streamers
    .filter(s => s?.login)
    .map((s, i) => {
      const name = s.displayName || displayName(s.login);
      const prefix = withQuadrant ? `Q${i + 1} — ` : '';
      return `🔥 ${prefix}${name}`;
    })
    .join('\n');
}

function formatHashtagBlock(hashtags = []) {
  const tags = (Array.isArray(hashtags) ? hashtags : [])
    .map(normalizeTag)
    .filter(Boolean)
    .slice(0, 15);
  if (!tags.length) return '';
  return `\n\n${tags.map(h => `#${h.replace(/\s+/g, '')}`).join(' ')}`;
}

/**
 * Grid-mode description — discovery-friendly, names who's on screen, explains the format.
 */
function buildGridLiveDescription({ streamers = [], hookLine } = {}) {
  const onScreen = streamers.filter(s => s?.login);
  const nameLine = onScreen.length
    ? onScreen.map(s => s.displayName || displayName(s.login)).join(', ')
    : 'Top Twitch creators';

  return [
    hookLine || `🔴 LIVE NOW — ${nameLine} | ClipzWorld 4-Up Twitch Grid`,
    '',
    'Four live Twitch streams on one 2×2 screen. Catch every reaction side-by-side without switching tabs — we rotate streamers from the bench all night.',
    '',
    onScreen.length ? 'ON SCREEN NOW:' : '',
    onScreen.length ? formatStreamerList(onScreen, { withQuadrant: true }) : '',
    '',
    'HOW IT WORKS:',
    '• 2×2 multiview — four Twitch feeds composited live',
    '• Gold border = the stream you hear right now',
    '• Bench rotates in new streamers as the night goes on',
    '',
    'MEMBER CHAT COMMANDS:',
    '🔊 !listen 1-4 — members pick which quadrant has audio',
    '❤️ Like milestones unlock !swap for channel members',
    '👑 Gold border = on-air featured stream',
    '',
    'Co-stream / reaction format only — we do not rebroadcast sports broadcasts, game feeds, or copyrighted event footage.',
    '',
    `Subscribe to ${CHANNEL_NAME} for nightly Twitch multiview watch parties and live streamer reactions.`,
    formatHashtagBlock([
      'LiveStream',
      'Twitch',
      'WatchParty',
      'ClipzWorldNews',
      'Multiview',
      ...onScreen.slice(0, 4).map(s => displayName(s.login).replace(/\s+/g, '')),
    ]),
  ].filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && arr[i + 1] !== '')).join('\n').slice(0, 5000);
}

/**
 * Assemble full YouTube description from GPT fields + fixed member-perk block.
 */
function buildLiveDescription({
  hookLine,
  bodyParagraph,
  streamers = [],
  disclaimer = 'Co-stream / reaction format only — no rebroadcast of third-party game or event footage.',
  tags = [],
  hashtags = [],
  skipTagLine = true,
} = {}) {
  const names = formatStreamerList(streamers);
  const tagLine = !skipTagLine && Array.isArray(tags) && tags.length
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
    'MEMBER CHAT COMMANDS:',
    '🔊 !listen 1-4 — members pick which quadrant has audio',
    '❤️ Like milestones unlock !swap for channel members',
    '👑 Gold border = on-air featured stream',
    '',
    disclaimer,
    '',
    `Subscribe to ${CHANNEL_NAME} for live watch parties and streamer reactions.`,
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

function sanitizeHeadline(headline, programMode) {
  const head = String(headline || '').trim();
  if (!head) return headline;
  if (programMode === 'news_desk' && /apple|iphone|fifa|world cup/i.test(head)) {
    return 'ClipzWorld News Desk';
  }
  if (/apple\s+(iphone|event|wwdc)|iphone\s+\d+\s+event/i.test(head)) {
    return programMode === 'grid' ? 'Twitch Multiview Grid' : 'ClipzWorld Watch Party';
  }
  return headline;
}

function fallbackSeo(context = {}) {
  const streamers = context.streamers || [];
  const names = streamers.map(s => displayName(s.login)).filter(Boolean);
  const mode = context.programMode || 'grid';
  const headline = sanitizeHeadline(
    context.headline || (mode === 'grid' ? 'Twitch Multiview Grid' : 'ClipzWorld Watch Party'),
    mode,
  );
  const titleSuffix = names.length ? names.slice(0, 4).join(', ') : 'ClipzWorld';
  const title = appendChannelHashtag(`🔴 LIVE: ${headline} | ${titleSuffix}`);
  const tags = buildYoutubeTags(streamers, { mode, headline: context.headline });

  if (mode === 'grid') {
    const hookLine = names.length
      ? `🔴 LIVE NOW — ${titleSuffix} | 4-Up Twitch Multiview`
      : '🔴 LIVE NOW — ClipzWorld 4-Up Twitch Multiview Grid';
    return {
      title,
      description: buildGridLiveDescription({ streamers, hookLine }),
      tags,
      hashtags: ['LiveStream', 'Twitch', 'WatchParty', 'Multiview', 'ClipzWorldNews'],
      thumbnailHeadline: 'Twitch Multiview',
      thumbnailSubline: context.subline || 'Four Streams · One Screen',
    };
  }

  const hookLine = mode === 'news_desk'
    ? `🔴 LIVE NOW — ${headline}`
    : `🔴 LIVE NOW — ${headline}`;
  return {
    title,
    description: buildLiveDescription({
      hookLine,
      bodyParagraph: mode === 'news_desk'
        ? 'Live news desk with breaking coverage, analysis, and community discussion.'
        : 'Watch through live creators reacting in real time:',
      streamers,
      disclaimer: 'Transformative commentary and reaction — no rebroadcast of copyrighted event footage.',
      hashtags: ['LiveStream', 'WatchParty', 'ClipzWorldNews'].concat(
        names.slice(0, 4).map(n => n.replace(/\s+/g, '')),
      ),
      skipTagLine: true,
    }),
    tags,
    hashtags: ['LiveStream', 'WatchParty', 'ClipzWorldNews'],
    thumbnailHeadline: headline,
    thumbnailSubline: context.subline || (mode === 'news_desk' ? 'Breaking & Analysis' : 'Multi-Stream Watch Party'),
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

  // Grid: deterministic copy — names on-screen streamers, no GPT hallucinations.
  if (context.programMode === 'grid') {
    return fallbackSeo({
      ...context,
      headline: 'Twitch Multiview Grid',
      subline: context.subline || 'Four Streams · One Screen',
    });
  }

  if (!process.env.OPENAI_API_KEY) return fallbackSeo(context);

  try {
    const openai = getOpenAI();
    if (!openai) return fallbackSeo(context);
    const roster = streamers.map(s =>
      `${s.displayName || displayName(s.login)} (@${s.login}${s.viewers ? `, ${s.viewers} viewers` : ''}${s.role ? `, ${s.role}` : ''})`
    ).join('; ');
    const exampleTitle =
      '🔴 LIVE: Esports Grand Final Watch Party | iShowSpeed, Lacy, ExtraEmily & OW_Esports | #ClipzWorldNews';

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
  "tags": ["15-25 short YouTube search tags, NO # prefix, max 30 chars each"],
  "hashtags": ["8-12 hashtag words without # prefix"],
  "thumbnailHeadline": "short bold text for thumbnail, max 6 words",
  "thumbnailSubline": "secondary line, max 8 words"
}

TITLE rules:
- Start with 🔴 LIVE:
- Max 100 chars total INCLUDING channel hashtag ${CHANNEL_HASHTAG} at the end (~15 chars reserved)
- Name up to 4 on-screen streamers when relevant
- Example: ${exampleTitle}

TAGS: streamer names (login + display), twitch live, watch party, live react, event name ONLY if in Headline/context.
NEVER invent sports matches, Apple events, or FIFA games unless Headline/context names them.
Description should explain the 2×2 multiview format and member !listen / !swap commands.`;

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
    const programMode = context.programMode || 'grid';
    const safeTitle = String(seo.title).replace(
      /apple\s+(iphone|event|wwdc)[^|]*/gi,
      programMode === 'grid' ? 'Twitch Multiview Grid' : 'ClipzWorld Watch Party'
    );
    const thumbHead = sanitizeHeadline(
      seo.thumbnailHeadline || context.headline,
      programMode
    );
    const mergedTags = buildYoutubeTags(streamers, {
      mode: programMode,
      headline: context.headline,
    });
    const gptTags = Array.isArray(seo.tags) ? seo.tags.map(normalizeTag).filter(Boolean) : [];
    const tags = [...new Set([...gptTags, ...mergedTags])].slice(0, 40);

    return {
      title: appendChannelHashtag(safeTitle),
      description: buildLiveDescription({
        hookLine: seo.hookLine,
        bodyParagraph: seo.bodyParagraph,
        streamers,
        disclaimer: seo.disclaimer,
        hashtags: seo.hashtags,
        skipTagLine: true,
      }),
      tags,
      hashtags: Array.isArray(seo.hashtags) ? seo.hashtags : [],
      thumbnailHeadline: String(thumbHead || 'LIVE').slice(0, 80),
      thumbnailSubline: String(seo.thumbnailSubline || context.subline || 'Watch Party').slice(0, 80),
    };
  } catch (_) {
    return fallbackSeo(context);
  }
}

module.exports = {
  generateGridSeo,
  buildLiveDescription,
  buildGridLiveDescription,
  buildYoutubeTags,
  appendChannelHashtag,
  fallbackSeo,
  sanitizeHeadline,
  AUDIO_INSTRUCTIONS,
  formatAudioInstructions,
  displayName,
};
