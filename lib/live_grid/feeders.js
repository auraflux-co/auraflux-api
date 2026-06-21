/**
 * Live Grid — MediaMTX indirection layer: quadrant feeders + slate failover (CPD-943)
 *
 * Each of the 4 grid quadrants is a STABLE local MediaMTX path
 * (rtsp://localhost:8554/quad1..quad4). The master compositor (CPD-944) reads
 * those paths and never restarts; swapping a streamer only restarts that one
 * quadrant's feeder.
 *
 * Feeder process per quadrant:
 *   streamlink --twitch-disable-ads --stdout twitch.tv/<login> 1080p60
 *     | ffmpeg -i pipe:0 -c copy -f mpegts srt://localhost:8890?streamid=publish:quadN
 * (-c copy: Twitch HLS is already h264+aac — no re-encode at the feeder.
 *  Publish is SRT/mpegts because ffmpeg's RTSP muxer rejects ADTS AAC
 *  ("AAC with no global headers") even with aac_adtstoasc — the muxer wants
 *  extradata at header-write time. MediaMTX ingests the TS over SRT and the
 *  master compositor reads it back as RTSP.)
 *
 * Slate failover: a pre-rendered branded loop is published to any quadrant
 * with no live feeder so the master compositor never starves.
 *
 * Name overlays: each quadrant has tmp/live_grid/quadN.txt read by the master
 * compositor's drawtext (textfile=...:reload=1) — names update on swap with
 * no master restart.
 */

const { fleetPoolSize } = require('./fleet_pool');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isAllowedFilePath } = require('./file_sources');
const { assertFeedUrlAllowed } = require('./feed_allowlist');
const { streamlinkAvailable, twitchChannelLive, kickChannelLive } = require('./stream_probe');
const { refreshQuadrantAvatarSync } = require('./avatar_cache');

const { resolveLiveGridFfmpeg } = require('./ffmpeg_path');

const FFMPEG = resolveLiveGridFfmpeg();
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const RETRY_DELAY_MS = parseInt(process.env.LIVE_GRID_FEEDER_RETRY_MS || '5000', 10);
const MAX_RETRY_DELAY_MS = parseInt(process.env.LIVE_GRID_FEEDER_RETRY_MAX_MS || '60000', 10);
const FEED_FAIL_WINDOW_MS = parseInt(process.env.LIVE_GRID_FEED_FAIL_WINDOW_MS || '120000', 10);
const FEED_FAIL_THRESHOLD = parseInt(process.env.LIVE_GRID_FEED_FAIL_THRESHOLD || '5', 10);
const OFFLINE_SWAP_AFTER_RETRIES = parseInt(process.env.LIVE_GRID_OFFLINE_SWAP_RETRIES || '3', 10);

function channelFromFeedUrl(url) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    if (parts[0] === 'c' && parts[1]) return parts[1];
    if (parts[0] === 'live' && parts[1]) return parts[1];
    if (parts[0] === 's' && parts[1]) return parts[1];
    return parts[parts.length - 1];
  } catch {
    return null;
  }
}

function loginsFromSources(sources = []) {
  return sources.map((s) => {
    if (typeof s === 'string') return s;
    if (s && typeof s === 'object' && s.type === 'kick_hold') {
      return s.kickSlug || s.login || null;
    }
    if (s && typeof s === 'object' && s.type === 'url') {
      return s.login || s.kickSlug || channelFromFeedUrl(s.url) || (s.label ? String(s.label).toLowerCase() : null);
    }
    if (s && typeof s === 'object' && s.type === 'file') {
      const label = s.label || path.basename(s.path || '', path.extname(s.path || ''));
      return label ? String(label).toLowerCase().replace(/\s+/g, '_') : null;
    }
    return null;
  });
}

function quadrantDisplayInfo(quad) {
  const slug = quad.login || channelFromFeedUrl(quad.feedUrl);
  let displayName = 'SLATE';
  if (slug) displayName = slug;
  else if (quad.label) displayName = quad.label;
  else if (quad.filePath) displayName = quad.label || path.basename(quad.filePath, path.extname(quad.filePath));
  return { displayName, channelSlug: slug || null };
}

const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const RTSP_BASE = process.env.LIVE_GRID_RTSP_BASE || 'rtsp://localhost:8554';
const SRT_BASE = process.env.LIVE_GRID_SRT_BASE || 'srt://localhost:8890';
const GRID_DIR = path.join(__dirname, '..', '..', 'tmp', 'live_grid');
const SLATE_PATH = path.join(GRID_DIR, 'slate.mp4');
const STALL_TIMEOUT_MS = 15_000;
const PREFETCH_TIMEOUT_MS = parseInt(process.env.LIVE_GRID_FEEDER_PREFETCH_MS || '12000', 10);
const FEEDER_PREFETCH = String(process.env.LIVE_GRID_FEEDER_PREFETCH || 'on').toLowerCase() !== 'off';
const TWITCH_QUALITY = process.env.LIVE_GRID_TWITCH_QUALITY || '1080p60,1080p,720p60,720p,best';
const URL_QUALITY = process.env.LIVE_GRID_URL_QUALITY || 'best';

