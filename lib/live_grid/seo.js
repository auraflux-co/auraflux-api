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
const LIVE_TITLE_TZ = process.env.LIVE_GRID_TITLE_TZ || 'America/New_York';

/** ET short date for live titles — e.g. "06.20.26". */
function liveTitleDateShort(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LIVE_TITLE_TZ,
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).formatToParts(date);
  const m = parts.find(p => p.type === 'month')?.value || '01';
  const d = parts.find(p => p.type === 'day')?.value || '01';
  const y = parts.find(p => p.type === 'year')?.value || '26';
  return `${m}.${d}.${y}`;
}

/** Title format used on ClipzWorld live grid — 🔴 LIVE: MM.DD.YY | #login #login #twitch */
function buildGridLiveTitleHashtag(streamers = [], date = new Date()) {
  const stamp = liveTitleDateShort(date);
  const tags = streamers
    .filter(s => s?.login)
    .slice(0, 4)
    .map(s => `#${String(s.login).toLowerCase()}`)
    .join(' ');
  const body = tags ? `${tags} #twitch` : '#twitch #live';
  return `🔴 LIVE: ${stamp} | ${body}`.slice(0, 100);
}

function liveTitleDateEt(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LIVE_TITLE_TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

const LIVE_TITLE_DATE_RE = /🔴\s*LIVE:\s*(?:\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i;
const TITLE_DATE_PART_RE = /^(?:\w{3}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})$/i;

/** Insert stream date immediately after 🔴 LIVE: (YouTube metadata only — no encoder impact). */
function withLiveTitleDate(title, date = new Date()) {
  if (String(process.env.LIVE_GRID_TITLE_DATE || 'on').toLowerCase() === 'off') {
    return String(title || '').trim();
  }
  let t = String(title || '').trim();
  if (!t) return t;
  const stamp = liveTitleDateEt(date);
  if (/^🔴\s*LIVE:\s*/i.test(t)) {
    const rest = t.replace(/^🔴\s*LIVE:\s*/i, '');
    const parts = rest.split('|').map(s => s.trim()).filter(Boolean);
    while (parts.length && TITLE_DATE_PART_RE.test(parts[0])) parts.shift();
    if (parts[0]) parts[0] = sanitizeHeadline(parts[0], 'grid');
    const body = parts.join(' | ');
    return body ? `🔴 LIVE: ${stamp} | ${body}` : `🔴 LIVE: ${stamp}`;
  }
  if (/^LIVE:\s*/i.test(t)) {
    return t.replace(/^LIVE:\s*/i, `LIVE: ${stamp} | `);
  }
  if (LIVE_TITLE_DATE_RE.test(t)) return t;
  return t;
}

/** YouTube live chat caps posts at 200 chars — split into two lines. */
const AUDIO_INSTRUCTIONS = [
  '🔊 Subscribe, then !listen 1-4 to pick your audio feed. Non-subscribers hear the featured on-air stream.',
  '❤️ Subscribe + like the stream to unlock !swap. Example: !swap 2 username (any Twitch). Gold border + gold name strip = on-air screen.',
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
    if (total + cost > 495) break;
    out.push(t);
    total += cost;
    if (out.length >= 40) break;
  }
  return out;
}

function twitchChannelUrl(login) {
  const slug = String(login || '').trim().toLowerCase().replace(/^@/, '');
  if (!slug) return null;
  return `https://www.twitch.tv/${slug}`;
}

