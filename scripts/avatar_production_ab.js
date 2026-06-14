#!/usr/bin/env node
'use strict';
/**
 * Production A/B — spike8 heygen_frame vs tight_head on a real multi-chunk line.
 * C0 only · outputs compare.md + CDN uploads under qa/gate/
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/avatar_production_ab.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { uploadToR2 } = require('../lib/storage');
const { PORTRAIT_KEYS } = require('../lib/avatar/echomimic_post');

const OUT = path.join(__dirname, '..', 'output', 'avatar_production_ab');
const LONG_TEXT = process.argv.includes('--text')
  ? process.argv[process.argv.indexOf('--text') + 1]
  : 'The stream was indeed his stream now — but tonight the chat was not buying the hype. '
    + 'He leaned into the mic, called the play before the replay even loaded, and dared anyone '
    + 'in the room to tell him the momentum had shifted. That is the job. That is the show.';

const VARIANTS = [
  { label: 'prod_heygen_frame', portrait: 'heygen_frame' },
  { label: 'prod_tight_head', portrait: 'tight_head' }
];

function log(msg) {
  console.log(`[ab] ${msg}`);
}

async function renderVariant({ label, portrait }) {
  process.env.ECHOMIMIC_AUDIO_SOURCE = 'elevenlabs';
  process.env.ECHOMIMIC_HEYGEN_AUDIO_FALLBACK = '0';
  process.env.ECHOMIMIC_STEPS = '8';
  process.env.ECHOMIMIC_AUDIO_GUIDANCE_SCALE = '2.0';
  process.env.ECHOMIMIC_GUIDANCE_SCALE = '4.5';
  process.env.ECHOMIMIC_USE_DYNAMIC_CFG = '0';
  process.env.ECHOMIMIC_CHUNK = 'on';
  process.env.ECHOMIMIC_CHUNK_XFADE = 'on';
  process.env.ECHOMIMIC_CHUNK_XFADE_SEC = process.env.ECHOMIMIC_CHUNK_XFADE_SEC || '0.12';
  process.env.ECHOMIMIC_IMAGE_KEY = PORTRAIT_KEYS[portrait];
  delete process.env.ECHOMIMIC_PORTRAIT;

  const avatar = require('../lib/avatar');
  const { wakePod } = require('../lib/avatar/echomimic_pod');
  await wakePod();

  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'echomimic' });
  const t0 = Date.now();
  const { videoId } = await avatar.submitSegment({
    text: LONG_TEXT,
    title: `AB_${label}`,
    aspectRatio: '16:9',
    config,
    enhancedDelivery: true
  }, { engine: 'echomimic' });
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'echomimic',
    maxWaitMs: 45 * 60 * 1000,
    pollIntervalMs: 12000,
    label
  });
  const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 300000 });
  const dest = path.join(OUT, `${label}.mp4`);
  fs.writeFileSync(dest, Buffer.from(resp.data));
  const renderSec = ((Date.now() - t0) / 1000).toFixed(1);
  const r2Key = `qa/gate/${label}.mp4`;
  await uploadToR2(dest, `${label}.mp4`, {
    key: r2Key,
    contentType: 'video/mp4',
    cacheControl: 'public, max-age=31536000, immutable'
  });
  const publicUrl = process.env.R2_ASSETS_DOMAIN
    ? `https://${process.env.R2_ASSETS_DOMAIN}/${r2Key}`
    : videoUrl;
  log(`✅ ${label} (${renderSec}s) → ${publicUrl}`);
  return { label, dest, publicUrl, renderSec: parseFloat(renderSec), portrait };
}

function writeCompare(rows) {
  const lines = [
    '# Avatar production A/B — long line',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Text (${LONG_TEXT.length} chars): "${LONG_TEXT.slice(0, 120)}…"`,
    'Profile: spike8 · ags 2.0 · dynamic off · chunk xfade on · enhanced delivery on',
    '',
    '## HeyGen baseline',
    '- [heygen_baseline.mp4](https://assets.auraflux.co/qa/gate/heygen_baseline.mp4)',
    '',
    '## EchoMimic variants'
  ];
  for (const r of rows) {
    lines.push(`- \`${r.label}\` portrait \`${r.portrait}\` (${r.renderSec}s) — [mp4](${r.publicUrl})`);
  }
  fs.writeFileSync(path.join(OUT, 'compare.md'), lines.join('\n'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  for (const v of VARIANTS) {
    try {
      results.push(await renderVariant(v));
      writeCompare(results);
    } catch (e) {
      log(`❌ ${v.label}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  writeCompare(results);
  log(`done — ${OUT}/compare.md`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