const { isKickPlaybackUrl, isKickPageUrl, kickSlugFromUrl } = require('../clients/kick_live_resolver');
const {
  hlsFfmpegArgs,
  isKickFeed,
  kickHlsStallTimeoutMs,
  kickPlaylistUrlsEquivalent,
  kickStreamlinkIngestEnabled,
  kickStreamlinkFfmpegEncodeArgs,
  kickHlsTranscodeEnabled,
  kickPageUrl,
} = require('./kick_ingest');

function isHlsFeedUrl(url) {
  return isKickPlaybackUrl(url);
}

/** streamlink args for generic URL feeds (Kick, Trovo, YouTube, etc.) */
function streamlinkUrlArgs(url) {
  const u = String(url).toLowerCase();
  const args = [];
  if (u.includes('kick.com')) args.push('--kick-low-latency');
  if (u.includes('twitch.tv')) args.push('--twitch-disable-ads', '--twitch-low-latency');
  args.push('--stdout', url, URL_QUALITY);
  return args;
}

function ensureGridDir() {
  fs.mkdirSync(GRID_DIR, { recursive: true });
}

// ClipzWorld News brand (mirrors config/customers/c0.json chrome colors)
const BRAND = {
  background: '0x0d1424', // dark navy — single fill for frame, strips, letterbox
  primary: '0x0d1424',      // match background (no two-tone navy)
  accent: '0xc7af4f',     // gold
  fontHead: path.join(__dirname, '..', '..', 'assets', 'fonts', 'BebasNeue-Regular.ttf'),
  fontBody: path.join(__dirname, '..', '..', 'assets', 'fonts', 'BarlowCondensed-SemiBold.ttf'),
  logo: path.join(__dirname, '..', '..', 'assets', 'cwn_logo.png'),
};

