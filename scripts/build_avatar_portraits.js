#!/usr/bin/env node
'use strict';
/**
 * Build head-only portrait crops for EchoMimic (no hands in frame).
 * Sources: heygen_frame still + first frame from heygen baseline mp4.
 *
 * Output: spike/cpd881/inputs/bobbyg_{head_only,tight_head,baseline_frame}.png
 * Uploads to R2 under spike/cpd881/inputs/
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { uploadToR2 } = require('../lib/storage');

const INPUTS = path.join(__dirname, '..', 'spike', 'cpd881', 'inputs');
const HEYGEN_FRAME = path.join(INPUTS, 'bobbyg_heygen_frame.png');
const BASELINE_MP4 = path.join(__dirname, '..', 'output', 'avatar_clone_gate', 'heygen_baseline.mp4');
const BASELINE_FRAME = path.join(INPUTS, 'bobbyg_baseline_frame.png');

const CROPS = [
  {
    file: 'bobbyg_head_only.png',
    key: 'spike/cpd881/inputs/bobbyg_head_only.png',
    // shoulders up, hands below crop line
    vf: 'crop=920:920:(iw-920)/2:60,scale=768:768:flags=lanczos'
  },
  {
    file: 'bobbyg_tight_head.png',
    key: 'spike/cpd881/inputs/bobbyg_tight_head.png',
    vf: 'crop=760:760:(iw-760)/2:100,scale=768:768:flags=lanczos'
  },
  {
    file: 'bobbyg_baseline_head.png',
    key: 'spike/cpd881/inputs/bobbyg_baseline_head.png',
    source: 'baseline',
    vf: 'crop=920:920:(iw-920)/2:60,scale=768:768:flags=lanczos'
  }
];

function runFfmpeg(args) {
  execFileSync('ffmpeg', ['-y', ...args], { stdio: 'pipe' });
}

function log(msg) {
  console.log(`[portraits] ${msg}`);
}

async function main() {
  if (!fs.existsSync(HEYGEN_FRAME)) {
    throw new Error(`missing ${HEYGEN_FRAME}`);
  }

  if (fs.existsSync(BASELINE_MP4) && !fs.existsSync(BASELINE_FRAME)) {
    runFfmpeg(['-i', BASELINE_MP4, '-frames:v', '1', '-q:v', '2', BASELINE_FRAME]);
    log(`extracted baseline frame → ${BASELINE_FRAME}`);
  }

  for (const crop of CROPS) {
    const src = crop.source === 'baseline'
      ? (fs.existsSync(BASELINE_FRAME) ? BASELINE_FRAME : HEYGEN_FRAME)
      : HEYGEN_FRAME;
    const dest = path.join(INPUTS, crop.file);
    runFfmpeg(['-i', src, '-vf', crop.vf, dest]);
    log(`built ${crop.file} from ${path.basename(src)}`);
    await uploadToR2(dest, crop.file, { key: crop.key, contentType: 'image/png' });
    log(`uploaded ${crop.key}`);
  }

  // Re-upload existing portraits used in sweeps
  for (const [file, key] of [
    ['bobbyg_heygen_frame.png', 'spike/cpd881/inputs/bobbyg_heygen_frame.png'],
    ['bobbyg_mouth_focus.png', 'spike/cpd881/inputs/bobbyg_mouth_focus.png'],
    ['bobbyg_headshot.png', 'spike/cpd881/inputs/bobbyg_headshot.png']
  ]) {
    const local = path.join(INPUTS, file);
    if (!fs.existsSync(local)) continue;
    await uploadToR2(local, file, { key, contentType: 'image/png' });
    log(`uploaded ${key}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
