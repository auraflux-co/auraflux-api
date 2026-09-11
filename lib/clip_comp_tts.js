'use strict';
/**
 * lib/clip_comp_tts.js — ElevenLabs TTS for clip-comp editorial (Rob's voice).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { ffmpegPath, ffprobePath } = require('./ffmpeg_utils');

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

function resolveVoiceId() {
  return process.env.ELEVENLABS_VOICE_ID
    || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
}

/** Announcer / trailer voice for cold-open montage — separate from Bobby G avatar TTS. */
function resolveColdOpenVoiceId() {
  return process.env.ELEVENLABS_COLD_OPEN_VOICE_ID
    || process.env.ELEVENLABS_ANNOUNCER_VOICE_ID
    || resolveVoiceId();
}

function ttsEnabled() {
  return String(process.env.CLIP_COMP_TTS ?? 'on').toLowerCase() !== 'off';
}

function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath(), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { timeout: 30000 }, (err, stdout) => {
      const d = parseFloat(String(stdout || '').trim());
      resolve(err || isNaN(d) ? 0 : d);
    });
  });
}

/**
 * Synthesize speech to AAC mp4 audio-only-ish file (m4a).
 * @returns {Promise<{ audioPath: string, durationSec: number }|null>}
 */
async function synthesizeSpeech(text, outputPath, { log = null, voiceId = null } = {}) {
  if (!ttsEnabled()) return null;
  const clean = String(text || '').trim();
  if (!clean) return null;

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const resolvedVoice = voiceId || resolveVoiceId();
  if (!apiKey || !resolvedVoice) {
    if (log) log('  ⚠️  TTS skipped — ELEVENLABS_API_KEY or voice ID missing');
    return null;
  }

  const tmpMp3 = path.join(os.tmpdir(), `cc_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`);
  try {
    const speakSpeed = parseFloat(process.env.ELEVENLABS_SPEAK_SPEED || '1');
    const resp = await axios.post(
      `${ELEVENLABS_BASE}/v1/text-to-speech/${resolvedVoice}?output_format=mp3_44100_128`,
      {
        text: clean,
        model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
        ...(speakSpeed && speakSpeed !== 1 ? { voice_settings: { speed: speakSpeed } } : {}),
      },
      {
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 120000,
      },
    );
    fs.writeFileSync(tmpMp3, Buffer.from(resp.data));

    await new Promise((res, rej) => {
      execFile(ffmpegPath(), [
        '-i', tmpMp3,
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-y', outputPath,
      ], { timeout: 120000 }, (err) => (err ? rej(err) : res()));
    });

    const durationSec = await probeDurationSec(outputPath);
    if (log) log(`  🎙️  TTS (${durationSec.toFixed(1)}s): "${clean.slice(0, 55)}${clean.length > 55 ? '…' : ''}"`);
    return { audioPath: outputPath, durationSec };
  } catch (e) {
    if (log) log(`  ⚠️  ElevenLabs TTS failed: ${e.message.slice(0, 100)}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpMp3); } catch {}
  }
}

module.exports = {
  ttsEnabled,
  synthesizeSpeech,
  probeDurationSec,
  resolveVoiceId,
  resolveColdOpenVoiceId,
};
