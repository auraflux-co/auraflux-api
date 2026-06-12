/**
 * ClipzWorld TV — 24/7 Twitch loop channel (CPD-957)
 *
 * Streams the produced CWN videos as a continuous live loop to Twitch.
 * One ffmpeg process per playlist item pushes to the same RTMP endpoint;
 * Twitch keeps the stream session alive across the ~1-2s gap between
 * processes, so the channel stays live while items rotate forever.
 *
 * Every item is normalized live (mixed library: 16:9 long form + 9:16
 * shorts): scale/pad to 1920x1080@30 on brand navy, h264_videotoolbox,
 * AAC 44.1k stereo. Live Grid recordings are NEVER playlisted here —
 * rebroadcasting other Twitch channels on Twitch violates their ToS.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRAND_NAVY = '0x0d1424';
const ITEM_GAP_MS = 1_000;          // pause between items (Twitch session survives)
const FAST_FAIL_MS = 5_000;         // item died this fast → treat as bad file, skip
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

function buildItemArgs(file, output) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re', '-i', file,
    '-vf',
    'scale=1920:1080:force_original_aspect_ratio=decrease,' +
    `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${BRAND_NAVY},` +
    'fps=30,format=yuv420p',
    '-c:v', 'h264_videotoolbox', '-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k',
    '-g', '60',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', output,
  ];
}

class LiveTvManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-tv] ${m}`));
    this.ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
    this.outputDir = opts.outputDir || path.join(__dirname, '..', '..', 'output');
    this.running = false;
    this.proc = null;
    this.caffeinate = null;
    this.playlist = [];
    this.shuffle = false;
    this.index = 0;
    this.loop = 0;
    this.startedAt = null;
    this.itemStartedAt = null;
    this.output = null;
    this._nextTimer = null;
    this._failures = new Map(); // file → consecutive fast-fail count
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

    this.output = o.output || `${TWITCH_RTMP}/${process.env.TWITCH_STREAM_KEY}`;
    this.running = true;
    this.index = 0;
    this.loop = 0;
    this.startedAt = Date.now();
    this._failures.clear();
    this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    this.log(`ClipzWorld TV started — ${this.playlist.length} videos, shuffle=${this.shuffle}`);
    this._playCurrent();
    return this.status();
  }

  _playCurrent() {
    if (!this.running) return;
    const file = this.playlist[this.index];
    this.itemStartedAt = Date.now();
    this.log(`now playing [${this.index + 1}/${this.playlist.length} loop ${this.loop + 1}]: ${path.basename(file)}`);

    const proc = spawn(this.ffmpegPath, buildItemArgs(file, this.output), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    let errTail = '';
    proc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); });

    proc.on('close', (code) => {
      if (this.proc !== proc) return; // superseded (stop/restart)
      this.proc = null;
      if (!this.running) return;
      const ranMs = Date.now() - this.itemStartedAt;
      if (code !== 0 && ranMs < FAST_FAIL_MS) {
        const fails = (this._failures.get(file) || 0) + 1;
        this._failures.set(file, fails);
        this.log(`item failed fast (code ${code}) — ${path.basename(file)}: ${errTail.split('\n').slice(-2).join(' | ')}`);
        this.playlist = this.playlist.filter(f => f !== file);
        if (!this.playlist.length) {
          this.log('all playlist items failed — stopping');
          this.stop();
          return;
        }
        if (this.index >= this.playlist.length) this.index = 0;
      } else {
        this.index++;
        if (this.index >= this.playlist.length) {
          this.index = 0;
          this.loop++;
          if (this.shuffle) this.playlist = buildPlaylist(this.playlist, { shuffle: true });
        }
      }
      this._nextTimer = setTimeout(() => this._playCurrent(), ITEM_GAP_MS);
    });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._nextTimer);
    const proc = this.proc;
    this.proc = null;
    if (proc) { try { proc.kill('SIGTERM'); } catch (_) {} }
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) {} this.caffeinate = null; }
    this.log('ClipzWorld TV stopped');
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeSec: this.running ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      nowPlaying: this.running ? path.basename(this.playlist[this.index] || '') : null,
      position: this.running ? `${this.index + 1}/${this.playlist.length}` : null,
      loop: this.loop,
      shuffle: this.shuffle,
      playlist: this.playlist.map(f => path.basename(f)),
      output: this.output ? this.output.replace(/\/[^/]+$/, '/•••') : null, // never leak the stream key
    };
  }
}

module.exports = { LiveTvManager, buildPlaylist, defaultPlaylist, isPlayable };
