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

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isAllowedFilePath } = require('./file_sources');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RETRY_DELAY_MS = parseInt(process.env.LIVE_GRID_FEEDER_RETRY_MS || '5000', 10);
const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const RTSP_BASE = process.env.LIVE_GRID_RTSP_BASE || 'rtsp://localhost:8554';
const SRT_BASE = process.env.LIVE_GRID_SRT_BASE || 'srt://localhost:8890';
const GRID_DIR = path.join(__dirname, '..', '..', 'tmp', 'live_grid');
const SLATE_PATH = path.join(GRID_DIR, 'slate.mp4');
const STALL_TIMEOUT_MS = 15_000;
const TWITCH_QUALITY = process.env.LIVE_GRID_TWITCH_QUALITY || '1080p60,1080p,720p60,720p,best';

function ensureGridDir() {
  fs.mkdirSync(GRID_DIR, { recursive: true });
}

// ClipzWorld News brand (mirrors config/customers/c0.json chrome colors)
const BRAND = {
  background: '0x0d1424', // dark navy
  primary: '0x22304b',    // navy
  accent: '0xc7af4f',     // gold
  fontHead: path.join(__dirname, '..', '..', 'assets', 'fonts', 'BebasNeue-Regular.ttf'),
  fontBody: path.join(__dirname, '..', '..', 'assets', 'fonts', 'BarlowCondensed-SemiBold.ttf'),
  logo: path.join(__dirname, '..', '..', 'assets', 'cwn_logo.png'),
};

function ffEsc(p) { return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:'); }

/** Pre-render the ClipzWorld-branded offline slate (idempotent). */
function generateSlate(cb) {
  ensureGridDir();
  if (fs.existsSync(SLATE_PATH)) return cb && cb(null, SLATE_PATH);
  const head = `fontfile='${ffEsc(BRAND.fontHead)}':`;
  const body = `fontfile='${ffEsc(BRAND.fontBody)}':`;
  const hasLogo = fs.existsSync(BRAND.logo);

  const draw =
    // gold accent bars above and below the wordmark
    `drawbox=x=(iw-520)/2:y=300:w=520:h=4:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=(iw-520)/2:y=470:w=520:h=4:color=${BRAND.accent}@1:t=fill,` +
    `drawtext=${head}text='CLIPZWORLD LIVE':fontsize=110:fontcolor=${BRAND.accent}:x=(w-text_w)/2:y=330,` +
    `drawtext=${body}text='NEXT STREAMER LOADING':fontsize=34:fontcolor=white@0.65:x=(w-text_w)/2:y=505`;

  const args = ['-y', '-f', 'lavfi', '-i', `color=c=${BRAND.background}:s=1280x720:d=5:r=30`,
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
    // per quadrant: { login, filePath, label, kind: 'channel'|'file'|'slate'|null, ... }
    this.quads = [0, 1, 2, 3].map(() => ({
      login: null, filePath: null, label: null, kind: null,
      procs: [], stallTimer: null, retryTimer: null, gen: 0,
    }));
    this.stopped = false;
  }

  /** Point quadrant q at a streamer login, or null for slate. */
  setQuadrant(q, login) {
    const quad = this.quads[q];
    const nextKind = login ? 'channel' : 'slate';
    if (quad.login === login && quad.kind === nextKind && !quad.filePath) return;
    this.log(`quad${q + 1}: ${quad.label || quad.login || quad.kind || 'empty'} → ${login || 'slate'}`);
    this._kill(q);
    quad.login = login;
    quad.filePath = null;
    quad.label = null;
    writeNameFile(q, login || '');
    if (login) this._startChannel(q, login);
    else this._startSlate(q);
  }

  /** Loop a local file into quadrant q (CPD-1018). */
  setQuadrantFile(q, filePath, label = 'CLIPZWORLD') {
    const abs = path.resolve(filePath);
    if (!isAllowedFilePath(abs)) throw new Error(`file not in allowed roots: ${filePath}`);
    const quad = this.quads[q];
    if (quad.filePath === abs && quad.kind === 'file') return;
    this.log(`quad${q + 1}: ${quad.label || quad.login || quad.kind || 'empty'} → file:${path.basename(abs)}`);
    this._kill(q);
    quad.login = null;
    quad.filePath = abs;
    quad.label = label || path.basename(abs, path.extname(abs));
    writeNameFile(q, quad.label);
    this._startFile(q, abs);
  }

  _kill(q) {
    const quad = this.quads[q];
    quad.gen++; // invalidate exit/stall handlers from the previous process set
    clearTimeout(quad.stallTimer);
    clearTimeout(quad.retryTimer);
    for (const p of quad.procs) { try { p.kill('SIGKILL'); } catch (_) {} }
    quad.procs = [];
    quad.kind = null;
    quad.filePath = null;
    quad.label = null;
  }

  _startChannel(q, login) {
    const quad = this.quads[q];
    const gen = quad.gen;
    quad.kind = 'channel';

    const sl = spawn(STREAMLINK, [
      '--twitch-disable-ads', '--twitch-low-latency',
      '--stdout', `twitch.tv/${login}`, TWITCH_QUALITY
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0', '-c', 'copy',
      '-f', 'mpegts', quadPublishUrl(q)
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    sl.stdout.pipe(ff.stdin);
    quad.procs = [sl, ff];

    // Stall watchdog: no bytes from streamlink for STALL_TIMEOUT_MS → restart
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
    sl.stdout.on('data', bumpStall);

    const onExit = (which) => (code) => {
      if (quad.gen !== gen || this.stopped) return;
      this.log(`quad${q + 1}: ${which} for ${login} exited (${code}) — slate + retry in ${RETRY_DELAY_MS / 1000}s`);
      this._failover(q, login);
    };
    sl.on('exit', onExit('streamlink'));
    ff.on('exit', onExit('ffmpeg'));
    ff.stderr.on('data', () => {});
    sl.stderr.on('data', () => {});
  }

  /** Publish slate now, retry the channel after a delay. */
  _failover(q, login) {
    this._kill(q);
    const quad = this.quads[q];
    this._startSlate(q);
    quad.login = login; // still assigned — we are just waiting to retry
    quad.retryTimer = setTimeout(() => {
      if (this.stopped || quad.login !== login) return;
      this._kill(q);
      this._startChannel(q, login);
    }, RETRY_DELAY_MS);
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
    quad.login = null;

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

  /** Apply merged sources: null | login | { type:'file', path, label }. */
  applySources(sources) {
    for (let q = 0; q < 4; q++) {
      const s = sources[q];
      if (s && typeof s === 'object' && s.type === 'file') {
        this.setQuadrantFile(q, s.path, s.label);
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
    return this.quads.map((quad, q) => ({
      quadrant: q + 1,
      login: quad.login,
      label: quad.label,
      filePath: quad.filePath,
      kind: quad.kind,
      url: quadUrl(q),
      pids: quad.procs.map(p => p.pid),
    }));
  }

  stopAll() {
    this.stopped = true;
    for (let q = 0; q < 4; q++) this._kill(q);
  }
}

module.exports = { QuadrantFeeders, generateSlate, quadUrl, quadPublishUrl, nameFile, writeNameFile, GRID_DIR, SLATE_PATH, BRAND };
