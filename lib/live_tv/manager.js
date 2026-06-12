/**
 * ClipzWorld TV — 24/7 Twitch loop channel (CPD-957)
 *
 * Streams the produced CWN videos as a continuous live loop to Twitch.
 *
 * Architecture (v2 — single persistent connection): per-item RTMP pushes
 * FAILED in production — Twitch (unlike YouTube) ends the stream session on
 * every disconnect, and a playlist of shorts disconnected every ~minute
 * ("stream ended" for viewers). Now each video is normalized ONCE into a
 * cached uniform mpegts (1080p30 h264_videotoolbox on brand navy + AAC
 * 44.1k), and a single playout ffmpeg streams the whole rotation -c copy
 * over ONE unbroken RTMP connection. The playout exits at the end of the
 * list and the supervisor respawns it (~2s blip per multi-hour loop) —
 * which is also when newly cached videos join the rotation.
 *
 * Live Grid recordings are NEVER playlisted here — rebroadcasting other
 * Twitch channels on Twitch violates their ToS.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRAND_NAVY = '0x0d1424';
const RESPAWN_DELAY_MS = 2_000;     // between playout passes / after a crash
const TWITCH_RTMP = 'rtmp://live.twitch.tv/app';

/** Pure: filter + order a candidate file list into a playlist. */
function buildPlaylist(files, { shuffle = false } = {}) {
  const list = [...new Set((files || []).filter(f => /\.mp4$/i.test(f)))];
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  return list;
}

/** Pure: default-scan eligibility — finished videos only, no build artifacts. */
function isPlayable(name, sizeBytes) {
  if (!/\.mp4$/i.test(name)) return false;
  if (/^synth_prebuild/i.test(name)) return false;   // pipeline intermediates
  if (/_0clips_/i.test(name)) return false;          // empty/debug assemblies
  if (/live_?grid/i.test(name)) return false;        // ToS: never restream the grid
  // Takedown shield: only Bobby G (avatar commentary) content streams on
  // Twitch — clips-only comps have no transformative layer
  if (/^clips_comp_/i.test(name)) return false;
  if (sizeBytes < 1_000_000) return false;           // <1MB = test/broken artifact
  return true;
}

/** Scan the output dir for playable finished videos (newest first). */
function defaultPlaylist(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  return entries
    .map(name => {
      try { return { name, stat: fs.statSync(path.join(dir, name)) }; }
      catch (_) { return null; }
    })
    .filter(e => e && isPlayable(e.name, e.stat.size))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .map(e => path.join(dir, e.name));
}

/** Transcode args: source video → uniform cached mpegts. */
function buildCacheArgs(file, cachePath) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vf',
    'scale=1920:1080:force_original_aspect_ratio=decrease,' +
    `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${BRAND_NAVY},` +
    'fps=30,format=yuv420p',
    '-c:v', 'h264_videotoolbox', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
    '-g', '60',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-f', 'mpegts', '-y', cachePath,
  ];
}

/** Playout args: stream the concat list -c copy over one RTMP connection. */
function buildPlayoutArgs(listPath, output) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re', '-fflags', '+genpts',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-f', 'flv', output,
  ];
}

