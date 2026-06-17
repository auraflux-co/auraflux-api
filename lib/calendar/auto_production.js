/**
 * Autonomous production — calendar-driven Generate without dashboard clicks.
 * Long-form (avatar/HeyGen) runs only when isLongformAvatarBlocked() is false.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { nowET, parseHm } = require('../live_grid/schedule_time');
const { slotTimeToIso, scheduleJobToSlot, assignmentForSlot } = require('./slot_jobs');
const { buildBroadcastToday } = require('./master_plan');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_PATH = path.join(REPO_ROOT, 'data', 'production_cron_state.json');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'content_calendar.json');

const DEFAULT_TEMPLATE_STREAMERS = [
  'jasontheween', 'adapt', 'marlon', 'extraemily', 'stableronaldo', 'maya',
  'cinna', 'yonnajay', 'jaycinco', 'lacy', 'hasanabi', 'yourragegaming',
];

function readAutoConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return cfg.autoProduction || {};
  } catch (_) {
    return {};
  }
}

function leadMinutesForKind(kind, autoCfg = readAutoConfig()) {
  const lead = autoCfg.leadMinutes || {};
  if (kind === 'longform') return lead.longform ?? 120;
  return lead.short ?? 90;
}

/** Avatar/HeyGen gate — only blocker for long-form VOD automation. */
function isLongformAvatarBlocked() {
  if (!process.env.HEYGEN_API_KEY) {
    return { blocked: true, reason: 'HEYGEN_API_KEY not set' };
  }
  if (String(process.env.GATE_TEST_MODE || '').toLowerCase() === 'true') {
    return { blocked: true, reason: 'GATE_TEST_MODE=true (HeyGen auto-send disabled)' };
  }
  if (!process.env.GEMINI_API_KEY) {
    return { blocked: true, reason: 'GEMINI_API_KEY not set (script generation required)' };
  }
  return { blocked: false, reason: null };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return { fired: {} };
  }
}

function saveState(data) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function slotFired(state, dateKey, slotId) {
  return !!(state.fired?.[dateKey]?.[slotId]);
}

function markSlotFired(state, dateKey, slotId, record) {
  state.fired = state.fired || {};
  state.fired[dateKey] = state.fired[dateKey] || {};
  state.fired[dateKey][slotId] = { ...record, at: new Date().toISOString() };
  saveState(state);
}

/** Minutes since midnight when production should fire (before publish slot time). */
function productionTriggerMinutes(slot, autoCfg = readAutoConfig()) {
  const slotMins = parseHm(slot.time);
  if (slotMins == null) return null;
  const lead = leadMinutesForKind(slot.kind || 'short', autoCfg);
  let trigger = slotMins - lead;
  if (trigger < 0) trigger += 24 * 60;
  return trigger;
}

function isProductionDue(slot, date = new Date(), autoCfg = readAutoConfig()) {
  const et = nowET(date);
  const trigger = productionTriggerMinutes(slot, autoCfg);
  if (trigger == null) return false;
  return et.minutes >= trigger;
}

function slotAlreadyCovered(slot, dateKey, persistedJobs = {}) {
  const ct = String(slot.contentType || '').toLowerCase();
  const altTypes = (slot.alternateTypes || []).map((t) => String(t).toLowerCase());
  for (const [, card] of Object.entries(persistedJobs)) {
    if (!card || card.status === 'dismissed') continue;
    const jct = String(card.contentType || '').toLowerCase();
    const matchCt = jct === ct
      || (slot.contentType === 'alternate' && altTypes.includes(jct))
      || (ct === 'news' && jct === 'news')
      || (ct === 'twitch' && jct === 'twitch');
    if (!matchCt) continue;
    const stage = card.stage || '';
    if (['published', 'failed', 'killed'].includes(stage)) {
      if (card.calendarSlotDate === dateKey) continue;
      if (card.publishedAt && String(card.publishedAt).slice(0, 10) === dateKey) return true;
      continue;
    }
    if (['publish_scheduled', 'assembled', 'gate5_forced', 'gate5_running', 'gate5_failed'].includes(stage)) {
      return true;
    }
    if (stage && !['', 'dismissed'].includes(stage)) return true;
  }
  if (assignmentForSlot(dateKey, slot.id)) return true;
  return false;
}

