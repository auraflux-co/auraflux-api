/**
 * Live Grid — alt-platform live feed discovery via streamlink (CPD-1030)
 * Kick, Trovo, DLive, Rumble, CHZZK, Nimo — no public browse APIs; probe pinned channels.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { isFeedUrlAllowed } = require('./feed_allowlist');

const execFileAsync = promisify(execFile);
const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const PROBE_TIMEOUT_MS = parseInt(process.env.LIVE_GRID_ALT_PROBE_TIMEOUT_MS || '12000', 10);
const PROBE_CONCURRENCY = parseInt(process.env.LIVE_GRID_ALT_PROBE_CONCURRENCY || '4', 10);

/** @type {Record<string, { platform: string, buildUrl: (slug: string) => string }>} */
const PLATFORM_DEFS = {
  kick: {
    platform: 'kick',
    buildUrl: (slug) => `https://kick.com/${String(slug).replace(/^@/, '')}`,
  },
  trovo: {
    platform: 'trovo',
    buildUrl: (slug) => {
      const s = String(slug).replace(/^@/, '');
      return s.startsWith('http') ? s : `https://trovo.live/s/${s}`;
    },
  },
  dlive: {
    platform: 'dlive',
    buildUrl: (slug) => `https://dlive.tv/${String(slug).replace(/^@/, '')}`,
  },
  rumble: {
    platform: 'rumble',
    buildUrl: (slug) => {
      const s = String(slug).trim();
      if (s.startsWith('http')) return s;
      return `https://rumble.com/c/${s.replace(/^c\//, '')}`;
    },
  },
  chzzk: {
    platform: 'chzzk',
    buildUrl: (slug) => {
      const s = String(slug).trim();
      if (s.startsWith('http')) return s;
      return `https://chzzk.naver.com/live/${s}`;
    },
  },
  nimo: {
    platform: 'nimo',
    buildUrl: (slug) => {
      const s = String(slug).replace(/^@/, '');
      if (s.startsWith('http')) return s;
      return `https://www.nimo.tv/live/${s}`;
    },
  },
};

const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_DEFS);

function buildPlatformChannelUrl(platform, slug) {
  const def = PLATFORM_DEFS[String(platform).toLowerCase()];
  if (!def || !slug) return null;
  return def.buildUrl(slug);
}

/** Merge global + per-event platform pin lists. */
function mergedPlatformPins(spec = {}, config = {}) {
  const out = {};
  for (const p of SUPPORTED_PLATFORMS) {
    const fromGlobal = config.platformPins?.[p] || [];
    const fromEventMap = spec.platformPins?.[p] || [];
    const fromLegacy = spec[`${p}Pins`] || [];
    const merged = [...fromGlobal, ...fromEventMap, ...fromLegacy]
      .map(s => String(s).trim())
      .filter(Boolean);
    if (merged.length) out[p] = [...new Set(merged)];
  }
  return out;
}

async function probeStreamlinkLive(url) {
  const normalized = String(url || '').trim();
  if (!normalized || !isFeedUrlAllowed(normalized)) return null;
  try {
    const { stdout } = await execFileAsync(STREAMLINK, ['--json', normalized], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    if (data.error) return null;
    const streams = data.streams || {};
    if (!Object.keys(streams).length) return null;
    const meta = data.metadata || {};
    const plugin = data.plugin || '';
    const platform = SUPPORTED_PLATFORMS.find(p => plugin === p || normalized.toLowerCase().includes(p === 'chzzk' ? 'chzzk' : `${p}.`))
      || plugin
      || 'url';
    let channel = meta.author || meta.channel || '';
    if (!channel) {
      try {
        const parts = new URL(normalized).pathname.split('/').filter(Boolean);
        channel = parts[parts.length - 1] || '';
      } catch {
        channel = '';
      }
    }
    return {
      platform,
      url: normalized,
      title: meta.title || meta.category || channel || 'Live',
      channel,
      viewers: meta.viewer_count || meta.viewers || 0,
      game: meta.category || meta.game || '',
      source: `${platform}_pin`,
    };
  } catch {
    return null;
  }
}

async function mapConcurrent(items, fn, limit = PROBE_CONCURRENCY) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return out.filter(Boolean);
}

/** Probe pinned slugs on one alt platform; returns live feeds only. */
async function fetchAltPlatformPinFeeds(platform, slugs = []) {
  const def = PLATFORM_DEFS[String(platform).toLowerCase()];
  if (!def || !slugs.length) return [];
  const urls = [...new Set(slugs.map(s => buildPlatformChannelUrl(platform, s)).filter(Boolean))];
  return mapConcurrent(urls, (url) => probeStreamlinkLive(url));
}

/** Probe all configured alt platforms for an event spec. */
async function fetchAllAltPlatformFeeds(spec = {}, config = {}) {
  const pins = mergedPlatformPins(spec, config);
  const tasks = Object.entries(pins).map(([platform, slugs]) =>
    fetchAltPlatformPinFeeds(platform, slugs)
  );
  const batches = await Promise.all(tasks);
  return batches.flat();
}

function detectFeedPlatform(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('twitch.tv')) return 'twitch';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('kick.com')) return 'kick';
  if (u.includes('trovo.live')) return 'trovo';
  if (u.includes('dlive.tv')) return 'dlive';
  if (u.includes('rumble.com')) return 'rumble';
  if (u.includes('chzzk.naver.com')) return 'chzzk';
  if (u.includes('nimo.tv')) return 'nimo';
  if (u.includes('nasa.gov')) return 'nasa';
  return 'url';
}

module.exports = {
  PLATFORM_DEFS,
  SUPPORTED_PLATFORMS,
  buildPlatformChannelUrl,
  mergedPlatformPins,
  probeStreamlinkLive,
  fetchAltPlatformPinFeeds,
  fetchAllAltPlatformFeeds,
  detectFeedPlatform,
};
