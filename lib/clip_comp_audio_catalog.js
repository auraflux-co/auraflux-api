'use strict';
/**
 * lib/clip_comp_audio_catalog.js — list music beds from assets/audio (CPD-1093)
 */

const fs = require('fs');
const path = require('path');
const { BED_FILES, AUDIO_DIR } = require('./clip_comp_audio_mix');

const BED_LABELS = {
  low_trap: 'Low trap (Cushy)',
  neutral_lofi: 'Neutral lofi (Dylan Sitts)',
};

function bedLabelForFile(id, file) {
  if (BED_LABELS[id]) return BED_LABELS[id];
  return file.replace(/^ES_/i, '').replace(/\.(mp3|m4a|wav)$/i, '').trim() || file;
}

/** List selectable music beds — built-in keys + any ES_* audio files in assets/audio. */
function listMusicBedOptions({ includeOff = true } = {}) {
  const options = [];
  if (includeOff) options.push({ id: 'off', label: 'No music bed', file: null });

  const seenFiles = new Set();
  for (const [id, file] of Object.entries(BED_FILES)) {
    const full = path.join(AUDIO_DIR, file);
    if (!fs.existsSync(full)) continue;
    seenFiles.add(file);
    options.push({ id, label: bedLabelForFile(id, file), file });
  }

  let dir = AUDIO_DIR;
  if (!fs.existsSync(dir)) return options;

  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(mp3|m4a|wav)$/i.test(name)) continue;
    if (seenFiles.has(name)) continue;
    const id = `file:${name}`;
    options.push({ id, label: bedLabelForFile(id, name), file: name });
  }

  return options;
}

module.exports = {
  BED_LABELS,
  listMusicBedOptions,
};
