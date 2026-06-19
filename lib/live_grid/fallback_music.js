/**
 * Live Grid — Epidemic Sound fallback bed (CPD-1030)
 *
 * When music guard mutes the Twitch mix, play a royalty-free bed from
 * assets/audio/ (ES_* tracks synced from cwn-production) instead of silence.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '../../assets/audio');
const PRODUCTION_AUDIO_DIR = path.join(__dirname, '../../../cwn-production/assets/audio');
const BED_VOLUME = Number(process.env.LIVE_GRID_FALLBACK_MUSIC_VOLUME || '0.32');

function fallbackMusicEnabled() {
  return String(process.env.LIVE_GRID_FALLBACK_MUSIC || 'on').toLowerCase() !== 'off';
}

function resolveMusicDir() {
  const custom = process.env.LIVE_GRID_FALLBACK_MUSIC_DIR;
  if (custom && fs.existsSync(custom)) return custom;
  if (fs.existsSync(DEFAULT_DIR) && listFallbackTracks(DEFAULT_DIR).length) return DEFAULT_DIR;
  if (fs.existsSync(PRODUCTION_AUDIO_DIR) && listFallbackTracks(PRODUCTION_AUDIO_DIR).length) {
    return PRODUCTION_AUDIO_DIR;
  }
  return fs.existsSync(DEFAULT_DIR) ? DEFAULT_DIR : null;
}

/** List playable ES_* beds in the assets dir. */
function listFallbackTracks(dir = resolveMusicDir()) {
  if (!dir) return [];
  return fs.readdirSync(dir)
    .filter(f => /^ES_.+\.(mp3|m4a|wav)$/i.test(f))
    .map(f => path.join(dir, f))
    .filter(p => fs.statSync(p).isFile());
}

let _lastPick = null;

/** Pick a random Epidemic Sound bed; avoids immediate repeat when possible. */
function pickFallbackTrack(dir = resolveMusicDir()) {
  const tracks = listFallbackTracks(dir);
  if (!tracks.length) return null;
  if (tracks.length === 1) {
    _lastPick = tracks[0];
    return _lastPick;
  }
  let pick = tracks[Math.floor(Math.random() * tracks.length)];
  if (pick === _lastPick) {
    pick = tracks[(tracks.indexOf(pick) + 1) % tracks.length];
  }
  _lastPick = pick;
  return pick;
}

function resolveFallbackBedPath() {
  if (!fallbackMusicEnabled()) return null;
  const explicit = process.env.LIVE_GRID_FALLBACK_MUSIC_FILE;
  if (explicit && fs.existsSync(explicit)) return explicit;
  return pickFallbackTrack();
}

module.exports = {
  fallbackMusicEnabled,
  resolveMusicDir,
  listFallbackTracks,
  pickFallbackTrack,
  resolveFallbackBedPath,
  BED_VOLUME,
  DEFAULT_DIR,
};
