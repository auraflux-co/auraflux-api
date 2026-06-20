/**
 * Live Grid — music guard (CPD-979)
 *
 * Content ID claims on grid streams come from music playing in whichever
 * quadrant holds the on-air audio. This module samples each LIVE quadrant's
 * audio from its MediaMTX path on an interval, asks Gemini "is music clearly
 * audible?", and debounces the answer into per-quadrant music flags.
 *
 * Manual audio pins are respected for viewer-challenge swaps — when music is flagged
 * on the pinned quadrant, audio hops to another live quadrant without music (no
 * royalty bed unless LIVE_GRID_MUSIC_USE_BED=on and every quadrant is flagged).
 *
 * Detection is presence-based, not song identification — the action (mute or
 * move) is identical regardless of which song it is, so no ACRCloud/AudD
 * dependency. Fail-open: sampling or Gemini errors count as "no music" so a
 * network blip never mutes a clean stream.
 *
 * Disable with LIVE_GRID_MUSIC_GUARD=off.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { quadUrl } = require('./feeders');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SAMPLE_SEC = 4;
const INTERVAL_MS = parseInt(process.env.LIVE_GRID_MUSIC_INTERVAL_MS || '15000', 10);
const CONFIRM_WINDOWS = parseInt(process.env.LIVE_GRID_MUSIC_CONFIRM_WINDOWS || '1', 10);  // ~15s at default interval
const CLEAR_WINDOWS = parseInt(process.env.LIVE_GRID_MUSIC_CLEAR_WINDOWS || '2', 10);
const MUSIC_CONFIDENCE_MIN = Number(process.env.LIVE_GRID_MUSIC_CONFIDENCE_MIN) || 0.72;

/**
 * Debounce one classification result into a quadrant's flag state.
 * state: { musicRuns, clearRuns, flagged } — mutated in place.
 * Returns the (possibly updated) flagged boolean.
 */
function updateMusicState(state, isMusic, { confirm = CONFIRM_WINDOWS, clear = CLEAR_WINDOWS } = {}) {
  if (isMusic) {
    state.musicRuns = (state.musicRuns || 0) + 1;
    state.clearRuns = 0;
    if (state.musicRuns >= confirm) state.flagged = true;
  } else {
    state.clearRuns = (state.clearRuns || 0) + 1;
    state.musicRuns = 0;
    if (state.clearRuns >= clear) state.flagged = false;
  }
  return !!state.flagged;
}

/**
 * Choose where audio should sit given music flags.
 * @param {Array<string|null>} assignments - login per quadrant (null = slate)
 * @param {Object} viewers - login → viewer count
 * @param {boolean[]} musicFlags - per-quadrant music flag
 * @param {Object} [opts]
 * @param {boolean[]} [opts.unhealthyQuads] - skip quads with relay churn / feed failures
 * @returns {{ quad: number, mute: boolean }} quad=-1 with mute when no clean
 *   live quadrant exists (all-music or all-slate grids mute the mix).
 */
function pickAudioQuad(assignments, viewers = {}, musicFlags = [], opts = {}) {
  const unhealthy = opts.unhealthyQuads || [];
  let best = -1, bestViewers = -1;
  assignments.forEach((login, q) => {
    if (!login || musicFlags[q] || unhealthy[q]) return;
    const v = viewers[login] || 0;
    if (v > bestViewers) { best = q; bestViewers = v; }
  });
  if (best >= 0) return { quad: best, mute: false };
  return { quad: -1, mute: assignments.some(Boolean) }; // all-slate grid: nothing to mute
}

/** Capture sampleSec of a quadrant's audio as 16kHz mono mp3, return the buffer. */
function sampleQuadrantAudio(q, sampleSec = SAMPLE_SEC) {
  const tmp = path.join(os.tmpdir(), `lg_music_q${q}_${Date.now()}.mp3`);
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp', '-i', quadUrl(q),
      '-t', String(sampleSec), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
      '-y', tmp,
    ], { timeout: (sampleSec + 12) * 1000 }, (err) => {
      try {
        if (err) throw err;
        const buf = fs.readFileSync(tmp);
        if (!buf.length) throw new Error('empty capture');
        resolve(buf);
      } catch (e) {
        reject(e);
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    });
  });
}

