/**
 * Programming playbook — surfaces youtube_top200 data + allowlist on the Broadcast dashboard.
 * Answers: what formats the data said to build, which channel they belong on, what's wired vs missing.
 */

const fs = require('fs');
const path = require('path');
const { loadAllowlist } = require('../live_grid/rights_registry');
const { buildTvCatalog } = require('../live_tv/curated_playlist');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ANALYSIS_PATH = path.join(REPO_ROOT, 'logs', 'youtube_top200_build_analysis.json');

const FORMAT_META = {
  'Sports watch-along / match tile': {
    id: 'sports_watchalong',
    channel: 'youtube',
    channelLabel: 'YouTube Live — Event Night (6–8pm ET)',
    robSummary: 'Produced intro + co-stream reactions — not raw ESPN. Uses Live Grid event mode.',
  },
  'Breaking news wall (long-run)': {
    id: 'breaking_news_wall',
    channel: 'both',
    channelLabel: 'YouTube news_desk + Twitch TV news loop',
    robSummary: 'Long-run news desk with Bobby G commentary over sourced stories — your pipeline news VODs.',
  },
  'Esports grand final night': {
    id: 'esports_grand_final',
    channel: 'youtube',
    channelLabel: 'YouTube Live — Event Night',
    robSummary: 'Pin official co-streams + produced host segment on Q0.',
  },
  'Creator milestone / sub stream': {
    id: 'creator_milestone',
    channel: 'youtube',
    channelLabel: 'YouTube Live — one-off',
    robSummary: 'Bobby G host segment + grid after-party — needs produced host file.',
  },
  'Watchparty / reaction': {
    id: 'watchparty_reaction',
    channel: 'youtube',
    channelLabel: 'YouTube Live — build next',
    robSummary: 'Main event + PiP reaction — not built yet.',
  },
  'Gaming showcase simulcast': {
    id: 'gaming_showcase',
    channel: 'youtube',
    channelLabel: 'YouTube Live — Event Night',
    robSummary: 'Keynote file on Q0 + reaction quads — allowlisted URL or recap file.',
  },
  'Weather/disaster (if news brand)': {
    id: 'weather_disaster',
    channel: 'both',
    channelLabel: 'YouTube + Twitch when licensed',
    robSummary: 'Public/disaster feed + desk commentary — yellow tier, needs transform.',
  },
  'Roblox/kids live': {
    id: 'roblox',
    channel: 'skip',
    channelLabel: 'Off-brand — skip',
    robSummary: 'Data says deprioritize for ClipzWorld News.',
  },
  'Twitch multiview restream': {
    id: 'twitch_multiview',
    channel: 'youtube_offpeak',
    channelLabel: 'YouTube only — late night (11pm–3am)',
    robSummary: '4-up Twitch grid — data ranked it niche (0 in top 200). Not for Twitch TV.',
  },
  'Non-English regional': {
    id: 'regional',
    channel: 'skip',
    channelLabel: 'Separate strategy',
    robSummary: 'Not this channel.',
  },
};

function loadAnalysis() {
  if (!fs.existsSync(ANALYSIS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function wiringStatus(formatId, catalog) {
  const news = (catalog?.news || []).length;
  const bobby = (catalog?.bobbyg || []).length;
  switch (formatId) {
    case 'breaking_news_wall':
      if (news >= 1) return { status: 'partial', detail: `${news} news VOD(s) on disk — need fresh daily runs + news_desk mode on YouTube` };
      return { status: 'gap', detail: 'No news VOD ready — run News from Generate' };
    case 'sports_watchalong':
    case 'esports_grand_final':
    case 'gaming_showcase':
      return { status: 'partial', detail: 'Program mode + allowlist exist — need event file or co-stream lineup in Broadcast GO LIVE' };
    case 'twitch_multiview':
      return { status: 'wired', detail: 'Live Grid works — schedule 11pm–3am; not for Twitch TV loop' };
    case 'watchparty_reaction':
    case 'creator_milestone':
    case 'weather_disaster':
      return { status: 'not_built', detail: 'In data tier B — encoder modes not implemented yet' };
    default:
      return { status: 'unknown', detail: '—' };
  }
}

function buildProgrammingPlaybook() {
  const analysis = loadAnalysis();
  const allowlist = loadAllowlist();
  const catalog = buildTvCatalog();
  const tiers = [];

  if (analysis?.buildMap) {
    for (const tier of analysis.buildMap) {
      const items = (tier.items || []).map((item) => {
        const meta = FORMAT_META[item.format] || {
          id: item.format,
          channel: 'tbd',
          channelLabel: 'TBD',
          robSummary: item.build || '',
        };
        const wiring = wiringStatus(meta.id, catalog);
        const allow = (allowlist.events || []).find((e) => e.id === meta.id);
        return {
          format: item.format,
          evidence: item.evidence,
          build: item.build,
          tier: tier.tier,
          ...meta,
          transform: allow?.transform || null,
          allowTier: allow?.tier || null,
          wiringStatus: wiring.status,
          wiringDetail: wiring.detail,
        };
      });
      tiers.push({ tier: tier.tier, items });
    }
  }

  const principles = [
    {
      title: 'Twitch TV (ClipzWorld TV)',
      body: 'Transformative produced video only — Bobby G commentary VODs + news desk. Not streamer clip comps, not rebroadcasting the 4-up grid (Twitch ToS).',
    },
    {
      title: 'YouTube Live (6pm–3am ET)',
      body: 'Where the data work points: event watch-alongs, news desk (8–11pm), esports/sports tiles — commentary over or beside sources, not raw wire feeds.',
    },
    {
      title: 'Why the dashboard felt empty',
      body: 'CPD-1026–1028 built controls (start/stop, file swap, ops). The youtube_top200 playbook and yellow-tier transforms were saved to config/logs but not shown as programming options until now.',
    },
    {
      title: 'Content rate reality',
      body: 'Pipeline produces ~35–45 min/day (CPD-964). Data formats need either faster news runs, event-night co-streams (low production), or EchoMimic to unblock Bobby G volume — not looping the same 3 files forever.',
    },
  ];

  return {
    ok: true,
    generatedAt: analysis?.generatedAt || null,
    analysisPath: 'logs/youtube_top200_build_analysis.json',
    allowlistUpdated: allowlist.updated || null,
    tiers,
    principles,
    readyCounts: { bobbyg: (catalog.bobbyg || []).length, news: (catalog.news || []).length },
  };
}

module.exports = { buildProgrammingPlaybook, FORMAT_META };
