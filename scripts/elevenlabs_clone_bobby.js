#!/usr/bin/env node
'use strict';
/**
 * Instant Voice Clone (IVC) — Bobby G from HeyGen samples.
 * API: POST https://api.elevenlabs.io/v1/voices/add (Creator plan includes IVC)
 *
 * Requires an API key with create_instant_voice_clone (profile/unrestricted key).
 * TTS-only keys fail with missing_permissions — set ELEVENLABS_CLONE_API_KEY in
 * Doppler for a one-time clone, or ask ElevenLabs support to enable the permission
 * on the production key.
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/elevenlabs_clone_bobby.js
 *   bash scripts/doppler_run.sh node scripts/elevenlabs_clone_bobby.js --set-doppler
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: false });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');

const OUT = path.join(__dirname, '..', 'tmp', 'bobbyg_clone_samples');
const SAMPLES = [
  path.join(__dirname, '..', 'output', 'avatar_smoke_compare', 'heygen_fresh_reaction.mp4'),
  path.join(__dirname, '..', 'output', 'avatar_smoke_compare', 'heygen_archive_reaction.mp4')
];
const SET_DOPPLER = process.argv.includes('--set-doppler');
const MIN_SAMPLE_SEC = parseFloat(process.env.ELEVENLABS_IVC_MIN_SEC || '4.6');

function mediaDurationSec(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ], { encoding: 'utf8' }).trim();
  return parseFloat(out) || 0;
}

function mp4ToMp3(mp4, mp3) {
  execFileSync('ffmpeg', ['-y', '-i', mp4, '-ar', '44100', '-ac', '1', '-b:a', '128k', mp3], { stdio: 'ignore' });
}

function cloneApiKey() {
  return process.env.ELEVENLABS_CLONE_API_KEY || process.env.ELEVENLABS_API_KEY;
}

async function setDopplerVoiceId(voiceId) {
  const token = process.env.DOPPLER_TOKEN;
  if (!token) {
    console.log('[clone] DOPPLER_TOKEN missing — set manually: ELEVENLABS_VOICE_ID=' + voiceId);
    return;
  }
  const { execFileSync } = require('child_process');
  execFileSync('doppler', [
    'secrets', 'set',
    `ELEVENLABS_VOICE_ID=${voiceId}`,
    `ELEVENLABS_DEFAULT_VOICE_ID=${voiceId}`,
    '--project', 'auraflux', '--config', 'prd'
  ], { stdio: 'inherit', env: { ...process.env, DOPPLER_TOKEN: token } });
  console.log('[clone] Doppler updated (ELEVENLABS_VOICE_ID + DEFAULT)');
}

async function main() {
  const key = cloneApiKey();
  if (!key) throw new Error('ELEVENLABS_CLONE_API_KEY or ELEVENLABS_API_KEY missing — run via doppler_run.sh');

  fs.mkdirSync(OUT, { recursive: true });
  const mp3s = [];
  for (let i = 0; i < SAMPLES.length; i++) {
    const mp4 = SAMPLES[i];
    if (!fs.existsSync(mp4)) continue;
    const dur = mediaDurationSec(mp4);
    if (dur < MIN_SAMPLE_SEC) {
      console.log(`[clone] skip ${path.basename(mp4)} (${dur.toFixed(1)}s < ${MIN_SAMPLE_SEC}s)`);
      continue;
    }
    const mp3 = path.join(OUT, `sample_${i}.mp3`);
    mp4ToMp3(mp4, mp3);
    mp3s.push(mp3);
    console.log(`[clone] sample ${path.basename(mp4)} (${dur.toFixed(1)}s)`);
  }
  if (!mp3s.length) throw new Error(`no samples >= ${MIN_SAMPLE_SEC}s — need longer HeyGen audio`);

  const form = new FormData();
  form.append('name', 'Bobby G CWN Clone');
  form.append('description', 'IVC from HeyGen cw voice samples for EchoMimic TTS path');
  form.append('remove_background_noise', 'true');
  form.append('labels', JSON.stringify({ accent: 'american', gender: 'male', use_case: 'narration' }));
  for (const f of mp3s) form.append('files', fs.createReadStream(f), path.basename(f));

  console.log(`[clone] IVC POST /v1/voices/add — ${mp3s.length} sample(s)`);
  const resp = await axios.post('https://api.elevenlabs.io/v1/voices/add', form, {
    headers: { 'xi-api-key': key, ...form.getHeaders() },
    maxBodyLength: Infinity,
    timeout: 120000
  });

  const voiceId = resp.data?.voice_id;
  if (!voiceId) throw new Error(`clone failed: ${JSON.stringify(resp.data).slice(0, 300)}`);
  console.log(`[clone] ✅ voice_id=${voiceId} requires_verification=${resp.data?.requires_verification}`);
  if (SET_DOPPLER || process.env.ELEVENLABS_CLONE_AUTO_DOPPLER === '1') {
    await setDopplerVoiceId(voiceId);
  } else {
    console.log('[clone] Set in Doppler: ELEVENLABS_VOICE_ID=' + voiceId);
    console.log('[clone] Or re-run with --set-doppler to apply automatically');
  }
}

main().catch((e) => {
  const detail = e.response?.data?.detail;
  if (detail?.status === 'missing_permissions') {
    console.error('[clone] ❌ API key lacks create_instant_voice_clone.');
    console.error('[clone]    Production ELEVENLABS_API_KEY is TTS-scoped (cannot clone).');
    console.error('[clone]    Ask ElevenLabs support to enable clone on that key, OR add');
    console.error('[clone]    ELEVENLABS_CLONE_API_KEY in Doppler (profile/unrestricted key).');
  }
  console.error(`[clone] ❌ ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
  process.exitCode = 1;
});
