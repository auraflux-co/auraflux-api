/**
 * Live Grid — program director (CPD-1017)
 *
 * Daypart modes (grid | news_desk | event_night) merge poller assignments
 * with file/slate quadrant specs from config/live_grid_programs.json.
 */

const fs = require('fs');
const path = require('path');
const { resolveAllFileSources } = require('./file_sources');
const { resolveActiveEvent } = require('./event_calendar');
const { nowET, parseHm, inScheduleBlock } = require('./schedule_time');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_programs.json');

function loadPrograms(configPath = process.env.LIVE_GRID_PROGRAM_CONFIG || DEFAULT_CONFIG_PATH) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

/** Pure: pick active mode from schedule at ET time. */
function resolveScheduledMode(config, et = nowET()) {
  for (const block of config.schedule || []) {
    const days = (block.days || []).map(d => String(d).toLowerCase().slice(0, 3));
    if (days.length && !days.includes(et.weekday)) continue;
    const start = parseHm(block.start);
    const end = parseHm(block.end);
    if (start == null || end == null) continue;
    if (inScheduleBlock(et.minutes, start, end)) {
      return { mode: block.mode, block, et };
    }
  }
  return { mode: 'grid', block: null, et };
}

function formatTitle(template, vars = {}) {
  let t = String(template || '🔴 LIVE: ClipzWorld');
  for (const [k, v] of Object.entries(vars)) {
    t = t.replace(new RegExp(`\\{${k}\\}`, 'g'), v || '');
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Merge poller twitch assignments with program quadrant specs.
 * Returns null | login | { type:'file', path, label } | { type:'url', url, label, title }.
 */
function buildQuadrantSources(modeName, config, pollerAssignments, filePaths = {}, feedPaths = {}) {
  const mode = config.modes?.[modeName] || config.modes?.grid;
  const specs = mode?.quadrants || [{ type: 'twitch' }, { type: 'twitch' }, { type: 'twitch' }, { type: 'twitch' }];
  const out = [null, null, null, null];
  const liveLogins = pollerAssignments.filter(Boolean);
  const eventFeedQ0 = modeName === 'event_night' && specs[0]?.type === 'feed';
  const coStreamOrder = eventFeedQ0 ? liveLogins : null;
  let coStreamIdx = 0;

  for (let q = 0; q < 4; q++) {
    const spec = specs[q] || { type: 'twitch' };
    switch (spec.type) {
      case 'slate':
        out[q] = null;
        break;
      case 'feed': {
        const feed = feedPaths[spec.source];
        if (feed?.url) {
          out[q] = {
            type: 'url',
            url: feed.url,
            label: spec.label || 'EVENT',
            title: feed.title || feed.channel || '',
          };
        } else {
          const fp = filePaths[spec.fileSource || spec.source];
          if (fp) out[q] = { type: 'file', path: fp, label: spec.label || 'CLIPZWORLD' };
          else out[q] = null;
        }
        break;
      }
      case 'file': {
        const fp = filePaths[spec.source];
        if (fp) out[q] = { type: 'file', path: fp, label: spec.label || 'CLIPZWORLD' };
        else out[q] = null;
        break;
      }
      case 'twitch':
      default:
        if (coStreamOrder && q > 0) {
          out[q] = coStreamOrder[coStreamIdx++] || null;
        } else {
          out[q] = pollerAssignments[q] || null;
        }
        break;
    }
  }

  // Fill twitch slots; skip Q0 if feed/file already consumed a poller slot
  if (modeName !== 'grid') {
    let liveIdx = 0;
    for (let q = 0; q < 4; q++) {
      const spec = specs[q] || {};
      if (spec.type === 'twitch' && !out[q] && liveIdx < liveLogins.length) {
        out[q] = liveLogins[liveIdx++];
      }
    }
    // When EVENT feed/file missing, promote first co-stream into Q0 if empty
    if (modeName === 'event_night' && !out[0] && liveLogins.length) {
      out[0] = liveLogins[0];
      liveIdx = Math.max(liveIdx, 1);
    }
  }

  return { sources: out, mode, modeName };
}

class ProgramDirector {
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.configPath = opts.configPath || process.env.LIVE_GRID_PROGRAM_CONFIG || DEFAULT_CONFIG_PATH;
    this.config = loadPrograms(this.configPath);
    this.mode = opts.mode || 'auto';
    this.fileOverrides = opts.fileOverrides || {};
    this.eventTitle = opts.eventTitle || null;
    this.headline = opts.headline || null;
    this._activeMode = 'grid';
    this._lastModeKey = null;
  }

  setOverrides({ eventFile, eventTitle, headline, fileOverrides } = {}) {
    if (eventFile) this.fileOverrides.event_primary = eventFile;
    if (fileOverrides) Object.assign(this.fileOverrides, fileOverrides);
    if (eventTitle) this.eventTitle = eventTitle;
    if (headline) this.headline = headline;
  }

  resolveMode(explicitMode, date = new Date()) {
    const m = String(explicitMode || this.mode || 'auto').toLowerCase();
    if (m !== 'auto' && this.config.modes?.[m]) {
      this._activeMode = m;
      return m;
    }
    const { mode } = resolveScheduledMode(this.config, nowET(date));
    this._activeMode = mode;
    return mode;
  }

  /** Apply program layout; returns merged sources for feeders. */
  layout(pollerAssignments, opts = {}) {
    const modeName = this.resolveMode(opts.programMode);
    let activeEvent = null;
    if (modeName === 'event_night') {
      activeEvent = resolveActiveEvent();
      if (activeEvent) {
        this.eventTitle = opts.eventTitle || activeEvent.eventTitle || this.eventTitle;
        if (activeEvent.eventFile) this.fileOverrides.event_primary = activeEvent.eventFile;
      }
    }
    const filePaths = resolveAllFileSources(this.config, { overrides: this.fileOverrides });
    const feedPaths = opts.feedPaths || {};
    const { sources, mode } = buildQuadrantSources(modeName, this.config, pollerAssignments, filePaths, feedPaths);

    const feedTitle = feedPaths.event_feed?.title;
    const eventTitle = feedTitle || this.eventTitle || mode.eventTitle || 'Live Event';
    const streamers = pollerAssignments.filter(Boolean).slice(0, 2).join(' & ');
    const title = formatTitle(mode.titleTemplate, {
      streamers: streamers || 'ClipzWorld',
      headline: this.headline || mode.headline || 'Live',
      eventTitle,
    });

    const modeKey = `${modeName}:${nowET().dateKey}:${Math.floor(nowET().minutes / 15)}`;
    if (modeKey !== this._lastModeKey) {
      this._lastModeKey = modeKey;
      this.log(`program mode: ${modeName} (${mode.label || modeName})`);
    }

    return {
      mode: modeName,
      modeLabel: mode.label,
      sources,
      title,
      descriptionPrefix: mode.descriptionPrefix || '',
      filePaths,
      feedPaths,
      eventFeed: feedPaths.event_feed || null,
      activeEvent: modeName === 'event_night' ? (activeEvent || resolveActiveEvent()) : null,
      rights: Object.fromEntries(
        Object.entries(this.config.fileSources || {}).map(([k, v]) => [k, v.rights || 'unknown'])
      ),
    };
  }

  status() {
    const et = nowET();
    const scheduled = resolveScheduledMode(this.config, et);
    return {
      activeMode: this._activeMode,
      requestedMode: this.mode,
      scheduledMode: scheduled.mode,
      et,
      modes: Object.keys(this.config.modes || {}),
      configPath: this.configPath,
    };
  }
}

module.exports = {
  ProgramDirector,
  loadPrograms,
  nowET,
  resolveScheduledMode,
  buildQuadrantSources,
  formatTitle,
  parseHm,
  inScheduleBlock,
};