function formatStreamerList(streamers = [], { withQuadrant = false, withTwitchLinks = false } = {}) {
  return streamers
    .filter(s => s?.login)
    .map((s, i) => {
      const name = s.displayName || displayName(s.login);
      const q = Number.isInteger(s.quadrant) ? s.quadrant : (i + 1);
      const prefix = withQuadrant ? `Q${q} — ` : '';
      const url = withTwitchLinks ? twitchChannelUrl(s.login) : null;
      const linkSuffix = url ? ` — ${url}` : '';
      return `🔥 ${prefix}${name}${linkSuffix}`;
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
    onScreen.length ? formatStreamerList(onScreen, { withQuadrant: true, withTwitchLinks: true }) : '',
    '',
    'HOW IT WORKS:',
    '• 2×2 multiview — four Twitch feeds composited live',
    '• Gold border + gold name strip = the stream you hear right now',
    '• Bench rotates in new streamers as the night goes on',
    '',
    'SUBSCRIBER CHAT COMMANDS:',
    '🔊 !listen 1-4 — subscribe, then pick which quadrant has audio',
    '❤️ Subscribe + like milestones unlock !swap (any live Twitch streamer onto a screen)',
    '👑 Gold border + gold name strip = on-air featured stream',
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
 * Assemble full YouTube description from GPT fields + fixed subscriber-perk block.
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
    'SUBSCRIBER CHAT COMMANDS:',
    '🔊 !listen 1-4 — subscribe, then pick which quadrant has audio',
    '❤️ Subscribe + like milestones unlock !swap (any live Twitch streamer onto a screen)',
    '👑 Gold border + gold name strip = on-air featured stream',
    '',
    disclaimer,
    '',
    `Subscribe to ${CHANNEL_NAME} for live watch parties and streamer reactions.`,
    tagLine,
    formatHashtagBlock(hashtags),
  ].filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && arr[i + 1] !== '')).join('\n').slice(0, 5000);
}

function appendChannelHashtag(title) {
  let t = withLiveTitleDate(title);
  if (String(process.env.LIVE_GRID_TITLE_CHANNEL_HASHTAG || 'off').toLowerCase() !== 'on') {
    return t.slice(0, 100);
  }
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

function seoGptEnabled() {
  return String(process.env.LIVE_GRID_SEO_GPT || 'off').toLowerCase() === 'on';
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
  if (/mario\s*kart|smash\s*bros|oct\s+\d{1,2},?\s+2023|\b2023\b/i.test(head)) {
    return programMode === 'grid' ? 'Twitch Multiview Grid' : 'ClipzWorld Watch Party';
  }
  const yearMatch = head.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y < new Date().getFullYear()) {
      return programMode === 'grid' ? 'Twitch Multiview Grid' : 'ClipzWorld Watch Party';
    }
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

  const mode = context.programMode || 'grid';
  // Deterministic copy for all program modes — GPT live SEO hallucinates events/dates (e.g. Mario Kart 2023).
  if (mode === 'news_desk' || mode === 'grid' || mode === 'event_night' || !seoGptEnabled()) {
    return fallbackSeo(context);
  }

  if (!process.env.OPENAI_API_KEY) return fallbackSeo(context);

  try {
    const openai = getOpenAI();
    if (!openai) return fallbackSeo(context);
    const roster = streamers.map(s =>
      `${s.displayName || displayName(s.login)} (@${s.login}${s.viewers ? `, ${s.viewers} viewers` : ''}${s.role ? `, ${s.role}` : ''})`
    ).join('; ');
    const exampleTitle =
      '🔴 LIVE: Jun 16, 2026 | Esports Grand Final Watch Party | iShowSpeed, Lacy, ExtraEmily & OW_Esports | #ClipzWorldNews';

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
- Start with 🔴 LIVE: then today's date (ET), then headline — e.g. 🔴 LIVE: Jun 16, 2026 | Esports Watch Party | ...
- Max 100 chars total INCLUDING channel hashtag ${CHANNEL_HASHTAG} at the end (~15 chars reserved)
- Name up to 4 on-screen streamers when relevant
- Example: ${exampleTitle}

TAGS: streamer names (login + display), twitch live, watch party, live react, event name ONLY if in Headline/context.
NEVER invent sports matches, Apple events, or FIFA games unless Headline/context names them.
Description should explain the 2×2 multiview format and subscriber !listen / !swap commands (!swap requires subscribe + like milestone).`;

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
  twitchChannelUrl,
  formatStreamerList,
  generateGridSeo,
  buildLiveDescription,
  buildGridLiveDescription,
  buildGridLiveTitleHashtag,
  buildYoutubeTags,
  appendChannelHashtag,
  withLiveTitleDate,
  liveTitleDateEt,
  liveTitleDateShort,
  fallbackSeo,
  sanitizeHeadline,
  AUDIO_INSTRUCTIONS,
  formatAudioInstructions,
  displayName,
};
