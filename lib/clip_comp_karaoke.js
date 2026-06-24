'use strict';
/**
 * lib/clip_comp_karaoke.js — word-by-word ASS captions from Whisper (CPD-1092)
 */

const fs = require('fs');
const path = require('path');

function _formatAssTime(sec) {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.floor((clamped % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function _escapeAss(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, ' ');
}

/**
 * Build ASS with \\k karaoke tags from Whisper verbose_json segments.
 */
function buildKaraokeAssFromVerboseJson(payload, { fullBleed = false } = {}) {
  const segments = payload?.segments || [];
  const marginV = fullBleed ? 96 : 120;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,Arial Bold,64,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,56,56,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const seg of segments) {
    const words = seg.words || [];
    if (!words.length) {
      const text = _escapeAss(seg.text || '');
      if (!text) continue;
      lines.push(`Dialogue: 0,${_formatAssTime(seg.start || 0)},${_formatAssTime(seg.end || seg.start || 0)},Karaoke,,0,0,0,,${text}`);
      continue;
    }

    let cursor = seg.start || words[0]?.start || 0;
    const end = seg.end || words[words.length - 1]?.end || cursor + 1;
    const parts = [];
    for (const w of words) {
      const word = _escapeAss(w.word || w.text || '');
      if (!word) continue;
      const durCs = Math.max(1, Math.round(((w.end || cursor) - (w.start || cursor)) * 100));
      parts.push(`{\\k${durCs}}${word} `);
      cursor = w.end || cursor;
    }
    lines.push(`Dialogue: 0,${_formatAssTime(seg.start || 0)},${_formatAssTime(end)},Karaoke,,0,0,0,,${parts.join('').trim()}`);
  }

  return `${lines.join('\n')}\n`;
}

async function transcribeVerboseJson(inputPath, promptBias = '') {
  const { _whisperTranscribeForTests } = require('./assembly_postprocess');
  if (typeof _whisperTranscribeForTests === 'function') {
    return _whisperTranscribeForTests(inputPath, 'verbose_json', promptBias);
  }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const axios = require('axios');
  const FormData = require('form-data');
  const { execFile } = require('child_process');
  const { ffmpegPath } = require('./ffmpeg_utils');
  const audioPath = inputPath.replace(/\.mp4$/, `_karaoke_audio_${Date.now()}.mp3`);

  try {
    await new Promise((res, rej) => {
      execFile(ffmpegPath(), [
        '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', audioPath,
      ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
    });
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    if (promptBias) form.append('prompt', promptBias);
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` },
      timeout: 180_000,
      maxBodyLength: Infinity,
    });
    return resp.data;
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

module.exports = {
  buildKaraokeAssFromVerboseJson,
  transcribeVerboseJson,
};