/** Ask Gemini whether music is clearly audible. Returns { music, confidence }. */
async function classifyAudioGemini(audioBuf) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const prompt =
    'Listen to this short clip from a live stream. Is MUSIC clearly audible — a song, melody, beat, ' +
    'rap, or singing (foreground or background)? Talking, crowd noise, keyboard sounds, and one-off game ' +
    'sound effects are NOT music. Game background soundtracks DO count as music. ' +
    'Reply ONLY with JSON: {"music": true|false, "confidence": 0.0-1.0}';
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'audio/mp3', data: audioBuf.toString('base64') } },
        ],
      }],
      generationConfig: { temperature: 0 },
    },
    { timeout: 20_000 }
  );
  const text = ((resp.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).join('') || '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`unparseable: ${text.slice(0, 80)}`);
  const parsed = JSON.parse(m[0]);
  return { music: !!parsed.music, confidence: Number(parsed.confidence) || 0 };
}

class MusicDetector {
  /**
   * @param {Object} opts
   *   getAssignments — () => [login|null × 4] (current grid)
   *   onFlags        — (flags: boolean[]) called whenever any flag changes
   *   log            — fn(msg)
   *   intervalMs / classify / sample — overridable for tests
   */
  constructor(opts = {}) {
    this.getAssignments = opts.getAssignments || (() => [null, null, null, null]);
    this.onFlags = opts.onFlags || (() => {});
    this.log = opts.log || ((m) => console.log(`[live-grid:music] ${m}`));
    this.intervalMs = opts.intervalMs || INTERVAL_MS;
    this.classify = opts.classify || classifyAudioGemini;
    this.sample = opts.sample || sampleQuadrantAudio;
    this.states = [0, 1, 2, 3].map(() => ({ musicRuns: 0, clearRuns: 0, flagged: false, login: null }));
    this.timer = null;
    this._busy = false;
  }

  get flags() { return this.states.map(s => !!s.flagged); }

  start() {
    if (this.timer) return;
    if (String(process.env.LIVE_GRID_MUSIC_GUARD || 'on').toLowerCase() === 'off') {
      this.log('disabled via LIVE_GRID_MUSIC_GUARD=off');
      return;
    }
    this.timer = setInterval(() => this._tick().catch(e => this.log(`tick failed: ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
    this.log(`music guard on — sampling live quadrants every ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const assignments = this.getAssignments();
      const before = this.flags.join(',');
      await Promise.all(assignments.map(async (login, q) => {
        if (!login || login !== this.states[q].login) {
          // slate, or a different streamer moved in — old flag doesn't apply
          this.states[q] = { musicRuns: 0, clearRuns: 0, flagged: false, login: login || null };
          if (!login) return;
        }
        let isMusic = false;
        try {
          const buf = await this.sample(q);
          const res = await this.classify(buf);
          isMusic = res.music && res.confidence >= MUSIC_CONFIDENCE_MIN;
        } catch (e) {
          // fail-open: a sampling/API error never flags a quadrant
          this.log(`quad${q + 1} sample skipped: ${String(e.message).slice(0, 100)}`);
          return; // leave state untouched
        }
        const was = this.states[q].flagged;
        const now = updateMusicState(this.states[q], isMusic);
        if (was !== now) this.log(`quad${q + 1} (${login}): music ${now ? 'DETECTED 🎵' : 'cleared'}`);
      }));
      if (this.flags.join(',') !== before) this.onFlags(this.flags);
    } finally {
      this._busy = false;
    }
  }
}

module.exports = {
  MusicDetector, updateMusicState, pickAudioQuad,
  classifyAudioGemini, sampleQuadrantAudio,
  CONFIRM_WINDOWS, CLEAR_WINDOWS, MUSIC_CONFIDENCE_MIN,
};