async function fetchNewsStories(baseUrl, opts = {}) {
  const params = new URLSearchParams({
    source: opts.source || 'all',
    limit: String(opts.limit || 12),
    durMin: String(opts.durMin ?? 30),
    durMax: String(opts.durMax ?? 180),
    pubHours: String(opts.pubHours ?? 72),
  });
  const resp = await axios.get(`${baseUrl.replace(/\/$/, '')}/news/stories?${params}`, { timeout: 180000 });
  return resp.data?.videos || [];
}

async function fetchTwitchClipsPool(baseUrl, streamers, clipsPerStreamer = 2) {
  const params = new URLSearchParams({
    streamers: streamers.join(','),
    clipsPerStreamer: String(clipsPerStreamer),
  });
  const resp = await axios.get(`${baseUrl.replace(/\/$/, '')}/twitch/clips-pool?${params}`, { timeout: 60000 });
  return resp.data?.clips || [];
}

async function resolveTwitchMp4(baseUrl, clipUrl) {
  if (!clipUrl) return null;
  try {
    const resp = await axios.post(`${baseUrl.replace(/\/$/, '')}/twitch-clip-url`, { url: clipUrl }, { timeout: 20000 });
    return resp.data?.mp4Url || null;
  } catch (_) {
    return null;
  }
}

function templateStreamers(autoCfg = readAutoConfig()) {
  const fromCfg = autoCfg.twitchTemplateStreamers;
  if (Array.isArray(fromCfg) && fromCfg.length) return fromCfg.map((s) => String(s).toLowerCase());
  try {
    const ss = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'streamerSources.json'), 'utf8'));
    const keys = Object.keys(ss.streamers || {});
    if (keys.length) return keys.slice(0, 12);
  } catch (_) {}
  return DEFAULT_TEMPLATE_STREAMERS;
}

async function postClipComp(baseUrl, { clips, contentType, platforms, title, scheduledAt, calendarSlotId }) {
  const body = {
    clips,
    contentType,
    platforms,
    title,
    createdBy: 'production_cron',
    calendarSlotId,
  };
  if (scheduledAt) body.scheduledAt = scheduledAt;
  const resp = await axios.post(`${baseUrl.replace(/\/$/, '')}/generate-clip-comp`, body, { timeout: 30000 });
  return resp.data;
}

async function postFullScript(baseUrl, { type, items, platforms, formType, scriptVariant, calendarSlotId }) {
  const body = {
    type,
    contentType: type,
    items,
    formType: formType || (String(type).includes('short') ? 'short' : 'long'),
    platforms,
    createdBy: 'production_cron',
    calendarSlotId,
    qaGenerateConfirmed: true,
  };
  if (scriptVariant) body.scriptVariant = scriptVariant;
  const resp = await axios.post(`${baseUrl.replace(/\/$/, '')}/generate-full-script`, body, { timeout: 300000 });
  return resp.data;
}

function resolveAlternateType(slot, dateKey, persistedJobs) {
  const types = (slot.alternateTypes || ['news-short', 'twitch-short']).map((t) => String(t).toLowerCase());
  for (const t of types) {
    const fakeSlot = { ...slot, contentType: t, kind: 'short' };
    if (!slotAlreadyCovered(fakeSlot, dateKey, persistedJobs)) return t;
  }
  return types[0];
}

async function dispatchShortSlot({ slot, dateKey, baseUrl, persistedJobs }) {
  const platforms = slot.publishPlatforms || ['youtube', 'tiktok', 'instagram'];
  const scheduledAt = slotTimeToIso(dateKey, slot.time);
  let contentType = String(slot.contentType || '').toLowerCase();

  if (contentType === 'alternate') {
    contentType = resolveAlternateType(slot, dateKey, persistedJobs);
  }

  if (contentType === 'news-short') {
    const stories = await fetchNewsStories(baseUrl, { durMin: 30, durMax: 180, limit: 6 });
    const story = stories.find((s) => s.hlsUrl || s.videoUrl);
    if (!story) throw new Error('No news stories with video for news-short');
    return postClipComp(baseUrl, {
      contentType: 'news-short',
      platforms,
      scheduledAt,
      calendarSlotId: slot.id,
      title: `Clip Short — ${(story.title || 'News').slice(0, 80)}`,
      clips: [{
        url: story.hlsUrl || story.videoUrl,
        pageUrl: story.link || '',
        title: story.title || '',
        displayName: story.source || 'News',
        orientation: story.sourceOrientation || story.orientation || 'landscape',
        pillarboxFilter: story.pillarboxFilter ?? null,
      }],
    });
  }

  if (contentType === 'twitch-short') {
    const streamers = templateStreamers();
    const pool = await fetchTwitchClipsPool(baseUrl, streamers.slice(0, 8), 2);
    const sorted = [...pool].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
    const pick = sorted.find((c) => c.url);
    if (!pick) throw new Error('No Twitch clips in pool for twitch-short');
    const mp4 = await resolveTwitchMp4(baseUrl, pick.url);
    return postClipComp(baseUrl, {
      contentType: 'twitch-short',
      platforms,
      scheduledAt,
      calendarSlotId: slot.id,
      title: `Clip Short — ${pick.streamer || 'Twitch'}`,
      clips: [{
        url: mp4 || pick.url,
        pageUrl: pick.url,
        title: pick.title || '',
        streamer: pick.streamer || '',
        displayName: pick.streamer || 'Twitch',
        orientation: 'landscape',
      }],
    });
  }

  throw new Error(`Unsupported short contentType: ${contentType}`);
}

