#!/usr/bin/env node
'use strict';

/**
 * Submit Lacy scene-reset test renders to HeyGen, stitch joins, score vs gold handoff.
 *
 *   node scripts/test_scene_reset_heygen_joins.js
 *   node scripts/test_scene_reset_heygen_joins.js --skip-submit   # stitch only (existing renders)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const {
  mergeTwoWithXfade,
  soupAvatarDialogueJoin,
} = require('../lib/assembly');
const avatar = require('../lib/avatar');
const { prepareHeyGenScript } = require('../lib/heygen_script');
const { applySceneResetHoldsToSceneText } = require('../lib/soup_scene_reset_holds');
const { injectStudioLaughPauseInReactionText } = require('../lib/studio_laughter');
const { downloadFile } = require('../lib/downloader');
const { scoreSceneResetJoin } = require('../lib/soup_join_visual_metrics');

const ROOT = path.join(__dirname, '..');
const JOB_ID = 'script_twitch_1782513992551';
const ASM_ID = 'asm_script_twitch_1782513992551_r43';
const TMP = path.join(ROOT, 'tmp');
const TAG = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(ROOT, 'output', `scene_reset_hold_test_${TAG}`);

const SUBMIT_SCENES = [
  'LACY_INTRO',
  'LACY_CLIP1_SETUP',
  'LACY_CLIP2_SETUP',
];

const JOIN_PAIRS = [
  { key: '009', from: 'LACY_INTRO', to: 'LACY_CLIP1_SETUP', label: 'INTRO→CLIP1_SETUP' },
  { key: '055', from: 'LACY_CLIP1_REACTION', to: 'LACY_CLIP2_SETUP', label: 'RXN→CLIP2_SETUP' },
  { key: '150', from: 'LACY_CLIP2_REACTION', to: 'JASON_INTRO', label: 'RXN→JASON_INTRO (gold)' },
];

function parseArgs() {
  const skipSubmit = process.argv.includes('--skip-submit');
  const maxWaitMin = Number(process.argv.find((a, i) => process.argv[i - 1] === '--max-wait-min') || 90);
  return { skipSubmit, maxWaitMs: maxWaitMin * 60 * 1000 };
}

function loadSceneTexts() {
  const jobs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
  const map = jobs[JOB_ID]?.heygen?.sceneTextMap || {};
  const out = {};
  for (const [name, entry] of Object.entries(map)) {
    out[name] = entry.text || '';
  }
  return out;
}

function sceneTextWithHolds(sceneName, rawText) {
  let text = String(rawText || '').trim();
  if (/_REACTION$/i.test(sceneName)) {
    text = injectStudioLaughPauseInReactionText(text);
  }
  return applySceneResetHoldsToSceneText(sceneName, text);
}

function resolveBaselineMp4(sceneName) {
  const slug = sceneName.toLowerCase().replace(/_/g, '_');
  const idxMap = {
    LACY_INTRO: 1,
    LACY_CLIP1_SETUP: 2,
    LACY_CLIP1_REACTION: 4,
    LACY_CLIP2_SETUP: 5,
    LACY_CLIP2_REACTION: 7,
    JASON_INTRO: 8,
  };
  const i = idxMap[sceneName];
  if (!i) return null;
  const prefix = `${ASM_ID}_${i}_`;
  const files = fs.readdirSync(TMP).filter((f) => f.startsWith(prefix) && f.endsWith('.mp4') && !/_muted/i.test(f));
  const preferCrowd = /_REACTION$/i.test(sceneName);
  const hit = preferCrowd
    ? files.find((f) => /_with_crowd/i.test(f)) || files[0]
    : files.find((f) => !/_with_crowd/i.test(f)) || files[0];
  return hit ? path.join(TMP, hit) : null;
}

async function submitScene(sceneName, text, config, maxWaitMs) {
  const heygenScript = prepareHeyGenScript(text, { sceneName, reactionPauseSec: config.reactionPauseSec ?? 4 });
  console.log(`\n[submit] ${sceneName}`);
  console.log(`  Gate-1+holds: ${JSON.stringify(text)}`);
  console.log(`  HeyGen script: ${JSON.stringify(heygenScript)}`);
  const { videoId, status } = await avatar.submitSegment({
    text,
    title: `hold_test_${TAG}_${sceneName}`,
    aspectRatio: '16:9',
    config,
    sceneName,
    enhancedDelivery: false,
  });
  console.log(`  videoId=${videoId} status=${status}`);
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    maxWaitMs,
    pollIntervalMs: 15000,
    label: sceneName,
  });
  const dest = path.join(OUT_DIR, 'segments', `${sceneName}.mp4`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await downloadFile(videoUrl, dest);
  console.log(`  saved ${dest}`);
  return dest;
}

async function stitchJoin(fromLabel, toLabel, leftPath, rightPath, outPath) {
  const policy = soupAvatarDialogueJoin(fromLabel, toLabel);
  await mergeTwoWithXfade(leftPath, rightPath, outPath, {
    ...policy,
    sceneLabel: fromLabel,
    logFn: (m) => console.log(`  ${m}`),
  });
}

async function main() {
  const { skipSubmit, maxWaitMs } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'segments'), { recursive: true });

  const baseTexts = loadSceneTexts();
  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' });
  config.reactionPauseSec = 4;

  const manifest = { tag: TAG, scenes: {}, joins: [] };

  for (const sceneName of SUBMIT_SCENES) {
    const text = sceneTextWithHolds(sceneName, baseTexts[sceneName]);
    manifest.scenes[sceneName] = {
      gate1WithHolds: text,
      heygenScript: prepareHeyGenScript(text, { sceneName, reactionPauseSec: 4 }),
    };
    if (skipSubmit) continue;
    manifest.scenes[sceneName].mp4 = await submitScene(sceneName, text, config, maxWaitMs);
  }

  // Resolve segment paths (new renders or baseline)
  function segPath(sceneName) {
    const newPath = path.join(OUT_DIR, 'segments', `${sceneName}.mp4`);
    if (fs.existsSync(newPath)) return newPath;
    if (SUBMIT_SCENES.includes(sceneName)) {
      throw new Error(`Missing new render for ${sceneName} — run without --skip-submit`);
    }
    const baseline = resolveBaselineMp4(sceneName);
    if (!baseline) throw new Error(`No baseline MP4 for ${sceneName}`);
    console.log(`[reuse] ${sceneName} ← ${baseline}`);
    return baseline;
  }

  for (const pair of JOIN_PAIRS) {
    const leftPath = segPath(pair.from);
    const rightPath = segPath(pair.to);
    const joinOut = path.join(OUT_DIR, `join_${pair.key}_${pair.from}_to_${pair.to}.mp4`);
    console.log(`\n[stitch] ${pair.label} → ${joinOut}`);
    await stitchJoin(pair.from, pair.to, leftPath, rightPath, joinOut);
    const score = await scoreSceneResetJoin(leftPath, rightPath, {
      holdSec: 0,
      slateSec: 0,
      tmpDir: path.join(OUT_DIR, 'metrics', pair.key),
      sceneLabel: pair.from,
      toLabel: pair.to,
    });
    manifest.joins.push({ ...pair, joinOut, score });
    const m = score.metrics || {};
    console.log(`[metrics] ${pair.key}: pass=${score.pass} tailMotion=${m.tailMotion} poseSsim=${m.poseJumpSsim} score=${score.score}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nDone → ${OUT_DIR}`);
  console.log(JSON.stringify(manifest.joins.map((j) => ({
    key: j.key,
    pass: j.score.pass,
    tailMotion: j.score.metrics?.tailMotion,
    poseSsim: j.score.metrics?.poseJumpSsim,
    score: j.score.score,
    clip: j.joinOut,
  })), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