/** ffconcat list contents for the cached files (single-quote escaped). */
function buildConcatList(cachedFiles) {
  const esc = (p) => p.replace(/'/g, "'\\''");
  return ['ffconcat version 1.0', ...cachedFiles.map(f => `file '${esc(f)}'`), ''].join('\n');
}

class LiveTvManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-tv] ${m}`));
    this.ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    this.outputDir = opts.outputDir || path.join(__dirname, '..', '..', 'output');
    this.cacheDir = opts.cacheDir || path.join(__dirname, '..', '..', 'tmp', 'live_tv_cache');
    this.running = false;
    this.proc = null;          // playout ffmpeg
    this.cacheProc = null;     // current transcode
    this.caffeinate = null;
    this.playlist = [];        // source files (rotation order)
    this.cached = [];          // cached .ts files ready for playout
    this.shuffle = false;
    this.loop = 0;
    this.startedAt = null;
    this.playoutStartedAt = null;
    this.caching = null;       // basename of the video being cached
    this.output = null;
    this._respawnTimer = null;
    this._listPath = null;
  }

  _cachePath(file) {
    return path.join(this.cacheDir, path.basename(file).replace(/\.mp4$/i, '.ts'));
  }

  /**
   * @param {Object} o { videos?: string[], shuffle?: boolean, output?: string }
   *   `videos` — explicit playlist (absolute paths); default = output/ scan.
   *   `output` — override destination (file path for rehearsal); default Twitch RTMP.
   */
  start(o = {}) {
    if (this.running) throw new Error('ClipzWorld TV already running');
    if (!o.output && !process.env.TWITCH_STREAM_KEY) {
      throw new Error('TWITCH_STREAM_KEY not set — add it to .env (Twitch dashboard → Stream Key)');
    }
    this.shuffle = !!o.shuffle;
    this.playlist = o.videos?.length
      ? buildPlaylist(o.videos, { shuffle: this.shuffle })
      : buildPlaylist(defaultPlaylist(this.outputDir), { shuffle: this.shuffle });
    if (!this.playlist.length) throw new Error('Playlist is empty — no playable videos found');

    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.output = o.output || `${TWITCH_RTMP}/${process.env.TWITCH_STREAM_KEY}`;
    this.running = true;
    this.loop = 0;
    this.startedAt = Date.now();
    this.cached = this.playlist.filter(f => fs.existsSync(this._cachePath(f))).map(f => this._cachePath(f));
    this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    this.log(`ClipzWorld TV started — ${this.playlist.length} videos (${this.cached.length} already cached)`);

    this._cacheNext();                      // normalize remaining videos in the background
    if (this.cached.length) this._playout(); // start streaming what's ready immediately
    return this.status();
  }

  /** Transcode source videos to uniform cached TS, one at a time. */
  _cacheNext() {
    if (!this.running) return;
    const next = this.playlist.find(f => !fs.existsSync(this._cachePath(f)));
    if (!next) {
      this.caching = null;
      this.log(`cache complete — ${this.cached.length} videos in rotation`);
      if (!this.proc) this._playout();
      return;
    }
    this.caching = path.basename(next);
    const dest = this._cachePath(next);
    const tmp = dest + '.part';
    this.log(`caching: ${this.caching}`);
    const p = spawn(this.ffmpegPath, buildCacheArgs(next, tmp), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.cacheProc = p;
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-300); });
    p.on('close', (code) => {
      this.cacheProc = null;
      if (!this.running) { try { fs.unlinkSync(tmp); } catch (_) {} return; }
      if (code === 0) {
        fs.renameSync(tmp, dest);
        this.cached.push(dest);
        this.log(`cached (${this.cached.length}/${this.playlist.length}): ${this.caching}`);
        if (!this.proc) this._playout(); // first item ready → go live
      } else {
        try { fs.unlinkSync(tmp); } catch (_) {}
        this.log(`cache failed (code ${code}) — dropping ${this.caching}: ${errTail.split('\n').pop()}`);
        this.playlist = this.playlist.filter(f => f !== next);
      }
      this._cacheNext();
    });
  }

  /** One playout pass: stream every cached video over a single RTMP connection. */
  _playout() {
    if (!this.running || this.proc) return;
    if (!this.cached.length) return;
    // Rebuild the list each pass — newly cached videos join here
    const files = this.shuffle ? buildPlaylist(this.cached, { shuffle: true }).map(String) : [...this.cached];
    this._listPath = path.join(this.cacheDir, 'playlist.ffconcat');
    fs.writeFileSync(this._listPath, buildConcatList(files));
    this.playoutStartedAt = Date.now();
    this.log(`playout pass ${this.loop + 1} — ${files.length} videos, one connection`);

    const p = spawn(this.ffmpegPath, buildPlayoutArgs(this._listPath, this.output), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.running) return;
      const ranMs = Date.now() - this.playoutStartedAt;
      if (code === 0 || ranMs > 60_000) {
        this.loop++;
        if (code !== 0) this.log(`playout dropped (code ${code}) after ${Math.round(ranMs / 1000)}s — reconnecting: ${errTail.split('\n').pop()}`);
      } else {
        this.log(`playout failed fast (code ${code}): ${errTail.split('\n').slice(-2).join(' | ')}`);
      }
      this._respawnTimer = setTimeout(() => this._playout(), RESPAWN_DELAY_MS);
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._respawnTimer);
    for (const p of [this.proc, this.cacheProc, this.caffeinate]) {
      if (p) { try { p.kill('SIGTERM'); } catch (_) {} }
    }
    this.proc = this.cacheProc = this.caffeinate = null;
    this.log('ClipzWorld TV stopped');
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeSec: this.running ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      streaming: !!this.proc,
      loop: this.loop,
      shuffle: this.shuffle,
      cached: this.cached.length,
      total: this.playlist.length,
      caching: this.caching,
      playlist: this.playlist.map(f => path.basename(f)),
      output: this.output ? this.output.replace(/\/[^/]+$/, '/•••') : null, // never leak the stream key
    };
  }
}

module.exports = { LiveTvManager, buildPlaylist, defaultPlaylist, isPlayable, buildConcatList };