async function dispatchLongformSlot({ slot, dateKey, baseUrl }) {
  const platforms = slot.publishPlatforms || ['youtube'];
  const ct = String(slot.contentType || '').toLowerCase();

  if (ct === 'news') {
    const stories = await fetchNewsStories(baseUrl, { durMin: 60, durMax: 600, limit: 5, pubHours: 48 });
    const items = stories
      .filter((s) => s.hlsUrl || s.videoUrl || s.link)
      .slice(0, 5)
      .map((s) => ({
        title: s.title || '',
        desc: s.description || '',
        source: s.source || 'News',
        link: s.link || '',
        thumbnailUrl: s.thumbnailUrl || s.thumbnail || '',
        hlsUrl: s.hlsUrl || s.videoUrl || '',
        videoUrl: s.hlsUrl || s.videoUrl || '',
        orientation: s.sourceOrientation || s.orientation || 'landscape',
      }));
    if (!items.length) throw new Error('No news items for long-form');
    return postFullScript(baseUrl, {
      type: 'news',
      items,
      platforms,
      formType: 'long',
      calendarSlotId: slot.id,
    });
  }

  if (ct === 'twitch') {
    const streamers = templateStreamers();
    const pool = await fetchTwitchClipsPool(baseUrl, streamers, 2);
    const byStreamer = {};
    for (const c of pool) {
      const key = (c.streamer || '').toLowerCase();
      if (!key || byStreamer[key]) continue;
      byStreamer[key] = c;
    }
    const picks = Object.values(byStreamer).slice(0, 10);
    if (!picks.length) throw new Error('No Twitch clips for long-form');
    const items = [];
    for (const clip of picks) {
      const mp4 = await resolveTwitchMp4(baseUrl, clip.url);
      items.push({
        streamer: clip.streamer,
        displayName: clip.streamer,
        title: clip.title || '',
        url: clip.url || '',
        views: clip.viewCount || 0,
        game: clip.game || '',
        thumbnailUrl: clip.thumbnail || '',
        clips: [{
          rank: 1,
          title: clip.title || '',
          url: clip.url || '',
          views: clip.viewCount || 0,
          game: clip.game || '',
          thumbnailUrl: clip.thumbnail || '',
          mp4Url: mp4 || null,
        }],
      });
    }
    items.sort((a, b) => (a.views || 0) - (b.views || 0));
    return postFullScript(baseUrl, {
      type: 'twitch',
      items,
      platforms,
      formType: 'long',
      scriptVariant: 'top10',
      calendarSlotId: slot.id,
    });
  }

  throw new Error(`Unsupported longform contentType: ${ct}`);
}

async function dispatchSlotProduction({ slot, dateKey, baseUrl, persistedJobs, state, log = console.log }) {
  if (slot.enabled === false || slot.status === 'skipped') {
    return { status: 'skipped', reason: slot.skipReason || 'disabled' };
  }

  if (slotAlreadyCovered(slot, dateKey, persistedJobs)) {
    return { status: 'skipped', reason: 'already in flight or published today' };
  }

  const kind = slot.kind || 'short';
  if (kind === 'longform') {
    const block = isLongformAvatarBlocked();
    if (block.blocked) {
      markSlotFired(state, dateKey, slot.id, { status: 'blocked_avatar', reason: block.reason });
      log(`[prod-cron] ${slot.id}: long-form blocked — ${block.reason}`);
      return { status: 'blocked_avatar', reason: block.reason };
    }
    const result = await dispatchLongformSlot({ slot, dateKey, baseUrl });
    markSlotFired(state, dateKey, slot.id, { status: 'dispatched', kind: 'longform', jobId: result.metricsJobId || result.jobId });
    return { status: 'dispatched', kind: 'longform', result };
  }

  const result = await dispatchShortSlot({ slot, dateKey, baseUrl, persistedJobs });
  markSlotFired(state, dateKey, slot.id, { status: 'dispatched', kind: 'short', jobId: result.jobId });
  return { status: 'dispatched', kind: 'short', result };
}