function ffEsc(p) { return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:'); }

/** Pre-render the ClipzWorld-branded offline slate (idempotent). */
function generateSlate(cb) {
  ensureGridDir();
  if (fs.existsSync(SLATE_PATH)) {
    try {
      const { execFileSync } = require('child_process');
      const w = execFileSync(FFPROBE, [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', SLATE_PATH,
      ], { encoding: 'utf8' }).trim();
      if (w === '1920') return cb && cb(null, SLATE_PATH);
      fs.unlinkSync(SLATE_PATH);
    } catch (_) {
      if (fs.existsSync(SLATE_PATH)) return cb && cb(null, SLATE_PATH);
    }
  }
  const head = `fontfile='${ffEsc(BRAND.fontHead)}':`;
  const body = `fontfile='${ffEsc(BRAND.fontBody)}':`;
  const hasLogo = fs.existsSync(BRAND.logo);

  const draw =
    // gold accent bars above and below the wordmark
    `drawbox=x=(iw-520)/2:y=300:w=520:h=4:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=(iw-520)/2:y=470:w=520:h=4:color=${BRAND.accent}@1:t=fill,` +
    `drawtext=${head}text='CLIPZWORLD LIVE':fontsize=110:fontcolor=${BRAND.accent}:x=(w-text_w)/2:y=330,` +
    `drawtext=${body}text='NEXT STREAMER LOADING':fontsize=34:fontcolor=white@0.65:x=(w-text_w)/2:y=505`;

  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${BRAND.background}:s=1920x1080:d=5:r=30`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
  if (hasLogo) {
    args.push('-i', BRAND.logo,
      '-filter_complex', `[0:v]${draw}[bg];[2:v]scale=150:-1[logo];[bg][logo]overlay=(W-w)/2:120[v]`,
      '-map', '[v]', '-map', '1:a');
  } else {
    args.push('-vf', draw, '-map', '0:v', '-map', '1:a');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '5', SLATE_PATH);
  execFile(FFMPEG, args, err => cb && cb(err, SLATE_PATH));
}

function quadUrl(q) { return `${RTSP_BASE}/quad${q + 1}`; }                       // read side (master)
function quadPublishUrl(q) { return `${SRT_BASE}?streamid=publish:quad${q + 1}`; } // write side (feeders)
function nameFile(q) { return path.join(GRID_DIR, `quad${q + 1}.txt`); }

function writeNameFile(q, text) {
  ensureGridDir();
  // Write-then-rename so drawtext reload never reads a half-written file
  const tmp = nameFile(q) + '.tmp';
  fs.writeFileSync(tmp, (text || '').toUpperCase());
  fs.renameSync(tmp, nameFile(q));
}

class QuadrantFeeders {
  /**
   * @param {Object} opts { log: fn(msg) }
   */
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid] ${m}`));
    const n = fleetPoolSize();
    // per quadrant: { login, filePath, feedUrl, label, kind: 'channel'|'file'|'url'|'slate'|null, ... }
    this.quads = Array.from({ length: n }, () => ({
      login: null, filePath: null, feedUrl: null, label: null, kind: null,
      kickSlug: null,
      pendingKickSlug: null,
      pendingLogin: null, pendingUrl: null, retryAttempt: 0,
      procs: [], stallTimer: null, retryTimer: null, gen: 0, probeGen: 0,
      feedFailures: 0, feedFailureWindowStart: 0, feedUnhealthy: false,
    }));
    this.stopped = false;
  }

  _clearFeedHealth(quad) {
    quad.feedFailures = 0;
    quad.feedFailureWindowStart = 0;
    quad.feedUnhealthy = false;
  }

  _noteFeedFailure(q, reason) {
    const quad = this.quads[q];
    const now = Date.now();
    if (!quad.feedFailureWindowStart || now - quad.feedFailureWindowStart > FEED_FAIL_WINDOW_MS) {
      quad.feedFailureWindowStart = now;
      quad.feedFailures = 0;
    }
    quad.feedFailures++;
    if (quad.feedFailures < FEED_FAIL_THRESHOLD || quad.feedUnhealthy) return;
    quad.feedUnhealthy = true;
    this.log(`quad${q + 1}: feed unhealthy (${quad.feedFailures} failures/${FEED_FAIL_WINDOW_MS / 1000}s) — ${reason}`);
    this.onFeedUnhealthy?.(q, {
      login: quad.login,
      feedUrl: quad.feedUrl,
      label: quad.label,
      kind: quad.kind,
    });
  }

  /** Point quadrant q at a streamer login, or null for slate. */
  setQuadrant(q, login) {
    const quad = this.quads[q];
    const nextKind = login ? 'channel' : 'slate';
    if (quad.pendingLogin === login && quad.kind === nextKind && !quad.filePath && !quad.feedUrl) return;
    if (quad.login === login && quad.kind === 'channel' && !quad.filePath && !quad.feedUrl && quad.procs.length) {
      writeNameFile(q, login);
      refreshQuadrantAvatarSync(q, login);
      return;
    }
    quad.probeGen++;
    quad.pendingLogin = login;
    quad.pendingUrl = null;
    quad.filePath = null;
    quad.feedUrl = null;
    quad.label = null;
    if (login) this._beginChannel(q, login);
    else {
      quad.retryAttempt = 0;
      this.log(`quad${q + 1}: ${quad.login || quad.kind || 'empty'} → slate`);
      this._kill(q);
      quad.kind = 'slate';
      writeNameFile(q, quadrantDisplayInfo(quad).displayName);
      refreshQuadrantAvatarSync(q, null);
      this._startSlate(q);
    }
  }

  /**
   * Kick channel on quadrant q — same probe → slate → retry loop as Twitch (CPD-1065).
   * Uses streamlink on kick.com/{slug} when LIVE_GRID_KICK_INGEST is not hls.
   */
  setQuadrantKick(q, slug, opts = {}) {
    const kickSlug = String(slug || '').trim().toLowerCase();
    if (!kickSlug) throw new Error('Kick slug required');
    const quad = this.quads[q];
    const pageUrl = kickPageUrl(kickSlug);
    if (quad.kickSlug === kickSlug && quad.kind === 'url' && quad.procs.length && quad.feedUrl === pageUrl) {
      writeNameFile(q, opts.label || kickSlug);
      return;
    }
    quad.probeGen++;
    quad.pendingKickSlug = kickSlug;
    quad.pendingLogin = null;
    quad.pendingUrl = pageUrl;
    quad.kickSlug = kickSlug;
    quad.login = kickSlug;
    quad.label = opts.label || kickSlug;
    quad.filePath = null;
    quad.feedUrl = null;
    if (kickStreamlinkIngestEnabled()) {
      this._beginKickChannel(q, kickSlug, opts);
      return;
    }
    if (opts.feedUrl) {
      this.setQuadrantUrl(q, opts.feedUrl, opts.label || kickSlug, {
        login: kickSlug,
        kickSlug,
      });
    }
  }

  /** Loop a local file into quadrant q (CPD-1018). */
  setQuadrantFile(q, filePath, label = 'CLIPZWORLD') {
    const abs = path.resolve(filePath);
    if (!isAllowedFilePath(abs)) throw new Error(`file not in allowed roots: ${filePath}`);
    const quad = this.quads[q];
    if (quad.filePath === abs && quad.kind === 'file') return;
    this.log(`quad${q + 1}: ${quad.label || quad.login || quad.feedUrl || quad.kind || 'empty'} → file:${path.basename(abs)}`);
    this._kill(q);
    quad.pendingLogin = null;
    quad.pendingUrl = null;
    quad.login = null;
    quad.filePath = abs;
    quad.feedUrl = null;
    quad.label = label || path.basename(abs, path.extname(abs));
    writeNameFile(q, quad.label);
    this._startFile(q, abs);
  }

  /** Allowlisted live URL into quadrant q (CPD-1030) — YouTube/Twitch/public via streamlink. */
  setQuadrantUrl(q, feedUrl, label, opts = {}) {
    let url = assertFeedUrlAllowed(feedUrl);
    const quad = this.quads[q];
    const kickSlug = opts.kickSlug || quad.kickSlug || kickSlugFromUrl(url) || opts.login || quad.login;
    const kick = isKickFeed({ kickSlug, url });
    if (kick && kickStreamlinkIngestEnabled() && kickSlug) {
      url = kickPageUrl(kickSlug) || url;
    }
    if (quad.feedUrl === url && quad.kind === 'url' && quad.procs.length) return;
    if (kick && !kickStreamlinkIngestEnabled() && quad.kind === 'url' && quad.procs.length
      && kickPlaylistUrlsEquivalent(quad.feedUrl, url)) {
      return this.refreshKickHlsUrl(q, url, opts);
    }
    this.log(`quad${q + 1}: ${quad.label || quad.login || quad.kind || 'empty'} → url:${url.slice(0, 60)}…`);
    this._kill(q);
    quad.pendingLogin = null;
    quad.pendingUrl = url;
    quad.login = opts.login || kickSlug || channelFromFeedUrl(url) || null;
    quad.kickSlug = kick ? (kickSlug || quad.login || null) : null;
    quad.filePath = null;
    quad.feedUrl = url;
    quad.label = label || null;
    writeNameFile(q, quadrantDisplayInfo(quad).displayName);
    this._startUrl(q, url);
  }

  /** Kick signed-URL token refresh — same playlist, new token; minimal feeder restart. */
  refreshKickHlsUrl(q, feedUrl, opts = {}) {
    const url = assertFeedUrlAllowed(feedUrl);
    const quad = this.quads[q];
    quad.feedUrl = url;
    quad.kickSlug = opts.kickSlug || quad.kickSlug || opts.login || quad.login || null;
    if (opts.login) quad.login = opts.login;
    if (opts.label) quad.label = opts.label;
    this.log(`quad${q + 1}: Kick HLS token refresh (${quad.kickSlug || 'kick'})`);
    const gen = ++quad.gen;
    clearTimeout(quad.stallTimer);
    clearTimeout(quad.retryTimer);
    for (const p of quad.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
    quad.procs = [];
    quad.kind = 'url';
    this._startHlsUrl(q, url, { kickSlug: quad.kickSlug, _refreshGen: gen });
  }

  _retryDelayMs(quad) {
    const attempt = quad.retryAttempt || 0;
    return Math.min(RETRY_DELAY_MS * (2 ** attempt), MAX_RETRY_DELAY_MS);
  }

  _scheduleChannelRetry(q, login) {
    const quad = this.quads[q];
    clearTimeout(quad.retryTimer);
    const delay = this._retryDelayMs(quad);
    quad.retryAttempt = (quad.retryAttempt || 0) + 1;
    quad.retryTimer = setTimeout(() => {
      if (this.stopped || quad.pendingLogin !== login) return;
      this._beginChannel(q, login);
    }, delay);
    quad.retryTimer.unref?.();
  }

  /** Probe Twitch first — stay on slate if offline to avoid streamlink hammering. */
  _beginChannel(q, login) {
    const quad = this.quads[q];
    const prev = quad.login || quad.kind || 'empty';
    const probeGen = quad.probeGen;
    twitchChannelLive(login).then((live) => {
      if (this.stopped || quad.pendingLogin !== login || quad.probeGen !== probeGen) return;
      if (live) {
        if (quad.kind === 'channel' && quad.login === login && quad.procs.length) return;
        if (FEEDER_PREFETCH && quad.kind === 'channel' && quad.login && quad.login !== login && quad.procs.length) {
          this._prefetchChannelSwap(q, login, prev);
          return;
        }
        this.log(`quad${q + 1}: ${prev} → ${login}`);
        this._kill(q);
        quad.login = login;
        quad.retryAttempt = 0;
        if (quad.pendingLogin === login) writeNameFile(q, login);
        refreshQuadrantAvatarSync(q, login);
        this._startChannel(q, login);
        return;
      }
      this.log(`quad${q + 1}: ${login} offline — holding slate (retry in ${this._retryDelayMs(quad) / 1000}s)`);
      if ((quad.retryAttempt || 0) >= OFFLINE_SWAP_AFTER_RETRIES) {
        this.log(`quad${q + 1}: ${login} offline ${quad.retryAttempt}× — releasing seat for bench fill`);
        quad.pendingLogin = null;
        this.onChannelOffline?.(q, login);
        if (quad.kind !== 'slate') {
          this._kill(q);
          this._startSlate(q);
        }
        return;
      }
      this.onChannelOffline?.(q, login);
      if (quad.pendingLogin === login) {
        writeNameFile(q, login);
        refreshQuadrantAvatarSync(q, login);
        quad.login = login;
      }
      if (quad.kind !== 'slate') {
        this._kill(q);
        this._startSlate(q);
      }
      this._scheduleChannelRetry(q, login);
    }).catch(() => {
      if (this.stopped || quad.pendingLogin !== login || quad.probeGen !== probeGen) return;
      this._scheduleChannelRetry(q, login);
    });
  }

  /** Probe Kick via streamlink — stay on slate if offline (mirrors Twitch _beginChannel). */
  _beginKickChannel(q, kickSlug, opts = {}) {
    const quad = this.quads[q];
    const prev = quad.label || quad.kickSlug || quad.kind || 'empty';
    const probeGen = quad.probeGen;
    const pageUrl = kickPageUrl(kickSlug);
    kickChannelLive(kickSlug).then((live) => {
      if (this.stopped || quad.pendingKickSlug !== kickSlug || quad.probeGen !== probeGen) return;
      if (live) {
        if (quad.kind === 'url' && quad.kickSlug === kickSlug && quad.procs.length) return;
        this.log(`quad${q + 1}: ${prev} → ${kickSlug} (kick)`);
        this._kill(q);
        quad.kickSlug = kickSlug;
        quad.login = kickSlug;
        quad.retryAttempt = 0;
        quad.feedUrl = pageUrl;
        quad.label = opts.label || kickSlug;
        if (quad.pendingKickSlug === kickSlug) writeNameFile(q, kickSlug);
        refreshQuadrantAvatarSync(q, kickSlug);
        this._startKickStreamlink(q, pageUrl);
        return;
      }
      this.log(`quad${q + 1}: ${kickSlug} offline — holding slate (retry in ${this._retryDelayMs(quad) / 1000}s)`);
      if ((quad.retryAttempt || 0) >= OFFLINE_SWAP_AFTER_RETRIES) {
        this.log(`quad${q + 1}: ${kickSlug} offline ${quad.retryAttempt}× — releasing seat`);
        quad.pendingKickSlug = null;
        this.onChannelOffline?.(q, kickSlug);
        if (quad.kind !== 'slate') {
          this._kill(q);
          this._startSlate(q);
        }
        return;
      }
      this.onChannelOffline?.(q, kickSlug);
      if (quad.pendingKickSlug === kickSlug) {
        writeNameFile(q, kickSlug);
        refreshQuadrantAvatarSync(q, kickSlug);
        quad.kickSlug = kickSlug;
        quad.login = kickSlug;
      }
      if (quad.kind !== 'slate') {
        this._kill(q);
        this._startSlate(q);
      }
      this._scheduleKickRetry(q, kickSlug);
    }).catch(() => {
      if (this.stopped || quad.pendingKickSlug !== kickSlug || quad.probeGen !== probeGen) return;
      this._scheduleKickRetry(q, kickSlug);
    });
  }

  _scheduleKickRetry(q, kickSlug) {
    const quad = this.quads[q];
    clearTimeout(quad.retryTimer);
    const delay = this._retryDelayMs(quad);
    quad.retryAttempt = (quad.retryAttempt || 0) + 1;
    quad.retryTimer = setTimeout(() => {
      if (this.stopped || quad.pendingKickSlug !== kickSlug) return;
      this._beginKickChannel(q, kickSlug);
    }, delay);
    quad.retryTimer.unref?.();
  }

  _abortPrefetch(q) {
    const quad = this.quads[q];
    if (!quad._prefetch) return;
    clearTimeout(quad._prefetch.timeout);
    try { quad._prefetch.sl.kill('SIGKILL'); } catch (_) {}
    quad._prefetch = null;
  }

  _kill(q) {
    const quad = this.quads[q];
    this._abortPrefetch(q);
    quad.gen++; // invalidate exit/stall handlers from the previous process set
    clearTimeout(quad.stallTimer);
    clearTimeout(quad.retryTimer);
    if (quad.procs.length >= 2) {
      const [sl, ff] = quad.procs;
      try { sl.stdout?.unpipe(ff.stdin); } catch (_) { /* EPIPE ok */ }
    }
    for (const p of quad.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
    quad.procs = [];
    quad.kind = null;
    quad.filePath = null;
    quad.feedUrl = null;
    quad.label = null;
    quad._liveNotified = false;
  }

  _failoverKick(q, kickSlug, url) {
    const quad = this.quads[q];
    quad.pendingKickSlug = kickSlug;
    quad.kickSlug = kickSlug;
    quad.login = kickSlug;
    quad.feedUrl = url || kickPageUrl(kickSlug);
    writeNameFile(q, kickSlug);
    if (quad.kind !== 'slate') {
      this.log(`quad${q + 1}: ${kickSlug} dropped — slate until back online`);
      this.onChannelOffline?.(q, kickSlug);
      this._kill(q);
      this._startSlate(q);
    }
    this._scheduleKickRetry(q, kickSlug);
  }

  /** Warm streamlink before killing the old feeder — keeps RTSP/UDP alive for the relay. */
  _prefetchChannelSwap(q, login, prevLabel) {
    const quad = this.quads[q];
    if (quad._prefetch?.login === login) return;
    this._abortPrefetch(q);

    const sl = spawn(STREAMLINK, [
      '--twitch-disable-ads', '--twitch-low-latency',
      '--stdout', `twitch.tv/${login}`, TWITCH_QUALITY
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const coldSwap = () => {
      if (this.stopped || quad.pendingLogin !== login) return;
      this._abortPrefetch(q);
      this.log(`quad${q + 1}: ${prevLabel} → ${login} (cold swap)`);
      this._kill(q);
      quad.login = login;
      quad.retryAttempt = 0;
      writeNameFile(q, login);
      refreshQuadrantAvatarSync(q, login);
      this._startChannel(q, login);
    };

    const timeout = setTimeout(coldSwap, PREFETCH_TIMEOUT_MS);
    quad._prefetch = { sl, login, timeout };

    const handoff = () => {
      clearTimeout(timeout);
      if (this.stopped || quad.pendingLogin !== login || quad._prefetch?.sl !== sl) {
        try { sl.kill('SIGKILL'); } catch (_) {}
        if (quad._prefetch?.sl === sl) quad._prefetch = null;
        return;
      }
      quad._prefetch = null;
      this.log(`quad${q + 1}: ${prevLabel} → ${login} (prefetch handoff)`);
      quad.gen++;
      clearTimeout(quad.stallTimer);
      clearTimeout(quad.retryTimer);
      if (quad.procs.length >= 2) {
        const [oldSl, oldFf] = quad.procs;
        try { oldSl.stdout?.unpipe(oldFf.stdin); } catch (_) { /* EPIPE ok */ }
      }
      for (const p of quad.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
      quad.procs = [];
      quad.login = login;
      quad.retryAttempt = 0;
      if (quad.pendingLogin === login) writeNameFile(q, login);
      refreshQuadrantAvatarSync(q, login);
      this._wireChannelProcs(q, login, sl);
    };

    sl.stdout.once('data', handoff);
    sl.on('exit', (code) => {
      if (quad._prefetch?.sl !== sl) return;
      clearTimeout(timeout);
      quad._prefetch = null;
      if (this.stopped || quad.pendingLogin !== login) return;
      if (quad.kind === 'channel' && quad.login === login && quad.procs.length) return;
      this.log(`quad${q + 1}: prefetch ${login} lost before handoff (${code}) — cold swap`);
      coldSwap();
    });
    sl.stderr.on('data', () => {});
  }

  _startChannel(q, login) {
    const sl = spawn(STREAMLINK, [
      '--twitch-disable-ads', '--twitch-low-latency',
      '--stdout', `twitch.tv/${login}`, TWITCH_QUALITY
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this._wireChannelProcs(q, login, sl);
  }

  _pipeStreamToFfmpeg(sl, ff) {
    const swallowPipeErr = (err) => {
      if (err?.code === 'EPIPE') return;
    };
    sl.stdout.on('error', swallowPipeErr);
    ff.stdin.on('error', swallowPipeErr);
    sl.stdout.pipe(ff.stdin);
  }

  _wireChannelProcs(q, login, sl) {
    const quad = this.quads[q];
    const gen = quad.gen;
    quad.kind = 'channel';

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0', '-c', 'copy',
      '-f', 'mpegts', quadPublishUrl(q)
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this._pipeStreamToFfmpeg(sl, ff);
    quad.procs = [sl, ff];

    const bumpStall = () => {
      if (quad.gen !== gen) return;
      clearTimeout(quad.stallTimer);
      quad.stallTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped) return;
        this.log(`quad${q + 1}: ${login} stalled ${STALL_TIMEOUT_MS / 1000}s — slate + retry`);
        this._failover(q, login);
      }, STALL_TIMEOUT_MS);
    };
    bumpStall();
    sl.stdout.on('data', () => {
      bumpStall();
      quad.retryAttempt = 0;
      this._clearFeedHealth(quad);
      if (!quad._liveNotified) {
        quad._liveNotified = true;
        this.onFeederLive?.(q, login);
      }
    });

    const onExit = (which) => (code) => {
      if (quad.gen !== gen || this.stopped) return;
      this._noteFeedFailure(q, `${which} for ${login} exited (${code})`);
      this.log(`quad${q + 1}: ${which} for ${login} exited (${code}) — slate + retry in ${this._retryDelayMs(quad) / 1000}s`);
      this._failover(q, login);
    };
    sl.on('exit', onExit('streamlink'));
    ff.on('exit', onExit('ffmpeg'));
    ff.stderr.on('data', () => {});
    sl.stderr.on('data', () => {});
  }

  _startUrl(q, url) {
    const quad = this.quads[q];
    const kickPage = isKickPageUrl(url);
    const kick = kickPage || isKickFeed({ kickSlug: quad.kickSlug, url });
    if (!kickPage && isHlsFeedUrl(url)) {
      this._startHlsUrl(q, url);
      return;
    }
    if (kickPage && kick && kickHlsTranscodeEnabled()) {
      this._startKickStreamlink(q, url);
      return;
    }
    const gen = quad.gen;
    quad.kind = 'url';

    const sl = spawn(STREAMLINK, streamlinkUrlArgs(url), { stdio: ['ignore', 'pipe', 'pipe'] });

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0', '-c', 'copy',
      '-f', 'mpegts', quadPublishUrl(q),
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this._pipeStreamToFfmpeg(sl, ff);
    quad.procs = [sl, ff];

    const bumpStall = () => {
      if (quad.gen !== gen) return;
      clearTimeout(quad.stallTimer);
      quad.stallTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped) return;
        this.log(`quad${q + 1}: feed stalled ${STALL_TIMEOUT_MS / 1000}s — slate + retry`);
        this._failoverUrl(q, url);
      }, STALL_TIMEOUT_MS);
    };
    bumpStall();
    sl.stdout.on('data', () => {
      bumpStall();
      this._clearFeedHealth(quad);
    });

    const onExit = (which) => (code) => {
      if (quad.gen !== gen || this.stopped) return;
      this._noteFeedFailure(q, `${which} for feed exited (${code})`);
      this.log(`quad${q + 1}: ${which} for feed exited (${code}) — slate + retry in ${RETRY_DELAY_MS / 1000}s`);
      this._failoverUrl(q, url);
    };
    sl.on('exit', onExit('streamlink'));
    ff.on('exit', onExit('ffmpeg'));
    ff.stderr.on('data', () => {});
    sl.stderr.on('data', () => {});
  }

  /** Kick page URL via streamlink → transcode to clean H.264 (CPD-1065 streamlink ingest). */
  _startKickStreamlink(q, url) {
    const quad = this.quads[q];
    const gen = quad.gen;
    quad.kind = 'url';
    const stallMs = STALL_TIMEOUT_MS;

    const sl = spawn(STREAMLINK, streamlinkUrlArgs(url), { stdio: ['ignore', 'pipe', 'pipe'] });
    const ff = spawn(FFMPEG, [
      ...kickStreamlinkFfmpegEncodeArgs(),
      '-f', 'mpegts', quadPublishUrl(q),
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    this._pipeStreamToFfmpeg(sl, ff);
    quad.procs = [sl, ff];

    let errTail = '';
    const bumpStall = () => {
      if (quad.gen !== gen) return;
      clearTimeout(quad.stallTimer);
      quad.stallTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped) return;
        this.log(`quad${q + 1}: Kick streamlink stalled ${stallMs / 1000}s — slate + retry`);
        this._failoverUrl(q, url);
      }, stallMs);
    };
    bumpStall();
    sl.stdout.on('data', () => {
      bumpStall();
      quad.retryAttempt = 0;
      this._clearFeedHealth(quad);
      if (!quad._liveNotified) {
        quad._liveNotified = true;
        this.onFeederLive?.(q, quad.kickSlug || quad.login);
      }
    });
    ff.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-800);
      bumpStall();
      this._clearFeedHealth(quad);
    });

    const onExit = (which) => (code) => {
      if (quad.gen !== gen || this.stopped) return;
      if (which === 'ffmpeg' && errTail.trim()) {
        this.log(`quad${q + 1}: Kick streamlink stderr: ${errTail.trim().split('\n').slice(-2).join(' | ')}`);
      }
      this._noteFeedFailure(q, `${which} Kick streamlink exited (${code})`);
      this.log(`quad${q + 1}: ${which} Kick streamlink exited (${code}) — slate + retry in ${this._retryDelayMs(quad) / 1000}s`);
      this._failoverKick(q, quad.kickSlug || kickSlugFromUrl(url) || quad.login, url);
    };
    sl.on('exit', onExit('streamlink'));
    ff.on('exit', onExit('ffmpeg'));
    sl.stderr.on('data', () => {});
  }

  /** Signed HLS (Kick CDN, etc.) — ffmpeg with reconnect; Kick transcodes to clean H.264. */
  _startHlsUrl(q, url, opts = {}) {
    const quad = this.quads[q];
    const gen = opts._refreshGen != null ? opts._refreshGen : quad.gen;
    quad.kind = 'url';
    const kickSlug = opts.kickSlug || quad.kickSlug || null;
    const kick = isKickFeed({ kickSlug, url });
    if (kick) quad.kickSlug = kickSlug || quad.login;

    const ff = spawn(FFMPEG, [
      ...hlsFfmpegArgs(url, { kickSlug: quad.kickSlug, url }),
      '-f', 'mpegts', quadPublishUrl(q),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    quad.procs = [ff];

    const stallMs = kick ? kickHlsStallTimeoutMs() : STALL_TIMEOUT_MS;
    let errTail = '';
    const bumpStall = () => {
      if (quad.gen !== gen) return;
      clearTimeout(quad.stallTimer);
      quad.stallTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped) return;
        this.log(`quad${q + 1}: HLS feed stalled ${stallMs / 1000}s — slate + retry`);
        this._failoverUrl(q, url);
      }, stallMs);
    };
    bumpStall();
    ff.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-800);
      bumpStall();
      this._clearFeedHealth(quad);
    });

    ff.on('exit', (code) => {
      if (quad.gen !== gen || this.stopped) return;
      if (errTail.trim()) {
        this.log(`quad${q + 1}: HLS stderr: ${errTail.trim().split('\n').slice(-2).join(' | ')}`);
      }
      this._noteFeedFailure(q, `ffmpeg HLS exited (${code})`);
      this.log(`quad${q + 1}: ffmpeg HLS exited (${code}) — slate + retry in ${RETRY_DELAY_MS / 1000}s`);
      this._failoverUrl(q, url);
    });
  }

  _failoverUrl(q, url) {
    const quad = this.quads[q];
    const kickSlug = quad.kickSlug || (isKickPageUrl(url) ? kickSlugFromUrl(url) : null);
    if (kickSlug && kickStreamlinkIngestEnabled()) {
      return this._failoverKick(q, kickSlug, url);
    }
    this._kill(q);
    quad.feedUrl = url;
    this._startSlate(q);
    const delay = this._retryDelayMs(quad);
    quad.retryAttempt = (quad.retryAttempt || 0) + 1;
    quad.retryTimer = setTimeout(() => {
      if (this.stopped || quad.feedUrl !== url) return;
      this._kill(q);
      quad.feedUrl = url;
      quad.kind = 'url';
      this._startUrl(q, url);
    }, delay);
    quad.retryTimer.unref?.();
  }

  /** Publish slate now, retry the channel after a delay. */
  _failover(q, login) {
    const quad = this.quads[q];
    quad.pendingLogin = login;
    quad.login = login;
    writeNameFile(q, login);
    if (quad.kind !== 'slate') {
      this.log(`quad${q + 1}: ${login} dropped — slate until back online`);
      this.onChannelOffline?.(q, login);
      this._kill(q);
      this._startSlate(q);
    }
    this._scheduleChannelRetry(q, login);
  }

  _startFile(q, filePath) {
    const quad = this.quads[q];
    const gen = quad.gen;
    quad.kind = 'file';

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning',
      '-re', '-stream_loop', '-1', '-i', filePath,
      '-c', 'copy', '-f', 'mpegts', quadPublishUrl(q),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    quad.procs = [ff];
    ff.stderr.on('data', () => {});
    ff.on('exit', (code) => {
      if (quad.gen !== gen || this.stopped) return;
      this.log(`quad${q + 1}: file feeder exited (${code}) — retry in ${RETRY_DELAY_MS / 1000}s`);
      quad.retryTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped || quad.filePath !== filePath) return;
        this._kill(q);
        quad.filePath = filePath;
        quad.kind = 'file';
        this._startFile(q, filePath);
      }, RETRY_DELAY_MS);
    });
  }

  _startSlate(q) {
    const quad = this.quads[q];
    const gen = quad.gen;
    quad.kind = 'slate';
    // keep quad.login / pendingLogin — slate shows who we're waiting for

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-re', '-stream_loop', '-1', '-i', SLATE_PATH,
      '-c', 'copy', '-f', 'mpegts', quadPublishUrl(q)
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    quad.procs = [ff];
    ff.stderr.on('data', () => {});
    ff.on('exit', (code) => {
      if (quad.gen !== gen || this.stopped) return;
      this.log(`quad${q + 1}: slate exited (${code}) — restarting slate in 2s`);
      quad.retryTimer = setTimeout(() => {
        if (quad.gen !== gen || this.stopped) return;
        this._kill(q);
        this._startSlate(q);
      }, 2000);
    });
  }

  /** Keep drawtext name tags aligned with operator assignments (survives async probe races). */
  syncNameFiles() {
    for (let q = 0; q < 4; q++) {
      writeNameFile(q, quadrantDisplayInfo(this.quads[q]).displayName);
    }
  }

  /** Apply merged sources: null | login | { type:'file'|'url', ... }. */
  applySources(sources) {
    for (let q = 0; q < 4; q++) {
      const s = sources[q];
      if (s && typeof s === 'object' && s.type === 'file') {
        this.setQuadrantFile(q, s.path, s.label);
      } else if (s && typeof s === 'object' && s.type === 'kick_hold') {
        this.setQuadrantKick(q, s.kickSlug || s.login, { label: s.label || s.kickSlug });
      } else if (s && typeof s === 'object' && s.type === 'url') {
        this.setQuadrantUrl(q, s.url, s.label, { login: s.login, kickSlug: s.kickSlug });
      } else {
        this.setQuadrant(q, s || null);
      }
    }
  }

  /** @deprecated use applySources — poller-only twitch assignments */
  applyAssignments(assignments) {
    this.applySources(assignments);
  }

  status() {
    return this.quads.map((quad, q) => {
      const { displayName, channelSlug } = quadrantDisplayInfo(quad);
      return {
        quadrant: q + 1,
        login: quad.login,
        label: quad.label,
        displayName,
        channelSlug,
        filePath: quad.filePath,
        feedUrl: quad.feedUrl,
        kind: quad.kind,
        url: quadUrl(q),
        pids: quad.procs.map(p => p.pid),
        feedUnhealthy: !!quad.feedUnhealthy,
        feedFailures: quad.feedFailures || 0,
      };
    });
  }

  stopQuadrant(q) {
    if (q < 0 || q > 3) return;
    this._kill(q);
  }

  stopAll() {
    this.stopped = true;
    for (let q = 0; q < 4; q++) this._kill(q);
  }
}

module.exports = { QuadrantFeeders, generateSlate, quadUrl, quadPublishUrl, nameFile, writeNameFile, GRID_DIR, SLATE_PATH, BRAND, channelFromFeedUrl, loginsFromSources, quadrantDisplayInfo };
