#!/usr/bin/env node
'use strict';
/** Extract per-segment pause/hold recipe for scene-reset joins (gold path replication). */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { detectHeyGenPauseWindow } = require('../lib/studio_laughter');
const { probeDurationSec } = require('../lib/clip_comp_tts');
const { tailMotionSamples } = require('../lib/soup_segment_prep');
const { ffmpegPath } = require('../lib/ffmpeg_utils');

const ROOT = path.join(__dirname, '..');
const TEST = path.join(ROOT, 'output', 'scene_reset_hold_test_2026-06-29T21-16-16');
const jobs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'))['script_twitch_1782513992551'];
const map = jobs.heygen.sceneTextMap;

const FILES = {
  LACY_INTRO: path.join(TEST, 'segments/LACY_INTRO.mp4'),
  LACY_CLIP1_SETUP: path.join(TEST, 'segments/LACY_CLIP1_SETUP.mp4'),
  LACY_CLIP2_SETUP: path.join(TEST, 'segments/LACY_CLIP2_SETUP.mp4'),
  LACY_CLIP1_REACTION: path.join(ROOT, 'tmp/asm_script_twitch_1782513992551_r43_4_lacy_clip1_reaction_legacy_chrome_with_crowd.mp4'),
  LACY_CLIP2_REACTION: path.join(ROOT, 'tmp/asm_script_twitch_1782513992551_r43_7_lacy_clip2_reaction_legacy_chrome_with_crowd.mp4'),
  JASON_INTRO: path.join(ROOT, 'tmp/asm_script_twitch_1782513992551_r43_8_jason_intro_legacy_chrome.mp4'),
};

function pngAt(mp4, t, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(ffmpegPath(), [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, t)),
    '-i', path.resolve(mp4),
    '-frames:v', '1', '-update', '1',
    path.resolve(out),
  ]);
  if (!fs.existsSync(out)) throw new Error(`png failed ${out} @ ${t}s`);
}

function luma(png) {
  return Number(execFileSync('python3', [
    '-c', 'from PIL import Image;import sys;im=Image.open(sys.argv[1]).convert("L");d=list(im.get_flattened_data());print(sum(d)//len(d))',
    png,
  ]).toString().trim());
}

function ssim(p1, p2) {
  const err = execFileSync(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'info', '-i', p1, '-i', p2, '-lavfi', 'ssim', '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const m = String(err).match(/All:([\d.]+)/);
  return m ? Number(m[1]) : null;
}

async function analyzeSeg(name) {
  const file = FILES[name];
  const dur = await probeDurationSec(file);
  const pause = await detectHeyGenPauseWindow(file, { targetPauseSec: 4 });
  const tail = await tailMotionSamples(file, dur, 0.5);
  const avgTail = tail.length ? tail.reduce((s, x) => s + x.diff, 0) / tail.length : 0;
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'jr_'));
  const safeLast = Math.max(0.04, dur - 0.08);
  pngAt(file, safeLast, path.join(td, 'last.png'));
  pngAt(file, 0.04, path.join(td, 'first.png'));
  let postHoldLuma = null;
  if (pause && pause.start < 0.5) {
    pngAt(file, pause.end + 0.04, path.join(td, 'posthold.png'));
    postHoldLuma = luma(path.join(td, 'posthold.png'));
  }
  const entry = map[name] || {};
  return {
    name,
    file: path.basename(file),
    dur: Math.round(dur * 1000) / 1000,
    gate1: entry.text || null,
    pause: pause ? {
      start: Math.round(pause.start * 100) / 100,
      end: Math.round(pause.end * 100) / 100,
      dur: Math.round(pause.duration * 100) / 100,
      hasSpeechAfter: pause.hasSpeechAfter,
    } : null,
    tailMotion: Math.round(avgTail * 100) / 100,
    lumaFirst: luma(path.join(td, 'first.png')),
    lumaLast: luma(path.join(td, 'last.png')),
    lumaPostHold: postHoldLuma,
    startsWithHold: !!(pause && pause.start < 0.3),
    endsWithHold: !!(pause && pause.end > dur - 0.5 && !pause.hasSpeechAfter),
    sceneType: /_REACTION$/i.test(name) ? 'reaction'
      : /_INTRO$/i.test(name) ? 'intro'
      : /_SETUP$/i.test(name) ? 'setup'
      : 'other',
  };
}