/** Link assembled jobs to today's calendar slot for deferred publish. */
function autoScheduleAssembledJobs({ persistedJobs, saveJobCard, dateKey, log = console.log }) {
  const today = buildBroadcastToday({ persistedJobs });
  const slots = (today.production || []).filter((s) => s.status !== 'skipped' && s.enabled !== false);

  for (const slot of slots) {
    if (assignmentForSlot(dateKey, slot.id)) continue;

    const ct = slot.contentType === 'alternate' ? null : slot.contentType;
    const altTypes = slot.alternateTypes || [];
    let match = null;
    for (const [jobId, card] of Object.entries(persistedJobs)) {
      if (!card || card.stage !== 'assembled') continue;
      if (card.calendarSlotId && card.calendarSlotDate === dateKey) continue;
      const jct = String(card.contentType || '').toLowerCase();
      const ok = jct === String(ct || '').toLowerCase()
        || (slot.contentType === 'alternate' && altTypes.map((t) => t.toLowerCase()).includes(jct))
        || (ct === 'news' && jct === 'news')
        || (ct === 'twitch' && jct === 'twitch');
      if (!ok) continue;
      if (card.createdBy !== 'production_cron' && !card.autoScheduled) continue;
      match = { jobId, card };
      break;
    }
    if (!match) continue;
    if (slot.kind === 'longform') continue;

    const scheduledAt = slotTimeToIso(dateKey, slot.time);
    if (new Date(scheduledAt).getTime() <= Date.now()) continue;

    const result = scheduleJobToSlot({
      jobId: match.jobId,
      slotId: slot.id,
      date: dateKey,
      persistedJobs,
      saveJobCard,
    });
    if (result.ok) {
      log(`[prod-cron] auto-scheduled ${match.jobId} → ${slot.id} @ ${slot.time} ET`);
    }
  }
}

async function runProductionTick({ baseUrl, getPersistedJobs, saveJobCard, log = console.log }) {
  const autoCfg = readAutoConfig();
  if (autoCfg.enabled === false) return { skipped: 'disabled in config' };

  const persistedJobs = typeof getPersistedJobs === 'function' ? getPersistedJobs() : {};
  const et = nowET();
  const state = loadState();
  const today = buildBroadcastToday({ persistedJobs });
  const dispatched = [];

  for (const slot of today.production || []) {
    if (slot.status === 'skipped' || slot.enabled === false) continue;
    if (slotFired(state, et.dateKey, slot.id)) continue;
    if (!isProductionDue(slot, new Date(), autoCfg)) continue;
    if (slotAlreadyCovered(slot, et.dateKey, persistedJobs)) {
      markSlotFired(state, et.dateKey, slot.id, { status: 'skipped', reason: 'already covered' });
      continue;
    }

    try {
      log(`[prod-cron] firing ${slot.id} (${slot.label})`);
      const outcome = await dispatchSlotProduction({
        slot, dateKey: et.dateKey, baseUrl, persistedJobs, state, log,
      });
      dispatched.push({ slotId: slot.id, ...outcome });
    } catch (e) {
      markSlotFired(state, et.dateKey, slot.id, { status: 'error', error: e.message });
      log(`[prod-cron] ${slot.id} failed: ${e.message}`);
      dispatched.push({ slotId: slot.id, status: 'error', error: e.message });
    }
  }

  if (saveJobCard) {
    autoScheduleAssembledJobs({
      persistedJobs,
      saveJobCard,
      dateKey: et.dateKey,
      log,
    });
  }

  return { dateKey: et.dateKey, dispatched, avatarBlocked: isLongformAvatarBlocked() };
}

module.exports = {
  isLongformAvatarBlocked,
  leadMinutesForKind,
  productionTriggerMinutes,
  isProductionDue,
  slotAlreadyCovered,
  dispatchSlotProduction,
  autoScheduleAssembledJobs,
  runProductionTick,
  loadState,
  STATE_PATH,
};
