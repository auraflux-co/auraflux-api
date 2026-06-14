#!/usr/bin/env node
'use strict';
/** Regenerate output/avatar_qa_links.json + output/avatar_qa_compare.md */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { uploadToR2 } = require('../lib/storage');

const ROOT = path.join(__dirname, '..');

function publicR2Url(key) {
  const domain = process.env.R2_ASSETS_DOMAIN;
  if (!domain) throw new Error('R2_ASSETS_DOMAIN not set — cannot build browser-playable links');
  return `https://${domain}/${key}`;
}

function syncGateFromImprovement(gateDir, file) {
  let local = path.join(gateDir, file);
  if (file !== 'em_clone_production.mp4') return local;
  const imp = path.join(ROOT, 'output/avatar_improvement/spike8_heygen.mp4');
  if (fs.existsSync(imp) && (
    !fs.existsSync(local)
    || fs.statSync(imp).mtimeMs > fs.statSync(local).mtimeMs
    || fs.statSync(imp).size !== fs.statSync(local).size
  )) {
    fs.copyFileSync(imp, local);
  }
  return local;
}

async function main() {
  const out = {};
  const gateDir = path.join(ROOT, 'output/avatar_clone_gate');

  for (const [name, file] of [
    ['heygen_baseline', 'heygen_baseline.mp4'],
    ['cloned_tts', 'cloned_tts.mp3']
  ]) {
    const local = path.join(gateDir, file);
    if (!fs.existsSync(local)) continue;
    const key = `qa/gate/${file}`;
    await uploadToR2(local, file, {
      key,
      contentType: file.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
      cacheControl: 'public, max-age=3600'
    });
    out[name] = publicR2Url(key);
  }

  // Versioned keys — assets.auraflux.co caches by path; never overwrite a QA mp4 in place.
  const spikeLocal = syncGateFromImprovement(gateDir, 'em_clone_production.mp4');
  const sweepLocal = path.join(ROOT, 'output/avatar_improvement/sweep_heygen.mp4');
  if (fs.existsSync(spikeLocal)) {
    const key = 'qa/gate/em_clone_spike8.mp4';
    await uploadToR2(spikeLocal, 'em_clone_spike8.mp4', {
      key, contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable'
    });
    out.em_clone = publicR2Url(key);
    out.em_clone_spike8 = out.em_clone;
  }
  if (fs.existsSync(sweepLocal)) {
    const key = 'qa/gate/em_clone_sweep25.mp4';
    await uploadToR2(sweepLocal, 'em_clone_sweep25.mp4', {
      key, contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable'
    });
    out.em_clone_sweep25 = publicR2Url(key);
  }

  const sweepPath = path.join(ROOT, 'output/avatar_mouth_sweep/results.json');
  out.sweep = [];
  if (fs.existsSync(sweepPath)) {
    const sweep = JSON.parse(fs.readFileSync(sweepPath, 'utf8'));
    for (const v of sweep.variants) {
      const m = v.videoUrl?.match(/auraflux-video-output\/([^?]+)/);
      const key = m ? decodeURIComponent(m[1]) : (v.r2Key || null);
      if (key) {
        out.sweep.push({
          label: v.label,
          url: publicR2Url(key),
          steps: v.steps,
          ags: v.audioGuidance
        });
      }
    }
  }
  const improvePath = path.join(ROOT, 'output/avatar_improvement/results.json');
  out.improvement = [];
  if (fs.existsSync(improvePath)) {
    const imp = JSON.parse(fs.readFileSync(improvePath, 'utf8'));
    for (const v of imp.variants || []) {
      out.improvement.push({
        label: v.label,
        url: v.publicUrl || (v.r2Key && publicR2Url(v.r2Key)),
        steps: v.steps,
        ags: v.ags,
        portrait: v.portrait,
        dynamic: v.dynamic
      });
    }
  }

  fs.writeFileSync(path.join(ROOT, 'output/avatar_qa_links.json'), JSON.stringify(out, null, 2));

  const lines = [
    '# Avatar QA — compare links',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '> Use **em_clone_spike8** / **em_clone_sweep25** — `em_clone_production.mp4` is CDN-stale (cached old render).',
    ''
  ];
  lines.push('## Audio');
  lines.push(`- [Clone TTS mp3](${out.cloned_tts})`, '');
  lines.push('## Avatar gate (current QA winners)');
  lines.push(`- [HeyGen baseline](${out.heygen_baseline})`);
  lines.push(`- [EchoMimic spike8 — production pick](${out.em_clone_spike8})`);
  if (out.em_clone_sweep25) {
    lines.push(`- [EchoMimic sweep25 — alt](${out.em_clone_sweep25})`);
  }
  lines.push('');
  lines.push('## Mouth sweep (top picks)');
  for (const v of (out.sweep || []).filter((x) => x.ags <= 2.5 && x.steps >= 25)) {
    lines.push(`- \`${v.label}\` — [mp4](${v.url})`);
  }
  if (out.improvement?.length) {
    lines.push('', '## Improvement run (same files as gate winners)');
    for (const v of out.improvement) {
      lines.push(`- \`${v.label}\` — [mp4](${v.url})`);
    }
  }
  fs.writeFileSync(path.join(ROOT, 'output/avatar_qa_compare.md'), lines.join('\n'));
  console.log('Wrote output/avatar_qa_links.json + output/avatar_qa_compare.md');
  console.log('Production QA:', out.em_clone_spike8);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