async function main() {
  const pairs = [
    { k: '009', from: 'LACY_INTRO', to: 'LACY_CLIP1_SETUP' },
    { k: '055', from: 'LACY_CLIP1_REACTION', to: 'LACY_CLIP2_SETUP' },
    { k: '150', from: 'LACY_CLIP2_REACTION', to: 'JASON_INTRO' },
  ];
  const out = { extractedAt: new Date().toISOString(), pairs: [], segments: {}, goldRecipe: null };

  for (const p of pairs) {
    const left = await analyzeSeg(p.from);
    const right = await analyzeSeg(p.to);
    out.segments[p.from] = left;
    out.segments[p.to] = right;

    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'jx_'));
    const lf = FILES[p.from];
    const rf = FILES[p.to];
    pngAt(lf, Math.max(0.04, left.dur - 0.08), path.join(td, 'L.png'));
    pngAt(rf, 0.04, path.join(td, 'R0.png'));
    let ssimAfterHold = null;
    if (right.startsWithHold && right.pause) {
      pngAt(rf, right.pause.end + 0.04, path.join(td, 'R1.png'));
      ssimAfterHold = ssim(path.join(td, 'L.png'), path.join(td, 'R1.png'));
    }

    const strategy = left.endsWithHold && right.startsWithHold ? 'double_hold'
      : left.endsWithHold && !right.startsWithHold ? 'hold_exit_speech_enter'
      : !left.endsWithHold && right.startsWithHold ? 'speech_exit_hold_enter'
      : 'speech_both';

    out.pairs.push({
      key: p.k,
      from: p.from,
      to: p.to,
      strategy,
      ssim_tail_vs_incoming_first_frame: ssim(path.join(td, 'L.png'), path.join(td, 'R0.png')),
      ssim_tail_vs_after_incoming_hold: ssimAfterHold,
      left,
      right,
    });
  }

  out.goldRecipe = {
    outgoing: {
      sceneType: 'reaction',
      scriptPattern: 'one line → [studio laugh] → (optional follow on last clip)',
      heygenPattern: 'line + <break time="4s"/> (+ follow line if last reaction)',
      crowdBed: true,
      rawPauseClip1: { start: 0.85, end: 5.25, dur: 4.4 },
      rawPauseClip2: { start: 2.4, end: 6.59, dur: 4.19, hasSpeechAfter: true },
      note: 'Crowd mix hides silence-detect on stitched files — pause exists on raw HeyGen render',
    },
    incoming: {
      sceneType: 'intro (next streamer) — NOT setup',
      scriptPattern: '2-3 intro sentences — NO leading [scene hold]',
      heygenPattern: 'speech from frame 1',
      startsWithHold: false,
    },
    join: {
      strategy: 'hold_exit_speech_enter',
      replicate: {
        introToSetup: 'intro END hold only — setup speaks immediately (no double hold)',
        reactionToSetup: 'reaction END hold + crowd — setup speaks immediately (same as intro enter)',
        reactionToIntro: 'reaction hold/crowd → next streamer intro speech (150 gold)',
      },
      avoid: [
        'double_hold (intro end + setup start) — awkward ~8s silence at 009',
        'setup leading [scene hold] — loses set/context at 055',
      ],
    },
  };

  const outPath = path.join(TEST, 'join_recipe_extract.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('Wrote', outPath);
  console.log('\nGOLD RECIPE (150):');
  console.log(JSON.stringify(out.goldRecipe, null, 2));
  console.log('\nSTRATEGY COMPARE:');
  for (const p of out.pairs) {
    console.log(`${p.key}: ${p.strategy} | SSIM cut=${p.ssim_tail_vs_incoming_first_frame}${p.ssim_tail_vs_after_incoming_hold != null ? ` afterHold=${p.ssim_tail_vs_after_incoming_hold}` : ''}`);
    console.log(`  L ${p.left.sceneType} endHold=${p.left.endsWithHold} pause=${JSON.stringify(p.left.pause)} tail=${p.left.tailMotion}`);
    console.log(`  R ${p.right.sceneType} startHold=${p.right.startsWithHold} pause=${JSON.stringify(p.right.pause)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
