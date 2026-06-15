#!/usr/bin/env node
'use strict';
/**
 * Clone + avatar acceptance gate — spike profile (CPD-881 validated path).
 *
 * Usage: bash scripts/doppler_run.sh node scripts/avatar_clone_gate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TEXT = process.argv[2] || 'The stream was indeed his stream now.';
const OUT = path.join(__dirname, '..', 'output', 'avatar_clone_gate');

function log(msg) {
  console.log(`[gate] ${msg}`);
}

async function clonedTtsMp3() {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set');
  const dest = path.join(OUT, 'cloned_tts.mp3');
  const resp = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    { text: TEXT, model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' },
    {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      timeout: 120000
    }
  );
  fs.writeFileSync(dest, Buffer.from(resp.data));
  log(`cloned TTS → ${dest}`);
  return dest;
}

async function heygenBaseline() {
  const avatar = require('../lib/avatar');
  const dest = path.join(OUT, 'heygen_baseline.mp4');
  if (fs.existsSync(dest)) {
    log(`reuse heygen baseline → ${dest}`);
    return dest;
  }
  const { videoId } = await avatar.submitSegment(
    { text: TEXT, title: 'GATE_HEYGEN', aspectRatio: '16:9' },
    { engine: 'heygen' }
  );
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'heygen', maxWaitMs: 25 * 60 * 1000, pollIntervalMs: 12000, label: 'heygen_baseline'
  });
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
  log(`heygen baseline → ${dest}`);
  return dest;
}

async function echoMimicSpikeProfile() {
  process.env.ECHOMIMIC_PROFILE = 'spike';
  process.env.ECHOMIMIC_AUDIO_SOURCE = 'elevenlabs';
  process.env.ECHOMIMIC_HEYGEN_AUDIO_FALLBACK = '0';
  process.env.ECHOMIMIC_CHUNK = 'off';
  process.env.ECHOMIMIC_ENHANCED_DELIVERY = '0';
  process.env.ECHOMIMIC_ASSEMBLY_CROP = 'off';
  delete process.env.ECHOMIMIC_PORTRAIT;
  delete process.env.ECHOMIMIC_IMAGE_KEY;
  delete process.env.ECHOMIMIC_CHUNK_XFADE;
  delete process.env.ECHOMIMIC_USE_DYNAMIC_CFG;

  const avatar = require('../lib/avatar');
  const { wakePod } = require('../lib/avatar/echomimic_pod');
  const { resolveSpikePortraitKey } = require('../lib/avatar/echomimic_spike');
  await wakePod();

  const dest = path.join(OUT, 'em_clone_production.mp4');
  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'echomimic' });
  const t0 = Date.now();
  const { videoId } = await avatar.submitSegment(
    { text: TEXT, title: 'GATE_EM_CLONE', aspectRatio: '16:9', config },
    { engine: 'echomimic' }
  );
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'echomimic', maxWaitMs: 25 * 60 * 1000, pollIntervalMs: 12000, label: 'em_clone_production'
  });
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 180000 });
  fs.writeFileSync(dest, Buffer.from(resp.data));
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`EchoMimic spike profile (${sec}s) → ${dest}`);
  return { dest, renderSec: parseFloat(sec), portrait: resolveSpikePortraitKey() };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  log(`gate text: "${TEXT}"`);
  log(`profile: spike (CPD-881)`);

  const manifest = {
    text: TEXT,
    profile: 'spike',
    voiceId: process.env.ELEVENLABS_VOICE_ID,
    startedAt: new Date().toISOString(),
    outputs: {}
  };

  manifest.outputs.clonedTts = await clonedTtsMp3();
  if (!fs.existsSync(path.join(OUT, 'heygen_baseline.mp4'))) {
    manifest.outputs.heygenBaseline = await heygenBaseline();
  } else {
    manifest.outputs.heygenBaseline = path.join(OUT, 'heygen_baseline.mp4');
    log('reuse heygen baseline');
  }
  const em = await echoMimicSpikeProfile();
  manifest.outputs.emCloneProduction = em.dest;
  manifest.portrait = em.portrait;
  manifest.renderSec = em.renderSec;
  manifest.completedAt = new Date().toISOString();
  manifest.qa = {
    audio: 'cloned_tts.mp3 vs heygen_baseline.mp4',
    avatar: 'em_clone_production.mp4 vs heygen_baseline.mp4',
    gate2: 'Run: node scripts/avatar_gate2_validation.js for A/B/C spike lines + Gemini scores'
  };

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log('✅ gate artifacts ready — output/avatar_clone_gate/');
}

main().catch((e) => {
  console.error(`[gate] ❌ ${e.message}`);
  process.exitCode = 1;
});
